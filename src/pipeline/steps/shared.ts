import "server-only";

import type { ExtractedArticle } from "@/lib/types";
import type { StepContext } from "../runner";

/**
 * Rehydrate the extracted article from the database.
 *
 * Steps run in separate invocations, so this is how each one gets the parsed
 * article without re-fetching or re-parsing the source page.
 */
export async function loadExtractedArticle(
  db: StepContext["db"],
  jobId: string,
  kind: "original" | "revised" = "original",
): Promise<ExtractedArticle | null> {
  const { data, error } = await db
    .from("articles")
    .select("url, title, byline, text, markdown, html, word_count, meta")
    .eq("job_id", jobId)
    .eq("kind", kind)
    .maybeSingle();

  if (error || !data || !data.text) return null;

  const meta = (typeof data.meta === "object" && data.meta !== null ? data.meta : {}) as Record<
    string,
    unknown
  >;

  return {
    url: data.url ?? "",
    title: data.title,
    byline: data.byline,
    metaDescription: (meta.metaDescription as string | undefined) ?? null,
    html: data.html ?? "",
    text: data.text,
    markdown: data.markdown ?? data.text,
    wordCount: data.word_count ?? 0,
    headings: (meta.headings as ExtractedArticle["headings"] | undefined) ?? [],
    images: (meta.images as ExtractedArticle["images"] | undefined) ?? [],
    links: [],
    renderMode: (meta.renderMode as "fetch" | "firecrawl" | undefined) ?? "fetch",
  };
}

const MAX_CONTEXT_CHARS = 40_000;

/**
 * The shared prompt prefix for every AI step in a job.
 *
 * Byte-identical across steps on purpose: it is marked as a cache breakpoint,
 * so the second and later AI calls in an audit read the article from cache
 * instead of paying full input price for it again.
 */
export function articleContext(article: ExtractedArticle): string {
  const body =
    article.text.length > MAX_CONTEXT_CHARS
      ? `${article.text.slice(0, MAX_CONTEXT_CHARS)}\n\n[article truncated at ${MAX_CONTEXT_CHARS} characters]`
      : article.text;

  return [
    "<article>",
    `<url>${article.url}</url>`,
    `<title>${article.title ?? "(none)"}</title>`,
    `<byline>${article.byline ?? "(none)"}</byline>`,
    `<meta_description>${article.metaDescription ?? "(none)"}</meta_description>`,
    `<word_count>${article.wordCount}</word_count>`,
    "<body>",
    body,
    "</body>",
    "</article>",
  ].join("\n");
}

/** Dealership pages, trimmed to fit a prompt without dominating it. */
export async function dealershipContext(
  db: StepContext["db"],
  jobId: string,
  maxChars = 30_000,
): Promise<string | null> {
  const { data } = await db
    .from("crawled_pages")
    .select("url, title, text")
    .eq("job_id", jobId)
    .order("fetched_at", { ascending: true })
    .limit(30);

  const pages = data ?? [];
  if (pages.length === 0) return null;

  const budget = Math.floor(maxChars / pages.length);
  const blocks = pages.map((page) =>
    [
      "<page>",
      `<url>${page.url}</url>`,
      `<title>${page.title ?? "(none)"}</title>`,
      (page.text ?? "").slice(0, budget),
      "</page>",
    ].join("\n"),
  );

  return `<dealership_pages>\n${blocks.join("\n")}\n</dealership_pages>`;
}
