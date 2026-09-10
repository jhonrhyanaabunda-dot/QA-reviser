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

/** Never content, under any circumstances. */
const STRIP_ALWAYS = [
  "script", "style", "noscript", "iframe", "svg", "form", "button",
  "[aria-hidden=true]",
].join(",");

/**
 * Page chrome — removed *unless* it contains the H1.
 *
 * A hero section is marked up as <header> as often as a masthead is, and it
 * holds the H1 and the lede. Blanket-removing every <header> deleted the title
 * of a real dealership page and then reported it as having no H1 — a defect
 * invented by the extractor.
 */
const STRIP_CHROME = [
  "nav", "header", "footer", "aside",
  "[role=navigation]", "[role=banner]", "[role=contentinfo]",
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
  stripChrome($);
  normalizeLineBreaks($);

  const scope = pickScope($);

  const headings: { level: number; text: string }[] = [];
  scope.find("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, " ");
    if (text) headings.push({ level: Number(el.tagName.slice(1)), text });
  });

  /**
   * "Does this page have exactly one H1" is a question about the document, not
   * about whichever sub-tree holds the prose. Pages routinely put the H1 in a
   * hero above the <article>; scoping the check to the container reported those
   * as having no H1 at all.
   */
  if (!headings.some((heading) => heading.level === 1)) {
    $("h1").each((_, el) => {
      const text = $(el).text().trim().replace(/\s+/g, " ");
      if (text) headings.unshift({ level: 1, text });
    });
  }

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
  const markdown = toMarkdown($, scope, url);

  /**
   * The plain text is derived from the markdown, not extracted separately.
   *
   * The markdown is the deliverable a user copies out, so evaluating rules
   * against a rendering of it means the audit measures what actually gets
   * published. It also makes the original and the revised article comparable:
   * both reach the rule engine through the same function, so a fix cannot
   * change the text's structure without changing the markdown's too.
   */
  const text = markdownToPlainText(markdown) || toText($, scope);

  return {
    url,
    title,
    byline,
    metaDescription,
    html: $.html(scope) ?? "",
    text,
    markdown,
    wordCount: countWords(text),
    headings,
    images,
    links,
    renderMode: "fetch",
  };
}

function stripChrome($: cheerio.CheerioAPI): void {
  $(STRIP_ALWAYS).remove();
  $(STRIP_CHROME).each((_, el) => {
    const node = $(el);
    if (node.find("h1").length > 0) {
      // Keep the section, drop the navigation inside it.
      node.find("nav, [role=navigation]").remove();
      return;
    }
    node.remove();
  });
}

/**
 * Give every <br> a space.
 *
 * Cheerio's .text() concatenates around a <br> with nothing between, so
 * "Towing<br>capacity" reads as "Towingcapacity" and "123 Main St<br>Springfield"
 * becomes one run-together token. Dealership pages use <br> constantly for
 * addresses and spec lists — exactly the content the fact checker compares —
 * so this has to happen before any text is read.
 */
function normalizeLineBreaks($: cheerio.CheerioAPI): void {
  $("br").replaceWith(" ");
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
 * Choose the region to audit.
 *
 * A single best-scoring container is right for a conventional article, but a
 * lot of dealership pillar pages are a stack of sibling <section> bands with no
 * wrapper around them. On one real page that shape made the best container hold
 * 2,856 of the document's 8,656 words — two thirds of the content never
 * reached the rule engine, and every finding in it was silently missed.
 *
 * So: take the best container only when it actually accounts for most of the
 * page. Otherwise audit the whole cleaned body, which is safe because the
 * navigation, footers and asides are already gone.
 */
const MIN_CONTAINER_COVERAGE = 0.6;

function pickScope($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode> {
  const body = $("body") as cheerio.Cheerio<AnyNode>;
  const bodyWords = countWords(body.text());
  const container = pickContainer($);

  if (!container) return body;
  if (bodyWords === 0) return container;

  const coverage = countWords(container.text()) / bodyWords;
  if (coverage >= MIN_CONTAINER_COVERAGE) {
    /**
     * If the H1 sits outside the container — a page-level hero above the
     * <article> — widen to the ancestor holding both. The lede under an H1 is
     * the most-read text on the page and the natural home of exactly the
     * opener clichés AI_HEDGE_OPENER looks for, so auditing the body while
     * skipping the opening paragraph misses findings by construction.
     */
    const h1 = $("h1").first();
    if (h1.length && container.find("h1").length === 0) {
      return commonAncestor($, container, h1 as cheerio.Cheerio<AnyNode>) ?? body;
    }
    return container;
  }

  // The content is spread across siblings. Prefer <main> if it covers the page,
  // otherwise the body itself.
  const main = $("main").first() as cheerio.Cheerio<AnyNode>;
  if (main.length && countWords(main.text()) / bodyWords >= MIN_CONTAINER_COVERAGE) {
    return main;
  }
  return body;
}

/** Nearest element containing both nodes, or null. */
function commonAncestor(
  $: cheerio.CheerioAPI,
  a: cheerio.Cheerio<AnyNode>,
  b: cheerio.Cheerio<AnyNode>,
): cheerio.Cheerio<AnyNode> | null {
  const ancestors = new Set<AnyNode>([...a.parents().toArray(), ...a.toArray()]);
  for (const node of [...b.toArray(), ...b.parents().toArray()]) {
    if (ancestors.has(node)) return $(node) as cheerio.Cheerio<AnyNode>;
  }
  for (const node of b.parents().toArray()) {
    if (ancestors.has(node)) return $(node) as cheerio.Cheerio<AnyNode>;
  }
  return null;
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
    .find("h1, h2, h3, h4, h5, h6, p, ul, ol, blockquote, pre, table")
    .each((_, el) => {
      const node = $(el);
      const tag = el.tagName.toLowerCase();

      if (tag === "table") {
        // Nested tables are almost always layout, not data — the outer one
        // already carries their text.
        if (node.parents("table").length > 0) return;
        const markdown = tableToMarkdown($, node, base);
        if (markdown) out.push(markdown);
        return;
      }

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

      // Skip content nested inside a list item or table cell we already emitted.
      if (node.parents("li").length > 0) return;
      if (node.parents("table").length > 0) return;
      const value = inline($, node, base);
      if (value) out.push(value);
    });

  return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function tableToMarkdown(
  $: cheerio.CheerioAPI,
  table: cheerio.Cheerio<AnyNode>,
  base: string,
): string {
  const rows: string[][] = [];

  table.find("tr").each((_, tr) => {
    const cells: string[] = [];
    $(tr)
      .children("th, td")
      .each((__, cell) => {
        cells.push(inline($, $(cell) as cheerio.Cheerio<AnyNode>, base).replace(/\|/g, "\\|"));
      });
    if (cells.some((c) => c.length > 0)) rows.push(cells);
  });

  if (rows.length === 0) return "";

  const width = Math.max(...rows.map((r) => r.length));
  const pad = (row: string[]) =>
    `| ${[...row, ...Array(width - row.length).fill("")].join(" | ")} |`;

  const [header, ...body] = rows;
  return [pad(header), `| ${Array(width).fill("---").join(" | ")} |`, ...body.map(pad)].join("\n");
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

  // Collapse *all* whitespace, newlines included. HTML renders a newline
  // inside a paragraph or table cell as a space, and leaving them in breaks
  // markdown constructs that are line-oriented — a table row with a multi-line
  // cell stops being a single row.
  return clone.text().trim().replace(/\s+/g, " ");
}

export function countWords(value: string): number {
  // The prime (′) belongs to the word class alongside the apostrophes: without
  // it, converting 5'8" to 5′8” splits one token into two and the reported
  // word count drifts after a fix that changed no words at all.
  const matches = value.trim().match(/\b[\p{L}\p{N}'’′-]+\b/gu);
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

  // Practically nothing was served, and there is script that could explain it.
  // Without the script check this also fired on pages that are simply very
  // short — reporting a small static page as "requires JavaScript", which
  // sends the user off to buy a rendering service they do not need. A genuinely
  // thin page should fail extraction with an accurate message instead.
  return scriptBytes > 500 && bodyText.length < 200;
}

/** Extract a lightweight summary of a crawled dealership page for AI context. */
export function extractPageFacts(html: string, url: string): {
  title: string | null;
  text: string;
  links: LinkRef[];
} {
  const $ = cheerio.load(html);
  const title = pickTitle($);
  stripChrome($);
  normalizeLineBreaks($);
  const body = $("body");
  return {
    title,
    text: toText($, body as cheerio.Cheerio<AnyNode>).slice(0, 12_000),
    links: collectLinks($, body as cheerio.Cheerio<AnyNode>, url),
  };
}

/**
 * Render markdown back to the plain-text form the rule engine reads.
 *
 * The revised article has one source of truth: its markdown. Deriving the text
 * from it — rather than applying the same edits to both renderings and hoping
 * they stay in step — is what stops a whitespace fix from silently changing
 * paragraph structure in one and not the other. That drift previously made a
 * rule stop matching and get reported as resolved when nothing had been fixed.
 */
export function markdownToPlainText(markdown: string): string {
  const blocks = markdown.split(/\n{2,}/);

  const rendered = blocks.map((block) =>
    block
      .replace(/^```[\s\S]*?```$/gm, (code) => code.replace(/^```\w*\n?|```$/g, ""))
      .split("\n")
      // Drop a table's separator row; it carries no content.
      .filter((line) => !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line))
      .map((line) =>
        line
          // Flatten a table row into readable text. The separator matters: an
          // em dash here would make the extractor's own output trip the
          // em-dash-overuse rule, reporting a defect the article never had.
          // A colon for label/value pairs and a comma otherwise reads as prose
          // and collides with nothing in the rule library.
          .replace(/^\s*\|(.*)\|\s*$/, (_m, inner: string) => {
            const cells = inner
              .split(/(?<!\\)\|/)
              .map((c) => c.replace(/\\\|/g, "|").trim())
              .filter(Boolean);
            return cells.length === 2 ? `${cells[0]}: ${cells[1]}` : cells.join(", ");
          })
          .replace(/^\s{0,3}#{1,6}\s+/, "")
          .replace(/^\s{0,3}>\s?/, "")
          .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/, "")
          .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")
          .replace(/`([^`]+)`/g, "$1")
          .replace(/[ \t]+/g, " ")
          .trim(),
      )
      .filter(Boolean)
      .join("\n"),
  );

  return rendered.filter(Boolean).join("\n\n");
}

/**
 * The prose blocks of an article — what "paragraph" means for readability.
 *
 * Read from the markdown, where a table is still a table. Once flattened into
 * plain text a comparison table looks exactly like one very long paragraph,
 * and the readability rules flagged real dealership spec tables as walls of
 * text. Headings, lists, quotes and code are excluded for the same reason:
 * none of them is a paragraph.
 */
export function proseParagraphs(markdown: string): string[] {
  return markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => {
      if (!block) return false;
      const first = block.split("\n")[0];
      if (/^\s{0,3}#{1,6}\s/.test(first)) return false;      // heading
      if (/^\s*\|/.test(first)) return false;                 // table
      if (/^\s{0,3}(?:[-*+]|\d+\.)\s/.test(first)) return false; // list
      if (/^\s{0,3}>/.test(first)) return false;              // blockquote
      if (/^\s*```/.test(first)) return false;                // code fence
      return true;
    });
}
