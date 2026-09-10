import "server-only";

import { checkLink } from "@/lib/http";
import { hostMatchesDomain, matchesAnyDomain, registrableHost } from "@/lib/url";
import type { DetectedIssue, LinkRef } from "@/lib/types";
import type { StepContext, StepOutcome } from "../runner";
import { loadRules, toIssueRow } from "../rules";

/**
 * Step 6: analyze every link in the article.
 *
 * Two questions per link — is it alive, and does it point somewhere the
 * dealership wants traffic to go. Liveness checks are network-bound, so they
 * run in bounded concurrent batches and the step re-enters itself until the
 * queue drains. The findings are only written once the queue is empty, so a
 * retried chunk can't produce duplicate issues.
 */
const LINKS_PER_INVOCATION = 12;
const CONCURRENCY = 6;

/** Domains that are dealership-adjacent but not competitors. */
const OEM_DOMAINS = [
  "toyota.com", "honda.com", "ford.com", "chevrolet.com", "gmc.com", "nissanusa.com",
  "hyundaiusa.com", "kia.com", "subaru.com", "mazdausa.com", "jeep.com", "ram.com",
  "dodge.com", "chrysler.com", "vw.com", "bmwusa.com", "mbusa.com", "audiusa.com",
  "lexus.com", "acura.com", "infinitiusa.com", "buick.com", "cadillac.com",
  "volvocars.com", "mitsubishicars.com", "genesis.com", "landroverusa.com",
  "nhtsa.gov", "fueleconomy.gov", "iihs.org", "epa.gov", "kbb.com", "edmunds.com",
];

/** Third-party marketplaces and dealer groups that compete for the same click. */
const COMPETITOR_PATTERNS = [
  /(?:^|\.)carvana\.com$/i,
  /(?:^|\.)carmax\.com$/i,
  /(?:^|\.)vroom\.com$/i,
  /(?:^|\.)shift\.com$/i,
  /(?:^|\.)truecar\.com$/i,
  /(?:^|\.)cargurus\.com$/i,
  /(?:^|\.)autotrader\.com$/i,
  /(?:^|\.)cars\.com$/i,
  /(?:^|\.)carfax\.com$/i,
  /(?:^|\.)autonation\.com$/i,
  /(?:^|\.)lithia\.com$/i,
  /(?:^|\.)sonicautomotive\.com$/i,
  /(?:^|\.)penskeautomotive\.com$/i,
  /(?:^|\.)hendrickcars\.com$/i,
];

const GENERIC_ANCHORS = /^(?:click here|read more|learn more(?: here)?|here|this page|more|link|this)$/i;

export async function analyzeLinksStep({
  db,
  job,
  state,
  warn,
}: StepContext): Promise<StepOutcome> {
  const queue = state.linkQueue ?? [];

  const domains = await approvedDomains(db, job.dealership_id);
  const articleHost = registrableHost(job.source_url);

  if (queue.length > 0) {
    const batch = queue.slice(0, LINKS_PER_INVOCATION);
    const remaining = queue.slice(LINKS_PER_INVOCATION);

    const results = await mapWithConcurrency(batch, CONCURRENCY, async (link) => {
      const status = await checkLink(link.url, { timeoutMs: 8_000 });
      const isDealership = domains.length > 0 && matchesAnyDomain(link.url, domains);
      const sameHost = articleHost ? hostMatchesDomain(link.url, articleHost) : false;
      return {
        job_id: job.id,
        url: link.url,
        resolved_url: status.finalUrl,
        anchor_text: link.anchor || null,
        link_type: (isDealership || sameHost ? "internal" : "external") as "internal" | "external",
        is_dealership: isDealership,
        status_code: status.status,
        ok: status.ok,
        redirected: status.redirected,
        error: status.error,
      };
    });

    const { error } = await db.from("link_checks").upsert(results, { onConflict: "job_id,url" });
    if (error) warn(`Could not store some link checks: ${error.message}`);

    if (remaining.length > 0) {
      const done = (state.linkCount ?? queue.length) - remaining.length;
      return {
        kind: "repeat",
        message: `Checking links... (${done}/${state.linkCount ?? queue.length})`,
        state: { linkQueue: remaining },
      };
    }
  }

  // Queue drained — turn the stored checks into findings.
  const issues = await buildLinkIssues(db, job, domains);

  // This step owns exactly the link-kind rules. Clearing them first makes a
  // retry that already got as far as inserting produce one set of findings
  // rather than two.
  const owned = await linkRuleCodes(db, job);
  if (owned.length > 0) {
    await db
      .from("issues")
      .delete()
      .eq("job_id", job.id)
      .eq("phase", "initial")
      .in("rule_code", owned);
  }

  if (issues.length > 0) {
    const { error } = await db.from("issues").insert(
      issues.map((issue) => toIssueRow(issue, job.id, "initial")),
    );
    if (error) warn(`Could not store link issues: ${error.message}`);
  }

  return {
    kind: "advance",
    message: "Applying QA rules...",
    state: { linkQueue: [] },
  };
}

async function linkRuleCodes(
  db: StepContext["db"],
  job: StepContext["job"],
): Promise<string[]> {
  const rules = await loadRules(db, job.user_id, job.dealership_id);
  return rules.filter((rule) => rule.kind === "link").map((rule) => rule.code);
}

async function approvedDomains(
  db: StepContext["db"],
  dealershipId: string | null,
): Promise<string[]> {
  if (!dealershipId) return [];
  const { data } = await db
    .from("dealership_domains")
    .select("domain")
    .eq("dealership_id", dealershipId)
    .eq("is_approved", true);
  return (data ?? []).map((row) => row.domain);
}

async function buildLinkIssues(
  db: StepContext["db"],
  job: StepContext["job"],
  domains: string[],
): Promise<DetectedIssue[]> {
  const { data: checks } = await db
    .from("link_checks")
    .select("*")
    .eq("job_id", job.id);

  const rows = checks ?? [];
  const rules = await loadRules(db, job.user_id, job.dealership_id);
  const byCode = new Map(rules.map((r) => [r.code, r]));

  const issues: DetectedIssue[] = [];
  const emit = (
    code: string,
    title: string,
    detail: string,
    extra: Partial<DetectedIssue> = {},
  ) => {
    const rule = byCode.get(code);
    if (!rule) return;
    issues.push({
      rule_id: rule.id,
      rule_code: rule.code,
      category: rule.category,
      severity: rule.severity,
      title,
      detail,
      suggestion: rule.guidance ?? rule.description,
      auto_fixable: false,
      ...extra,
    });
  };

  let dealershipLinks = 0;

  for (const row of rows) {
    if (row.is_dealership) dealershipLinks += 1;

    if (!row.ok) {
      emit(
        "LINK_BROKEN",
        row.status_code
          ? `Link returns HTTP ${row.status_code}`
          : "Link could not be reached",
        row.error ?? `${row.url} did not return a successful response.`,
        {
          evidence: row.url,
          location: { url: row.url, status: row.status_code },
          severity: row.link_type === "internal" ? "critical" : "high",
        },
      );
      continue;
    }

    const host = registrableHost(row.url);
    if (host && !row.is_dealership && COMPETITOR_PATTERNS.some((re) => re.test(host))) {
      emit(
        "LINK_COMPETITOR",
        `Link points to ${host}`,
        "This sends a ready-to-buy shopper to a competing marketplace or dealer group.",
        { evidence: row.url, location: { url: row.url, host } },
      );
    }

    if (row.url.startsWith("http://")) {
      emit("LINK_HTTP_INSECURE", "Insecure http:// link", `${row.url} should use https.`, {
        evidence: row.url,
        location: { url: row.url },
        auto_fixable: true,
      });
    }

    if (row.redirected && row.resolved_url && row.resolved_url !== row.url) {
      emit(
        "LINK_REDIRECT_CHAIN",
        "Link redirects to a different URL",
        `${row.url} → ${row.resolved_url}. Point the link at the final destination.`,
        { evidence: `${row.url} → ${row.resolved_url}`, location: { url: row.url, to: row.resolved_url } },
      );
    }

    if (row.anchor_text && GENERIC_ANCHORS.test(row.anchor_text.trim())) {
      emit(
        "LINK_GENERIC_ANCHOR",
        `Generic anchor text: “${row.anchor_text}”`,
        "Descriptive anchor text helps both search engines and screen-reader users.",
        { evidence: `${row.anchor_text} → ${row.url}`, location: { url: row.url } },
      );
    }
  }

  if (domains.length > 0 && dealershipLinks === 0) {
    emit(
      "LINK_NO_INTERNAL",
      "Article does not link to the dealership site",
      rows.length === 0
        ? "The article contains no links at all."
        : `None of the ${rows.length} links point to ${domains.join(", ")}.`,
      { location: { totalLinks: rows.length } },
    );
  }

  // Useful signal, not a defect: note OEM/authority citations that are present.
  const oemCitations = rows.filter(
    (row) => registrableHost(row.url) && OEM_DOMAINS.some((d) => hostMatchesDomain(row.url, d)),
  );
  if (oemCitations.length === 0 && rows.length > 0) {
    emit(
      "LINK_NO_AUTHORITY_CITED",
      "No authoritative source is cited",
      "The article links out but never to a manufacturer, EPA/NHTSA, IIHS or an " +
        "established review source. Specification and safety claims read as unsourced.",
      { location: { externalLinks: rows.filter((r) => r.link_type === "external").length } },
    );
  }

  return issues;
}

/** Bounded-concurrency map — keeps link checks fast without opening 50 sockets. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}

export type { LinkRef };
