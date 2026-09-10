/**
 * Local end-to-end exercise of the audit pipeline.
 *
 * Creates a user, a dealership and an audit job against the local Supabase
 * stack, kicks the pipeline through its real HTTP entry point, then reads back
 * what it stored. Not part of the deployed app — a harness for `npm run dev`.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const APP = process.env.APP_URL ?? "http://localhost:3000";
const SECRET = process.env.INTERNAL_JOB_SECRET!;

const ARTICLE_URL = process.argv[2] ?? "https://www.fueleconomy.gov/feg/bymodel/2024_Toyota_RAV4.shtml";
const DEALER_DOMAIN = process.argv[3] ?? "example.com";

const db = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const log = (...args: unknown[]) => console.log(...args);

async function main() {
  const email = `qa+${Date.now()}@example.com`;

  // --- user ---------------------------------------------------------------
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password: "test-password-123", email_confirm: true }),
  });
  const user = await res.json();
  if (!res.ok) throw new Error(`create user failed: ${JSON.stringify(user)}`);
  log(`user           ${email}`);

  // The handle_new_user trigger should have mirrored this into profiles.
  const { data: profile } = await db.from("profiles").select("id,email").eq("id", user.id).single();
  log(`profile row    ${profile ? "created by trigger ✓" : "MISSING ✗"}`);
  if (!profile) throw new Error("handle_new_user trigger did not fire");

  // --- dealership ---------------------------------------------------------
  const { data: dealership, error: dErr } = await db
    .from("dealerships")
    .insert({ user_id: user.id, name: "Test Motors", primary_domain: DEALER_DOMAIN })
    .select("*")
    .single();
  if (dErr) throw new Error(`dealership: ${dErr.message}`);

  await db.from("dealership_domains").insert({
    dealership_id: dealership.id,
    domain: DEALER_DOMAIN,
    label: "primary",
    max_pages: 5,
  });
  log(`dealership     Test Motors (${DEALER_DOMAIN}, max 5 pages)`);

  // --- job ----------------------------------------------------------------
  const { data: job, error: jErr } = await db
    .from("audit_jobs")
    .insert({
      user_id: user.id,
      dealership_id: dealership.id,
      source_url: ARTICLE_URL,
      options: { applyFixes: true, skipFactCheck: false, maxCrawlPages: 5 },
    })
    .select("*")
    .single();
  if (jErr) throw new Error(`job: ${jErr.message}`);
  log(`job            ${job.id}`);
  log(`article        ${ARTICLE_URL}\n`);

  // --- kick the pipeline through its real HTTP entry point ----------------
  const started = Date.now();
  const kick = await fetch(`${APP}/api/jobs/advance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-secret": SECRET },
    body: JSON.stringify({ jobId: job.id }),
  });
  log(`POST /api/jobs/advance -> ${kick.status} ${JSON.stringify(await kick.json())}\n`);

  // --- watch it advance ---------------------------------------------------
  let last = "";
  let settled: Database["public"]["Tables"]["audit_jobs"]["Row"] | null = null;

  for (let i = 0; i < 300; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const { data: current } = await db.from("audit_jobs").select("*").eq("id", job.id).single();
    if (!current) continue;

    const line = `${current.step.padEnd(18)} ${String(current.progress).padStart(3)}%  ${current.status_message}`;
    if (line !== last) {
      log(`  [${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${line}`);
      last = line;
    }

    if (["complete", "failed", "canceled"].includes(current.status)) {
      settled = current;
      break;
    }
  }

  if (!settled) throw new Error("job did not settle within 300s");
  log(`\nfinished       ${settled.status} in ${Math.round((Date.now() - started) / 1000)}s`);
  if (settled.error) log(`error          ${settled.error}`);

  await report(job.id);
}

async function report(jobId: string) {
  const [articles, issues, links, facts, fixes, result, pages] = await Promise.all([
    db.from("articles").select("kind,title,word_count,meta").eq("job_id", jobId),
    db.from("issues").select("*").eq("job_id", jobId),
    db.from("link_checks").select("*").eq("job_id", jobId),
    db.from("fact_checks").select("*").eq("job_id", jobId),
    db.from("auto_fixes").select("*").eq("job_id", jobId),
    db.from("audit_results").select("*").eq("job_id", jobId).maybeSingle(),
    db.from("crawled_pages").select("url,status_code").eq("job_id", jobId),
  ]);

  log("\n" + "=".repeat(70));
  log("PERSISTED RESULTS");
  log("=".repeat(70));

  for (const a of articles.data ?? []) {
    log(`article(${a.kind.padEnd(8)}) ${a.word_count} words  "${(a.title ?? "").slice(0, 48)}"`);
  }

  log(`crawled pages    ${(pages.data ?? []).length}`);
  (pages.data ?? []).forEach((p) => log(`                 ${p.status_code}  ${p.url}`));

  const linkRows = links.data ?? [];
  log(`links checked    ${linkRows.length} (${linkRows.filter((l) => !l.ok).length} broken, ` +
      `${linkRows.filter((l) => l.is_dealership).length} dealership)`);

  const initial = (issues.data ?? []).filter((i) => i.phase === "initial");
  const final = (issues.data ?? []).filter((i) => i.phase === "final");
  log(`issues           ${initial.length} initial / ${final.length} final`);

  const bySeverity: Record<string, number> = {};
  for (const i of initial) bySeverity[i.severity] = (bySeverity[i.severity] ?? 0) + 1;
  log(`                 ${JSON.stringify(bySeverity)}`);

  log(`\ntop findings:`);
  const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  initial
    .sort((a, b) => rank[a.severity] - rank[b.severity])
    .slice(0, 12)
    .forEach((i) =>
      log(`  [${i.severity.padEnd(8)}] ${(i.rule_code ?? "").padEnd(26)} ${i.title.slice(0, 60)}`),
    );

  log(`\nfact checks      ${(facts.data ?? []).length}`);
  (facts.data ?? []).slice(0, 5).forEach((f) =>
    log(`  ${f.verdict.padEnd(13)} ${f.claim.slice(0, 62)}`),
  );

  const fixRows = fixes.data ?? [];
  log(`\nauto-fixes       ${fixRows.filter((f) => f.applied).length} applied, ` +
      `${fixRows.filter((f) => !f.applied).length} left for a human`);
  fixRows.filter((f) => f.applied).slice(0, 5).forEach((f) =>
    log(`  applied  ${f.rule_code}: ${f.before_text.slice(0, 40)} -> ${f.after_text.slice(0, 30)}`),
  );

  log(`\nresult row       ${result.data ? "saved ✓" : "MISSING ✗"}`);
  if (result.data) {
    log(`score            ${result.data.score} before / ${result.data.final_score} after`);
    log(`summary          ${result.data.summary}`);
    const totals = result.data.totals as Record<string, unknown>;
    const warnings = (totals.warnings as string[]) ?? [];
    if (warnings.length) {
      log(`warnings         ${warnings.length}`);
      warnings.forEach((w) => log(`  - ${w}`));
    }
  }
}

main().catch((error) => {
  console.error("\nFAILED:", error.message);
  process.exit(1);
});
