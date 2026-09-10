import "server-only";

import { fetchHtml, FetchError } from "@/lib/http";
import { extractArticle, needsJsRendering } from "@/lib/extract";
import { scrapeWithFirecrawl, firecrawlEnabled, FirecrawlUnavailable } from "@/lib/firecrawl";
import type { StepContext, StepOutcome } from "../runner";

/**
 * Step 3 of the spec: fetch the article.
 *
 * Plain server-side fetch first. A headless browser is only worth its cost when
 * the served HTML genuinely has no article in it, so Firecrawl is reached for
 * only after the cheap path has been tried and measured.
 */
export async function fetchArticleStep({ db, job }: StepContext): Promise<StepOutcome> {
  let html: string;
  let renderMode: "fetch" | "firecrawl" = "fetch";
  let finalUrl = job.source_url;
  let statusCode: number | null = null;

  try {
    const result = await fetchHtml(job.source_url, { timeoutMs: 15_000 });
    html = result.html;
    finalUrl = result.finalUrl;
    statusCode = result.status;
  } catch (error) {
    if (error instanceof FetchError && error.kind === "blocked") {
      return { kind: "fail", error: error.message };
    }

    // A page that does not exist will not exist for a headless browser either.
    // Retrying it through Firecrawl wastes a call, and recommending the key
    // sends the user to fix the wrong problem.
    const status = error instanceof FetchError ? error.statusCode : undefined;
    if (status === 404 || status === 410) {
      return {
        kind: "fail",
        error:
          `The article URL returned HTTP ${status}. Check the address — this page ` +
          `does not exist at that location.`,
      };
    }

    // The rest — 403, 429, 5xx, connection resets — are the bot walls and hard
    // JS gates Firecrawl exists for.
    if (!firecrawlEnabled()) {
      return {
        kind: "fail",
        error:
          `${(error as Error).message}. This site refused a direct request; set ` +
          `FIRECRAWL_API_KEY to audit pages that block plain HTTP fetches.`,
      };
    }
    const page = await scrapeWithFirecrawl(job.source_url).catch((e: unknown) => {
      throw new Error(
        `Could not read the article. Direct fetch failed (${(error as Error).message}) ` +
          `and the rendering fallback also failed (${(e as Error).message}).`,
      );
    });
    html = page.html;
    renderMode = "firecrawl";
    finalUrl = page.sourceUrl;
  }

  // Cheap probe: did we actually get an article, or an empty SPA shell?
  if (renderMode === "fetch") {
    const probe = extractArticle(html, finalUrl);
    if (needsJsRendering(html, probe)) {
      if (firecrawlEnabled()) {
        try {
          const page = await scrapeWithFirecrawl(finalUrl);
          if (page.html) {
            html = page.html;
            renderMode = "firecrawl";
            finalUrl = page.sourceUrl;
          }
        } catch (error) {
          if (!(error instanceof FirecrawlUnavailable)) throw error;
          return {
            kind: "fail",
            error: `This page requires JavaScript rendering and it could not be rendered: ${error.message}`,
          };
        }
      } else {
        return {
          kind: "fail",
          error:
            "This page renders its content with JavaScript and returned an almost empty " +
            "document. Set FIRECRAWL_API_KEY to audit pages like this.",
        };
      }
    }
  }

  if (!html.trim()) {
    return { kind: "fail", error: "The article URL returned an empty document." };
  }

  const { error } = await db.from("articles").upsert(
    {
      job_id: job.id,
      kind: "original",
      url: finalUrl,
      html,
      meta: { renderMode, statusCode, requestedUrl: job.source_url },
    },
    { onConflict: "job_id,kind" },
  );

  if (error) return { kind: "fail", error: `Could not save the article: ${error.message}` };

  return {
    kind: "advance",
    state: { renderMode },
    message: "Checking article...",
  };
}
