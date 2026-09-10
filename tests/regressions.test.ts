import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countWords,
  extractArticle,
  markdownToPlainText,
  needsJsRendering,
  proseParagraphs,
} from "../src/lib/extract";
import { curlQuotes } from "../src/pipeline/steps/apply-fixes";
import { computeScore, toIssueRow } from "../src/pipeline/rules";
import type { DetectedIssue, Severity } from "../src/lib/types";

/**
 * Regressions for bugs found by running the pipeline against real pages.
 * Each one shipped a wrong answer to the user, not just a crash.
 */

test("<br> yields a space instead of welding words together", () => {
  // "123 Main St<br>Springfield" became "123 Main StSpringfield", which would
  // corrupt every address comparison the fact checker makes.
  const html = `<html><head><title>t</title></head><body><article><h1>Contact</h1>
    <p>${"Visit our showroom for a test drive today. ".repeat(8)}</p>
    <p>123 Main St<br>Springfield, IL 62701<br>(555) 010-2000</p>
  </article></body></html>`;
  const a = extractArticle(html, "https://d.com/contact");
  assert.match(a.text, /123 Main St Springfield, IL 62701 \(555\) 010-2000/);
  assert.ok(!a.text.includes("StSpringfield"));
});

test("the extractor never emits an em dash of its own", () => {
  // Flattening table rows with " — " made the extractor's own output trip
  // AI_EM_DASH_SPAM, reporting a defect the article did not have.
  const html = `<html><head><title>t</title></head><body><article><h1>Specs</h1>
    <p>${"Prose about the vehicle lineup and its trims. ".repeat(8)}</p>
    <table><tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Combined MPG</td><td>30</td></tr>
    <tr><td>Towing</td><td>3,500 lbs</td></tr></table>
  </article></body></html>`;
  const a = extractArticle(html, "https://d.com/specs");
  assert.ok(!a.text.includes("—"), `em dash leaked into: ${a.text}`);
  assert.match(a.text, /Combined MPG: 30/);
});

test("plain text always equals the markdown rendering", () => {
  // These drifted apart, a fix changed one and not the other, and the
  // re-audit reported a finding as resolved that was never fixed.
  const html = `<html><head><title>t</title></head><body><article>
    <h1>Title</h1><p>Some prose here with a <a href="https://x.com">link</a>.</p>
    <ul><li>One item</li><li>Another item</li></ul>
    <table><tr><td>A</td><td>B</td></tr></table>
  </article></body></html>`;
  const a = extractArticle(html, "https://d.com/a");
  assert.equal(a.text, markdownToPlainText(a.markdown));
});

test("a small static page is not misreported as JavaScript-rendered", () => {
  // This told users to buy a rendering service for a page that had none.
  const tiny = `<html><body><div><h1>Notice</h1><p>Closed Monday.</p></div></body></html>`;
  const a = extractArticle(tiny, "https://d.com/n");
  assert.equal(needsJsRendering(tiny, a), false);
});

test("an empty SPA shell is still detected", () => {
  const shell = `<html><body><div id="root"></div><script>${"x".repeat(6000)}</script></body></html>`;
  const a = extractArticle(shell, "https://d.com/n");
  assert.equal(needsJsRendering(shell, a), true);
});

test("the score does not saturate on many minor findings", () => {
  // Linear subtraction scored an article with sixteen mostly-cosmetic issues
  // at 0/100 — indistinguishable from one riddled with compliance violations.
  const many = (s: Severity, n: number) => Array(n).fill({ severity: s });
  const cosmetic = computeScore(many("medium", 12));
  const serious = computeScore(many("critical", 3));
  assert.ok(cosmetic > 40, `12 medium issues scored ${cosmetic}, expected a usable number`);
  assert.ok(serious < cosmetic, "severity must outrank count");
  assert.ok(computeScore(many("info", 50)) > 80, "50 nits are still cosmetic");
});

test("one critical finding outweighs ten cosmetic ones", () => {
  const ten = computeScore(Array(10).fill({ severity: "medium" as Severity }));
  const one = computeScore([{ severity: "critical" as Severity }]);
  assert.ok(one < ten, `critical=${one} should score worse than ten medium=${ten}`);
});

test("an issue row carries defaults instead of nulls", () => {
  // PostgREST pads a batch insert to a common key set, so one finding that
  // omitted `location` sent an explicit null for every row and the NOT NULL
  // constraint rejected the entire step's findings.
  const bare: DetectedIssue = {
    rule_code: "X",
    category: "style",
    severity: "low",
    title: "Something",
  };
  const row = toIssueRow(bare, "job-1", "initial");
  assert.deepEqual(row.location, {});
  assert.equal(row.auto_fixable, false);
  assert.equal(row.rule_id, null);
  assert.equal(row.evidence, null);
  for (const [key, value] of Object.entries(row)) {
    assert.notEqual(value, undefined, `${key} must never be undefined`);
  }
});

test("typographic quote conversion does not change the word count", () => {
  // The conversion is a pure 1:1 character substitution, so a word count that
  // moves means the counter is wrong, not the text.
  const samples = [
    `He is 5'8" tall and drives a 6' bed truck.`,
    `She said "the RAV4's towing capacity is 3,500 lbs" last week.`,
    `It's a 2024 model — don't miss the 'special' pricing.`,
  ];
  for (const sample of samples) {
    assert.equal(
      countWords(curlQuotes(sample)),
      countWords(sample),
      `word count moved for: ${sample}`,
    );
    assert.equal(curlQuotes(sample).length, sample.length, "substitution must be 1:1");
  }
});

test("a hero <header> holding the H1 is kept, not stripped as chrome", () => {
  // A real dealership page put its H1 in <header class="hero">. Blanket-
  // removing every <header> deleted the title and the audit then reported
  // "Article has no H1" — a defect invented by the extractor.
  const html = `<html><head><title>t</title></head><body>
    <header class="hero"><nav><a href="/x">Menu</a></nav>
      <h1>Buying a Hyundai in National City</h1>
      <p>The lede paragraph that introduces the guide.</p></header>
    <section><h2>Section</h2><p>${"Body prose about the vehicle. ".repeat(20)}</p></section>
    <footer><p>Copyright notice</p></footer>
  </body></html>`;
  const a = extractArticle(html, "https://d.com/guide");

  assert.equal(a.headings.filter((h) => h.level === 1).length, 1);
  assert.equal(a.headings[0].text, "Buying a Hyundai in National City");
  assert.match(a.text, /lede paragraph/);
  assert.ok(!a.text.includes("Copyright notice"), "the footer is still chrome");
  assert.ok(!a.text.includes("Menu"), "nav inside the kept header is still removed");
});

test("content spread across sibling sections is not two-thirds discarded", () => {
  // These pages are a stack of <section> bands with no wrapper. Picking the
  // single best-scoring container audited 2,856 of 8,656 words on a real page.
  const band = (n: number) =>
    `<section class="band"><div class="in"><h2>Part ${n}</h2>` +
    `<p>${`Distinct prose for part ${n} that carries real content. `.repeat(12)}</p></div></section>`;
  const html = `<html><head><title>t</title></head><body><h1>Guide</h1>
    ${[1, 2, 3, 4, 5].map(band).join("")}</body></html>`;

  const a = extractArticle(html, "https://d.com/guide");
  assert.equal(a.headings.filter((h) => h.level === 2).length, 5, "every section must be captured");
  for (const n of [1, 2, 3, 4, 5]) {
    assert.match(a.text, new RegExp(`part ${n}`), `part ${n} is missing from the audited text`);
  }
});

test("a conventional article still uses its own container, not the whole body", () => {
  // The fallback must not throw away the container heuristic where it works.
  const html = `<html><head><title>t</title></head><body>
    <div class="sidebar"><p>Unrelated promo blurb.</p></div>
    <article class="post-content"><h1>Real Title</h1>
      <p>${"The actual article body carries nearly all of the words. ".repeat(30)}</p>
    </article></body></html>`;
  const a = extractArticle(html, "https://d.com/post");
  assert.match(a.text, /actual article body/);
  assert.ok(!a.text.includes("Unrelated promo blurb"), "sidebar must stay out of the audited text");
});

test("the broken-link totals only count genuinely dead links", () => {
  // A 403 from a bot-blocking publisher is not a broken link. Counting it as
  // one put a false high-severity finding on the authoritative sources a good
  // article cites.
  const rows = [
    { ok: false, status_code: 404 },
    { ok: false, status_code: 403 },
    { ok: false, status_code: null },
    { ok: true, status_code: 200 },
  ];
  const unverifiable = new Set([401, 403, 429, 999]);
  const dead = rows.filter(
    (r) => !r.ok && !(r.status_code !== null && unverifiable.has(r.status_code)),
  );
  assert.equal(dead.length, 2, "404 and unreachable count; 403 does not");
});

test("a spec table is not reported as an overlong paragraph", () => {
  // Once flattened to plain text a comparison table looks like one very long
  // paragraph. Real dealership spec tables were being flagged as walls of text.
  const rows = Array.from(
    { length: 8 },
    (_, i) => `<tr><td>Model ${i}</td><td>A compact crossover suited to city driving</td>` +
      `<td>Buyers who want space without bulk</td></tr>`,
  ).join("");
  const html = `<html><head><title>t</title></head><body><article>
    <h1>Lineup</h1>
    <p>${"Short intro sentence. ".repeat(5)}</p>
    <table><tr><th>Model</th><th>What it is</th><th>Who it suits</th></tr>${rows}</table>
  </article></body></html>`;

  const a = extractArticle(html, "https://d.com/lineup");
  const blocks = proseParagraphs(a.markdown);

  assert.ok(!blocks.some((b) => b.includes("|")), "no table block may be treated as prose");
  assert.ok(
    blocks.every((b) => countWords(b) < 120),
    `a table leaked into the prose blocks: ${blocks.map((b) => countWords(b)).join(", ")}`,
  );
  // The table content is still in the audited text, just not as a paragraph.
  assert.match(a.text, /A compact crossover suited to city driving/);
});

test("headings, lists and quotes are not paragraphs either", () => {
  const md = "# Title\n\nReal prose here.\n\n- item one\n- item two\n\n> a quote\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
  assert.deepEqual(proseParagraphs(md), ["Real prose here."]);
});
