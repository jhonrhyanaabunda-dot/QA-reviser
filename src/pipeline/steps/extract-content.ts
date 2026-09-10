import "server-only";

import { extractArticle } from "@/lib/extract";
import { normalizeUrl } from "@/lib/url";
import type { LinkRef } from "@/lib/types";
import type { StepContext, StepOutcome } from "../runner";

/**
 * Step 4: turn the stored HTML into structured content.
 *
 * Everything downstream reads from here rather than from raw HTML, so this is
 * the one place that has to get title, body, headings, images and links right.
 * The link list is queued into job state for the link-analysis step.
 */
export async function extractContentStep({ db, job, warn }: StepContext): Promise<StepOutcome> {
  const { data: article, error: readError } = await db
    .from("articles")
    .select("html, url, meta")
    .eq("job_id", job.id)
    .eq("kind", "original")
    .single();

  if (readError || !article?.html) {
    return { kind: "fail", error: "No fetched article found to extract from." };
  }

  const extracted = extractArticle(article.html, article.url ?? job.source_url);

  if (extracted.wordCount < 25) {
    return {
      kind: "fail",
      error:
        `Only ${extracted.wordCount} words of body text could be extracted. ` +
        `The URL may not point at an article.`,
    };
  }

  if (!extracted.title) warn("No title could be found for this article.");

  const { error: writeError } = await db
    .from("articles")
    .update({
      title: extracted.title,
      byline: extracted.byline,
      text: extracted.text,
      markdown: extracted.markdown,
      word_count: extracted.wordCount,
      meta: {
        ...(typeof article.meta === "object" && article.meta !== null ? article.meta : {}),
        metaDescription: extracted.metaDescription,
        headings: extracted.headings,
        images: extracted.images,
        linkCount: extracted.links.length,
      },
    })
    .eq("job_id", job.id)
    .eq("kind", "original");

  if (writeError) {
    return { kind: "fail", error: `Could not save extracted content: ${writeError.message}` };
  }

  const linkQueue: LinkRef[] = [];
  const seen = new Set<string>();
  for (const link of extracted.links) {
    const normalized = normalizeUrl(link.url);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    linkQueue.push({ url: normalized, anchor: link.anchor });
  }

  return {
    kind: "advance",
    state: { linkQueue, linkCount: linkQueue.length },
    message: "Checking dealership pages...",
  };
}
