# QA Reviser

Audits automotive dealership articles for accuracy, link health, AI writing
patterns and QA-rule compliance — then applies the fixes that are safe to apply
automatically and hands the rest to a human.

Give it an article URL and a dealership. It extracts the article, crawls the
dealership's approved pages, checks every link, runs a rule library over the
copy, verifies factual claims against the dealership's own website, applies safe
fixes, re-audits the result, and saves a report.

Built to run entirely on Vercel. Nothing depends on a local machine, a local
browser process, or the filesystem.

---

## Table of contents

- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Deploy to Vercel](#deploy-to-vercel)
- [Environment variables](#environment-variables)
- [Database setup](#database-setup)
- [Local development](#local-development)
- [The QA rule library](#the-qa-rule-library)
- [Tests](#tests)
- [Operational notes](#operational-notes)
- [Project layout](#project-layout)

---

## How it works

An audit is a state machine in Postgres, not a long-running request. Submitting
an article creates a job row and returns immediately; the pipeline advances it
one step per serverless invocation, and the browser polls for status.

| # | Step | What it does |
|---|------|--------------|
| 1 | `fetch_article` | Fetches the URL server-side. Falls back to Firecrawl only if the page genuinely needs JavaScript rendering. |
| 2 | `extract_content` | Readability-style extraction: title, byline, body, headings, images, links. |
| 3 | `crawl_dealership` | Crawls the dealership's **approved domains only**, prioritizing contact/inventory/finance/service pages. Bounded per invocation and per job; re-enters itself until done. |
| 4 | `analyze_links` | Checks every link for liveness, redirects, insecure `http://`, competitor destinations, generic anchor text, and whether the article links back to the dealership at all. Also chunked. |
| 5 | `analyze_qa_rules` | Runs regex and structural rules locally; sends only judgment rules to the model, in one batched call. |
| 6 | `verify_facts` | Checks extracted claims (specs, prices, phone, address, hours) against the crawled dealership pages. |
| 7 | `apply_fixes` | Applies only mechanical, meaning-preserving substitutions. Everything else is recorded as a proposal. |
| 8 | `final_audit` | Re-runs the deterministic rules over the revised text to prove the fixes worked. |
| 9 | `save_report` | Assembles totals from stored rows and writes the report. |

The UI shows: **Audit started → Processing... → Checking article... → Checking
dealership pages... → Checking links... → Applying QA rules... → Final
verification... → Audit complete**

### Design decisions worth knowing

**Nothing is trusted without evidence.** A model finding whose quoted evidence
does not appear verbatim in the article is discarded before it can become an
issue — so a hallucinated quote can never reach the auto-fix step. Fact
verification can only mark a claim `supported` from a crawled page; anything the
crawl does not cover comes back `unverified`, never `supported`.

**"Safe" auto-fix is enforced in code, not decided by the model.** A fix applies
only when it is a mechanical substitution, its target text appears in the
article exactly once, and the rule is marked `safe`. Anything else is written to
`auto_fixes` with `applied: false` and a reason, so nothing is silently dropped.

**Only approved domains are crawled.** The crawler's frontier is filtered
against the dealership's `dealership_domains` allow-list on every expansion.

**Every submitted URL passes an SSRF guard.** Hostnames are resolved and
rejected if they land on loopback, private, link-local, carrier-grade NAT, or
cloud-metadata ranges — including IPv6 and IPv4-mapped IPv6 forms.

---

## Architecture

```
Browser ──POST /api/audits──▶ creates job row ──▶ triggers pipeline
   │                                                     │
   └──poll /api/audits/[id]/status                       ▼
                                          POST /api/jobs/advance  (x-internal-secret)
                                                         │
                                          acknowledges 202, then runs ONE step
                                          in after(), writes result, triggers next
                                                         │
                                                         ▼
                                          Vercel Cron  /api/cron/reap  (every 5 min)
                                          resumes jobs whose lease expired
```

The advance route acknowledges **before** doing its work. That keeps each
invocation's lifetime scoped to its own step instead of nesting inside the whole
downstream chain, which is what makes a long audit fit inside Vercel's per-request
limits.

Ownership is a **lease**, not a lock: a worker claims a job by stamping
`lease_expires_at` into the future. If a dispatch is dropped or an invocation is
killed, the lease lapses and the cron reaper picks the job up where it left off.

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router), TypeScript, React 19 |
| Database + Auth | Supabase (Postgres + Supabase Auth), row-level security on every table |
| AI | Anthropic Claude (`claude-opus-5` by default) |
| HTML parsing | `cheerio` — no headless browser |
| JS rendering fallback | Firecrawl HTTP API (optional) |
| Background work | Self-chaining route handlers + Vercel Cron recovery |
| Styling | Tailwind CSS v4 |

---

## Deploy to Vercel

### 1. Create the Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run these files in order:
   - `supabase/migrations/0001_init.sql`
   - `supabase/migrations/0002_rls.sql`
   - `supabase/migrations/0003_seed_rules.sql`
3. From **Settings → API**, copy the project URL, the `anon` key, and the
   `service_role` key.

### 2. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:<you>/qa-reviser.git
git push -u origin main
```

### 3. Import into Vercel

1. **Add New → Project**, import the repository. Vercel detects Next.js; the
   defaults are correct.
2. Add every variable from the table below under **Settings → Environment
   Variables**, for **Production**, **Preview** and **Development**.
3. Deploy.

### 4. Verify

- Visit the deployment, create an account, add a dealership with its domain.
- Submit an article URL and watch the progress steps advance.
- Check **Settings → Cron Jobs** shows `/api/cron/reap`.

---

## Environment variables

These are the exact variables to add in **Vercel → Settings → Environment
Variables**. `.env.example` has the same list with blank values.

### Required

| Variable | Where to get it | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API → Project URL | Sent to the browser. Safe. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API → `anon` `public` | Sent to the browser. Safe — RLS is what protects the data. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → `service_role` | **Server only. Bypasses RLS. Never prefix with `NEXT_PUBLIC_`.** |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com/settings/keys) | Server only. |
| `INTERNAL_JOB_SECRET` | `openssl rand -hex 32` | Authenticates the pipeline's calls to itself. |

### Recommended

| Variable | Purpose |
|---|---|
| `CRON_SECRET` | `openssl rand -hex 32`. Lets you trigger `/api/cron/reap` manually; Vercel's own cron requests are recognized without it. |
| `FIRECRAWL_API_KEY` | Enables auditing of JavaScript-rendered pages and sites that block plain HTTP fetches. Without it those articles fail with a clear message instead of being audited. |

### Optional

| Variable | Default | Purpose |
|---|---|---|
| `AI_MODEL` | `claude-opus-5` | Override the model. |
| `AI_EFFORT` | `medium` | `low` \| `medium` \| `high`. Higher is more thorough and slower. |
| `APP_URL` | derived from `VERCEL_URL` | Only set to override the origin the pipeline calls back on (e.g. a custom domain). |
| `DATABASE_URL` | — | Only needed if you run migrations with `psql` or the Supabase CLI instead of the SQL editor. |

> **Never commit real credentials.** `.env`, `.env.local` and `.env*.local` are
> gitignored. Only the two `NEXT_PUBLIC_*` values ever reach the browser.

---

## Database setup

Schema lives in `supabase/migrations/`, applied in filename order.

| File | Contents |
|---|---|
| `0001_init.sql` | Enums, all 13 tables, indexes, `updated_at` triggers, and the trigger that mirrors `auth.users` into `profiles`. |
| `0002_rls.sql` | Row-level security. Every table is owner-scoped; job-scoped child tables are reachable only through a job the caller owns. |
| `0003_seed_rules.sql` | The 34 built-in QA rules. Idempotent — safe to re-run to pick up rule changes. |

Tables: `profiles`, `dealerships`, `dealership_domains`, `qa_rules`,
`qa_feedback`, `audit_jobs`, `articles` (original **and** revised),
`crawled_pages`, `link_checks`, `fact_checks`, `issues`, `auto_fixes`,
`audit_results`.

With the Supabase CLI instead of the SQL editor:

```bash
supabase link --project-ref <ref>
supabase db push
```

---

## Local development

```bash
npm install
cp .env.example .env.local     # then fill in the values
npm run dev                    # http://localhost:3000
```

`APP_URL` defaults to `http://localhost:3000`, so the self-chaining pipeline
works locally without extra configuration. Point `NEXT_PUBLIC_SUPABASE_URL` at
either a hosted Supabase project or a local `supabase start` instance.

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Test suite |
| `npm run lint` | ESLint |

---

## The QA rule library

34 built-in rules across seven categories, each with a `kind` that decides how
it is evaluated:

| Kind | Evaluated by | Cost |
|---|---|---|
| `regex` | A pattern run locally over the article text | Free, exact |
| `structural` | Document-shape checks (headings, alt text, title length, paragraph rhythm) | Free, exact |
| `link` | The link-analysis step | Free, network-bound |
| `ai` | Batched into a single model call with the article as a cached prefix | Paid |

Categories: `ai-pattern` (LLM tells — em-dash spam, "not only… but also",
signature vocabulary, uniform paragraph rhythm), `compliance` (guarantee
language, price disclaimers, EPA qualifiers), `accuracy` (unsupported
superlatives, spec verification, NAP mismatches), `links`, `structure`, `seo`,
`style`, `brand`.

Users can add their own rules and switch built-ins off. Toggling a built-in
creates a user-owned override rather than mutating the shared row, so one
account's tuning never affects another's.

Each finding can be marked **Valid** or **Wrong** in the report. The rules page
surfaces the accept/reject ratio per rule and calls out any rule that is
misfiring more often than not — which is the signal for retiring or retuning it.

---

## Tests

```bash
npm test
```

63 tests covering the logic where a bug does real damage:

| File | Covers |
|---|---|
| `tests/url.test.ts` | URL normalization, domain matching (including lookalike domains like `dealer.com.evil.net`), crawl prioritization |
| `tests/extract.test.ts` | Article extraction, markdown conversion, and the JS-rendering heuristic — including that a server-rendered Next.js page is **not** sent to Firecrawl |
| `tests/rules.test.ts` | Regex and structural rules against real automotive copy, count thresholds, invalid-pattern tolerance, score monotonicity and clamping |
| `tests/security.test.ts` | The SSRF guard: loopback, RFC1918, cloud metadata, CGNAT, multicast, IPv6 unique/link-local, and IPv4-mapped IPv6 in both dotted and hex forms |
| `tests/fixes.test.ts` | Typographic quote conversion — in particular that markdown link targets, inline code and code fences are never touched, and that the conversion is idempotent |
| `tests/seed-rules.test.ts` | Every regex pattern in the SQL seed compiles, none matches the empty string, no rule claims an auto-fix the pipeline cannot apply, and every rule the pipeline names by code exists |

**What is not covered:** anything requiring live credentials — Supabase reads and
writes, real Anthropic calls, Firecrawl, and a full end-to-end audit. Those need
your keys; the checklist under [Operational notes](#operational-notes) is what to
walk through after the first deploy.

---

## Operational notes

### Vercel plan limits

- **Cron frequency.** `vercel.json` schedules the reaper every 5 minutes. The
  Hobby plan allows only one cron invocation per day — either upgrade to Pro or
  change the schedule to `0 0 * * *`. The reaper is a recovery path, not the
  primary one: the pipeline chains itself, so a less frequent reaper means a
  stalled job waits longer, not that audits stop working.
- **Function duration.** Routes declare `maxDuration = 60`. Every step is sized
  to finish well inside that; the crawl and link steps chunk their work
  specifically so they can. On Pro you can raise it, but you should not need to.

### After your first deploy, verify

- [ ] Sign-up and sign-in
- [ ] Adding a dealership and its approved domains
- [ ] URL submission and article extraction
- [ ] Dealership page crawling (check the crawled-page count in the report)
- [ ] Internal and external link detection, and a deliberately broken link
- [ ] QA rule processing, including one of your own rules
- [ ] AI writing-pattern detection on a known-AI-written article
- [ ] Fact verification against a dealership page you can check by hand
- [ ] Safe auto-fixes, and that risky ones land under "Needs a human"
- [ ] The final re-audit score
- [ ] Report generation and persistence across a page reload
- [ ] Error handling: submit a 404 URL and confirm the failure message is useful
- [ ] Timeout handling: confirm a stalled job is resumed by the reaper

### Cost

Token spend is proportional to the judgment work, not the audit. Deterministic
rules run locally and cost nothing. Each audit makes at most three model calls
(rules, facts, summary), and the article is sent as a cached prefix so the second
and third read it from cache rather than paying full input price. Set
`AI_EFFORT=low` to reduce spend further, or tick **Skip fact verification** on
an individual audit.

---

## Project layout

```
src/
├── app/
│   ├── api/
│   │   ├── audits/            submit, list, fetch report, poll status, feedback
│   │   ├── dealerships/       CRUD + approved-domain management
│   │   ├── rules/             rule library CRUD and tuning
│   │   ├── jobs/advance/      internal: run one pipeline step
│   │   └── cron/reap/         recovery sweep for stalled jobs
│   ├── audits/[id]/           progress + report
│   ├── dealerships/  rules/  login/
│   └── layout.tsx  page.tsx  globals.css
├── components/                audit form, progress, report, managers
├── lib/
│   ├── ai.ts                  structured output + prompt caching
│   ├── extract.ts             readability-style extraction
│   ├── http.ts                fetching, SSRF guard, link checks
│   ├── firecrawl.ts           JS-rendering fallback
│   ├── url.ts                 normalization, domain matching
│   ├── env.ts  types.ts
│   └── supabase/              browser, server, admin clients + types
├── pipeline/
│   ├── runner.ts              lease, step dispatch, self-chaining
│   ├── rules.ts               deterministic rule engine + scoring
│   └── steps/                 the nine pipeline steps
├── middleware.ts              session refresh + route protection
supabase/migrations/           schema, RLS, seed rules
tests/                         test suite
```
