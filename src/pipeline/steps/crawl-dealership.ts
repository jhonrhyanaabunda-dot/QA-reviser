import "server-only";

import { fetchHtml, FetchError } from "@/lib/http";
import { extractPageFacts } from "@/lib/extract";
import { crawlPriority, isCrawlableUrl, matchesAnyDomain, normalizeUrl } from "@/lib/url";
import type { StepContext, StepOutcome } from "../runner";

/**
 * Step 5: crawl the dealership's own approved pages.
 *
 * Bounded on three axes so it can never run away inside a serverless function:
 * only approved domains are visited, only PAGES_PER_INVOCATION are fetched per
 * call, and a hard page budget caps the whole job. The step re-enters itself
 * until the frontier is empty, which is what keeps any single request short.
 */
const PAGES_PER_INVOCATION = 6;
const DEFAULT_PAGE_BUDGET = 25;
const HARD_PAGE_BUDGET = 60;

export async function crawlDealershipStep({
  db,
  job,
  state,
  warn,
}: StepContext): Promise<StepOutcome> {
  if (!job.dealership_id) {
    return {
      kind: "advance",
      message: "Checking links...",
      state: { crawlQueue: [], crawlSeen: [], crawlCount: 0 },
    };
  }

  const { data: domainRows, error: domainError } = await db
    .from("dealership_domains")
    .select("domain, max_pages, is_approved")
    .eq("dealership_id", job.dealership_id)
    .eq("is_approved", true);

  if (domainError) {
    return { kind: "fail", error: `Could not load dealership domains: ${domainError.message}` };
  }

  const domains = (domainRows ?? []).map((d) => d.domain);
  if (domains.length === 0) {
    warn("This dealership has no approved domains, so no dealership pages were crawled.");
    return { kind: "advance", message: "Checking links...", state: { crawlCount: 0 } };
  }

  const budget = Math.min(
    HARD_PAGE_BUDGET,
    job.options.maxCrawlPages ??
      Math.max(...(domainRows ?? []).map((d) => d.max_pages ?? DEFAULT_PAGE_BUDGET)),
  );

  let queue = state.crawlQueue ?? [];
  const seen = new Set(state.crawlSeen ?? []);
  let crawled = state.crawlCount ?? 0;

  // First entry into this step: seed the frontier from the domain roots.
  if (!state.crawlQueue) {
    queue = domains
      .map((domain) => normalizeUrl(`https://${domain.replace(/^https?:\/\//, "")}`))
      .filter((u): u is string => Boolean(u));
  }

  if (queue.length === 0 || crawled >= budget) {
    return {
      kind: "advance",
      message: "Checking links...",
      state: { crawlQueue: [], crawlSeen: [...seen], crawlCount: crawled },
    };
  }

  queue.sort((a, b) => crawlPriority(a) - crawlPriority(b));
  const batch = queue.splice(0, PAGES_PER_INVOCATION);

  const discovered: string[] = [];

  for (const url of batch) {
    if (crawled >= budget) break;
    if (seen.has(url)) continue;
    seen.add(url);

    try {
      const result = await fetchHtml(url, { timeoutMs: 10_000 });
      const facts = extractPageFacts(result.html, result.finalUrl);
      crawled += 1;

      const { error } = await db.from("crawled_pages").upsert(
        {
          job_id: job.id,
          dealership_id: job.dealership_id,
          url,
          title: facts.title,
          text: facts.text,
          summary: facts.text.slice(0, 400),
          status_code: result.status,
          render_mode: "fetch",
          links: facts.links.slice(0, 100),
        },
        { onConflict: "job_id,url" },
      );
      if (error) warn(`Could not store crawled page ${url}: ${error.message}`);

      // Expand the frontier, but only within the approved domains.
      for (const link of facts.links) {
        const normalized = normalizeUrl(link.url, result.finalUrl);
        if (!normalized) continue;
        if (seen.has(normalized) || discovered.includes(normalized)) continue;
        if (!isCrawlableUrl(normalized)) continue;
        if (!matchesAnyDomain(normalized, domains)) continue;
        discovered.push(normalized);
      }
    } catch (error) {
      const message =
        error instanceof FetchError ? error.message : (error as Error).message;
      warn(`Skipped ${url}: ${message}`);
    }
  }

  const nextQueue = [...queue, ...discovered]
    .filter((url) => !seen.has(url))
    .sort((a, b) => crawlPriority(a) - crawlPriority(b))
    .slice(0, 120);

  const finished = nextQueue.length === 0 || crawled >= budget;

  return {
    kind: finished ? "advance" : "repeat",
    message: finished
      ? "Checking links..."
      : `Checking dealership pages... (${crawled}/${budget})`,
    state: {
      crawlQueue: finished ? [] : nextQueue,
      crawlSeen: [...seen].slice(-300),
      crawlCount: crawled,
    },
  };
}
