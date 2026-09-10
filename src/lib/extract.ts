import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type { ExtractedArticle, LinkRef } from "./types";
import { normalizeUrl } from "./url";

/**
 * Readability-style article extraction over Cheerio.
 *
 * No headless browser: for the HTML that dealership CMSs and blog platforms
 * actually serve, scoring candidate containers by text density gets the article
 * body reliably and in single-digit milliseconds.
 */

const STRIP = [
  "script", "style", "noscript", "iframe", "svg", "form", "button",
  "nav", "header", "footer", "aside",
  "[role=navigation]", "[role=banner]", "[role=contentinfo]", "[aria-hidden=true]",
].join(",");

const NEGATIVE = /(?:comment|share|social|sidebar|footer|header|nav|menu|promo|banner|advert|subscribe|newsletter|related|breadcrumb|cookie|popup|modal|widget|disclaimer|copyright)/i;
const POSITIVE = /(?:article|post|content|entry|story|body|main|blog|text)/i;

/** Containers we try in order before falling back to scored scanning. */
const EXPLICIT_SELECTORS = [
  "article",
  "[itemprop=articleBody]",
  "main article",
  ".post-content",
  ".entry-content",
  ".article-content",
  ".article-body",
  ".post-body",
  "#content article",
  "main",
];

export function extractArticle(html: string, url: string): ExtractedArticle {
  const $ = cheerio.load(html);

  const title = pickTitle($);
  const byline = pickByline($);
  const metaDescription =
    attr($, 'meta[name="description"]', "content") ??
    attr($, 'meta[property="og:description"]', "content");

  // Work on a clone so metadata above is read from the untouched document.
  $(STRIP).remove();

  const container = pickContainer($);
  const scope = container ?? $("body");

  const headings: { level: number; text: string }[] = [];
  scope.find("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, " ");
    if (text) headings.push({ level: Number(el.tagName.slice(1)), text });
  });

  const images: { src: string; alt: string | null }[] = [];
  scope.find("img").each((_, el) => {
    const src = $(el).attr("src") ?? $(el).attr("data-src");
    if (!src) return;
    const resolved = normalizeUrl(src, url);
    if (!resolved) return;
    const alt = $(el).attr("alt");
    images.push({ src: resolved, alt: alt === undefined ? null : alt });
  });

  const links = collectLinks($, scope, url);
  const text = toText($, scope);
  const markdown = toMarkdown($, scope, url);

  return {
    url,
    title,
    byline,
    metaDescription,
    html: (container ? $.html(container) : $.html(scope)) ?? "",
    text,
    markdown,
    wordCount: countWords(text),
    headings,
    images,
    links,
    renderMode: "fetch",
  };
}

function attr($: cheerio.CheerioAPI, selector: string, name: string): string | null {
  const value = $(selector).first().attr(name);
  return value ? value.trim() : null;
}

function pickTitle($: cheerio.CheerioAPI): string | null {
  return (
    attr($, 'meta[property="og:title"]', "content") ??
    text($, "h1") ??
    text($, "title")
  );
}

function pickByline($: cheerio.CheerioAPI): string | null {
  return (
    attr($, 'meta[name="author"]', "content") ??
    attr($, 'meta[property="article:author"]', "content") ??
    text($, '[rel="author"]') ??
    text($, ".author, .byline, [itemprop=author]")
  );
}

function text($: cheerio.CheerioAPI, selector: string): string | null {
  const value = $(selector).first().text().trim().replace(/\s+/g, " ");
  return value || null;
}

/**
 * Pick the element most likely to be the article body: try known selectors,
 * then fall back to scoring every block-level candidate by paragraph text.
 */
function pickContainer($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode> | null {
  for (const selector of EXPLICIT_SELECTORS) {
    const candidate = $(selector).first();
    if (candidate.length && countWords(candidate.text()) >= 120) {
      return candidate as cheerio.Cheerio<AnyNode>;
    }
  }

  let bestEl: AnyNode | null = null;
  let bestScore = 0;

  $("div, section, main, article, td").each((_, el) => {
    const node = $(el);
    const paragraphs = node.children("p, h2, h3, ul, ol, blockquote");
    if (paragraphs.length < 2) return;

    const words = countWords(paragraphs.text());
    if (words < 100) return;

    let score = words + paragraphs.length * 12;

    const identity = `${node.attr("class") ?? ""} ${node.attr("id") ?? ""}`;
    if (POSITIVE.test(identity)) score *= 1.6;
    if (NEGATIVE.test(identity)) score *= 0.3;

    // Penalize link-heavy blocks — those are navigation, not prose.
    const linkWords = countWords(node.find("a").text());
    if (words > 0 && linkWords / words > 0.4) score *= 0.35;

    if (!bestEl || score > bestScore) {
      bestEl = el;
      bestScore = score;
    }
  });

  return bestEl ? ($(bestEl) as cheerio.Cheerio<AnyNode>) : null;
}

function collectLinks(
  $: cheerio.CheerioAPI,
  scope: cheerio.Cheerio<AnyNode>,
  base: string,
): LinkRef[] {
  const seen = new Map<string, LinkRef>();

  scope.find("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || /^(?:mailto|tel|javascript):/i.test(href)) return;
    const resolved = normalizeUrl(href, base);
    if (!resolved) return;
    const anchor = $(el).text().trim().replace(/\s+/g, " ");
    // First occurrence wins — its anchor text is the one worth reporting on.
    if (!seen.has(resolved)) seen.set(resolved, { url: resolved, anchor });
  });

  return [...seen.values()];
}

function toText($: cheerio.CheerioAPI, scope: cheerio.Cheerio<AnyNode>): string {
  const blocks: string[] = [];
  scope.find("h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, td").each((_, el) => {
    const value = $(el).text().trim().replace(/[ \t]+/g, " ");
    if (value) blocks.push(value);
  });
  if (blocks.length === 0) {
    return scope.text().trim().replace(/\n{3,}/g, "\n\n");
  }
  return blocks.join("\n\n");
}

/** Minimal HTML→Markdown, enough for the AI steps and the revised-article diff. */
function toMarkdown(
  $: cheerio.CheerioAPI,
  scope: cheerio.Cheerio<AnyNode>,
  base: string,
): string {
  const out: string[] = [];

  scope
    .find("h1, h2, h3, h4, h5, h6, p, ul, ol, blockquote, pre")
    .each((_, el) => {
      const node = $(el);
      const tag = el.tagName.toLowerCase();

      if (/^h[1-6]$/.test(tag)) {
        const value = node.text().trim().replace(/\s+/g, " ");
        if (value) out.push(`${"#".repeat(Number(tag[1]))} ${value}`);
        return;
      }

      if (tag === "ul" || tag === "ol") {
        const items: string[] = [];
        node.children("li").each((index, li) => {
          const value = inline($, $(li), base);
          if (value) items.push(tag === "ul" ? `- ${value}` : `${index + 1}. ${value}`);
        });
        if (items.length) out.push(items.join("\n"));
        return;
      }

      if (tag === "blockquote") {
        const value = node.text().trim().replace(/\s+/g, " ");
        if (value) out.push(`> ${value}`);
        return;
      }

      if (tag === "pre") {
        const value = node.text().replace(/\s+$/, "");
        if (value) out.push("```\n" + value + "\n```");
        return;
      }

      // Skip paragraphs nested inside a list item we already emitted.
      if (node.parents("li").length > 0) return;
      const value = inline($, node, base);
      if (value) out.push(value);
    });

  return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function inline(
  $: cheerio.CheerioAPI,
  node: cheerio.Cheerio<AnyNode>,
  base: string,
): string {
  const clone = node.clone();

  clone.find("a[href]").each((_, el) => {
    const anchor = $(el);
    const href = anchor.attr("href");
    const label = anchor.text().trim().replace(/\s+/g, " ");
    const resolved = href ? normalizeUrl(href, base) ?? href : null;
    anchor.replaceWith(resolved && label ? `[${label}](${resolved})` : label);
  });

  clone.find("strong, b").each((_, el) => {
    const value = $(el).text().trim();
    $(el).replaceWith(value ? `**${value}**` : "");
  });

  clone.find("em, i").each((_, el) => {
    const value = $(el).text().trim();
    $(el).replaceWith(value ? `*${value}*` : "");
  });

  clone.find("code").each((_, el) => {
    const value = $(el).text().trim();
    $(el).replaceWith(value ? "`" + value + "`" : "");
  });

  return clone.text().trim().replace(/[ \t]+/g, " ");
}

export function countWords(value: string): number {
  const matches = value.trim().match(/\b[\p{L}\p{N}'’-]+\b/gu);
  return matches ? matches.length : 0;
}

/**
 * Heuristic: does this page need a real browser?
 *
 * The question is whether the *server* sent prose, not whether our extractor
 * found it. A page that served plenty of text but confused the container
 * scorer is an extraction problem — re-rendering it in a browser would return
 * the same HTML and cost a Firecrawl call for nothing. Only a document that
 * genuinely arrives near-empty is worth rendering.
 *
 * Note the SPA-root check requires the mount point to be *empty*: a
 * server-rendered Next.js page also has `<div id="__next">`, and flagging
 * those would send most modern dealership blogs down the expensive path.
 */
export function needsJsRendering(html: string, extracted: ExtractedArticle): boolean {
  if (extracted.wordCount >= 200) return false;

  const $ = cheerio.load(html);
  const scriptBytes = $("script").text().length;
  const bodyText = $("body").clone().find("script,style,noscript").remove().end().text().trim();

  // The server sent real prose. Whatever went wrong, a browser won't fix it.
  if (bodyText.length >= 500) return false;

  // An empty SPA mount point with the content still to be fetched client-side.
  const emptyMount = /<div[^>]+id=["'](?:root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(html);
  if (emptyMount) return true;

  // Lots of JavaScript, almost no text: the content is behind the script.
  if (scriptBytes > 2000 && bodyText.length < 500) return true;

  // Practically nothing was served at all.
  return bodyText.length < 200;
}

/** Extract a lightweight summary of a crawled dealership page for AI context. */
export function extractPageFacts(html: string, url: string): {
  title: string | null;
  text: string;
  links: LinkRef[];
} {
  const $ = cheerio.load(html);
  const title = pickTitle($);
  $(STRIP).remove();
  const body = $("body");
  return {
    title,
    text: toText($, body as cheerio.Cheerio<AnyNode>).slice(0, 12_000),
    links: collectLinks($, body as cheerio.Cheerio<AnyNode>, url),
  };
}
