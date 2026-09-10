import { test } from "node:test";
import assert from "node:assert/strict";
import { countWords, extractArticle, needsJsRendering } from "../src/lib/extract";

const ARTICLE_HTML = `<!doctype html>
<html><head>
  <title>2025 Toyota RAV4 Review | Riverside Toyota</title>
  <meta name="description" content="A close look at the 2025 RAV4 trims, pricing and towing.">
  <meta name="author" content="Dana Reyes">
  <meta property="og:title" content="2025 Toyota RAV4 Review">
</head><body>
  <nav><a href="/inventory">Inventory</a><a href="/service">Service</a></nav>
  <header><a href="/">Home</a></header>
  <article class="post-content">
    <h1>2025 Toyota RAV4 Review</h1>
    <p>The 2025 <strong>RAV4</strong> makes 203 horsepower and is rated at 30 mpg combined.
       See our <a href="https://riversidetoyota.com/new-inventory">new inventory</a> for current stock.</p>
    <h2>Towing</h2>
    <p>Properly equipped, it tows 3,500 lbs. Read more <a href="http://example.com/specs">here</a>.</p>
    <ul><li>Front-wheel drive standard</li><li>All-wheel drive available</li></ul>
    <img src="/img/rav4.jpg" alt="A blue RAV4">
    <img src="/img/interior.jpg">
  </article>
  <footer><a href="/privacy">Privacy</a></footer>
  <script>window.__DATA__ = {}</script>
</body></html>`;

test("extractArticle pulls title, byline and meta description", () => {
  const a = extractArticle(ARTICLE_HTML, "https://riversidetoyota.com/blog/rav4");
  assert.equal(a.title, "2025 Toyota RAV4 Review");
  assert.equal(a.byline, "Dana Reyes");
  assert.equal(a.metaDescription, "A close look at the 2025 RAV4 trims, pricing and towing.");
});

test("extractArticle keeps body prose and drops chrome", () => {
  const a = extractArticle(ARTICLE_HTML, "https://riversidetoyota.com/blog/rav4");
  assert.match(a.text, /203 horsepower/);
  assert.match(a.text, /tows 3,500 lbs/);
  assert.ok(!a.text.includes("Privacy"), "footer should be stripped");
  assert.ok(!a.text.includes("window.__DATA__"), "scripts should be stripped");
});

test("extractArticle collects headings in document order", () => {
  const a = extractArticle(ARTICLE_HTML, "https://riversidetoyota.com/blog/rav4");
  assert.deepEqual(a.headings, [
    { level: 1, text: "2025 Toyota RAV4 Review" },
    { level: 2, text: "Towing" },
  ]);
});

test("extractArticle resolves links and records missing alt text", () => {
  const a = extractArticle(ARTICLE_HTML, "https://riversidetoyota.com/blog/rav4");

  const urls = a.links.map((l) => l.url);
  assert.ok(urls.includes("https://riversidetoyota.com/new-inventory"));
  assert.ok(urls.includes("http://example.com/specs"));
  assert.ok(!urls.some((u) => u.endsWith("/privacy")), "footer links are out of scope");

  assert.equal(a.images.length, 2);
  assert.equal(a.images[0].alt, "A blue RAV4");
  assert.equal(a.images[1].alt, null, "missing alt must be null, not empty string");
  assert.equal(a.images[0].src, "https://riversidetoyota.com/img/rav4.jpg");
});

test("extractArticle produces markdown with headings, lists and links", () => {
  const a = extractArticle(ARTICLE_HTML, "https://riversidetoyota.com/blog/rav4");
  assert.match(a.markdown, /^# 2025 Toyota RAV4 Review$/m);
  assert.match(a.markdown, /^## Towing$/m);
  assert.match(a.markdown, /^- Front-wheel drive standard$/m);
  assert.match(a.markdown, /\[new inventory\]\(https:\/\/riversidetoyota\.com\/new-inventory\)/);
  assert.match(a.markdown, /\*\*RAV4\*\*/);
});

test("countWords handles punctuation and apostrophes", () => {
  assert.equal(countWords("It's a well-equipped, 3,500-lb tow rating."), 7);
  assert.equal(countWords("   "), 0);
});

test("needsJsRendering is false for a real server-rendered article", () => {
  const a = extractArticle(ARTICLE_HTML, "https://x.com/a");
  assert.equal(needsJsRendering(ARTICLE_HTML, a), false);
});

test("needsJsRendering is true for an empty SPA shell", () => {
  const shell = `<html><body><div id="root"></div><script>${"x".repeat(5000)}</script></body></html>`;
  const a = extractArticle(shell, "https://x.com/a");
  assert.equal(needsJsRendering(shell, a), true);
});

test("needsJsRendering is false for a server-rendered Next.js page", () => {
  // A hydrated Next.js page has the same #__next mount point as an unrendered
  // one. Only the empty mount point means the content is still client-side.
  const prose = "The 2025 model arrives this spring with a revised powertrain. ".repeat(12);
  const ssr = `<html><body><div id="__next"><article><h1>News</h1><p>${prose}</p></article></div>` +
    `<script>${"x".repeat(20000)}</script></body></html>`;
  const a = extractArticle(ssr, "https://x.com/a");
  assert.equal(needsJsRendering(ssr, a), false);
});

test("needsJsRendering is false for a short but genuinely static page", () => {
  const prose = "Our service department is open Saturdays until 4pm this month. ".repeat(10);
  const short = `<html><body><article><h1>Notice</h1><p>${prose}</p></article></body></html>`;
  const a = extractArticle(short, "https://x.com/a");
  assert.equal(needsJsRendering(short, a), false);
});
