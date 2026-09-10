import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml } from "../src/lib/markdown";
import { extractArticle } from "../src/lib/extract";

/**
 * The copied HTML is pasted straight into a CMS, so it has to be both correct
 * and safe: article text must never be able to introduce markup of its own.
 */

test("headings, paragraphs and emphasis render", () => {
  const html = markdownToHtml("# Title\n\nSome **bold** and *italic* text.");
  assert.equal(html, "<h1>Title</h1>\n<p>Some <strong>bold</strong> and <em>italic</em> text.</p>");
});

test("lists render as real list markup", () => {
  assert.equal(markdownToHtml("- one\n- two"), "<ul><li>one</li><li>two</li></ul>");
  assert.equal(markdownToHtml("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
});

test("tables render with a header row", () => {
  const html = markdownToHtml("| Metric | Value |\n| --- | --- |\n| MPG | 30 |");
  assert.match(html, /<table><thead><tr><th>Metric<\/th><th>Value<\/th><\/tr><\/thead>/);
  assert.match(html, /<tbody><tr><td>MPG<\/td><td>30<\/td><\/tr><\/tbody>/);
});

test("links keep their href", () => {
  assert.equal(
    markdownToHtml("See [our inventory](https://d.com/new)."),
    '<p>See <a href="https://d.com/new">our inventory</a>.</p>',
  );
});

test("article text cannot inject markup", () => {
  const html = markdownToHtml('A price of <script>alert("x")</script> & "quotes".');
  assert.ok(!html.includes("<script>"), "script tag must be escaped");
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test("inline code is not re-processed for emphasis", () => {
  const html = markdownToHtml("Use `a **b** c` here.");
  assert.match(html, /<code>a \*\*b\*\* c<\/code>/);
  assert.ok(!html.includes("<strong>"), "emphasis inside code must not render");
});

test("a real extracted article round-trips to sane HTML", () => {
  const source = `<html><head><title>t</title></head><body><article>
    <h1>2025 Review</h1>
    <p>${"Prose about the vehicle lineup and trims. ".repeat(8)}</p>
    <h2>Specs</h2>
    <table><tr><th>Metric</th><th>Value</th></tr><tr><td>Combined MPG</td><td>30</td></tr></table>
    <ul><li>Front-wheel drive</li><li>All-wheel drive available</li></ul>
    <p>See <a href="https://d.com/inventory">our inventory</a>.</p>
  </article></body></html>`;

  const html = markdownToHtml(extractArticle(source, "https://d.com/a").markdown);
  assert.match(html, /<h1>2025 Review<\/h1>/);
  assert.match(html, /<h2>Specs<\/h2>/);
  assert.match(html, /<table>/);
  assert.match(html, /<ul><li>Front-wheel drive<\/li>/);
  assert.match(html, /<a href="https:\/\/d\.com\/inventory">our inventory<\/a>/);
  assert.ok(!html.includes("|"), "table pipes must not leak into the HTML");
  assert.ok(!/^#/m.test(html), "markdown heading syntax must not leak into the HTML");
});

test("a URL containing parentheses survives intact", () => {
  // Automotive writing links to model codes constantly: /Toyota_RAV4_(XA50).
  // A regex that stops at the first ")" mangles both the href and the text.
  const md = "See the [RAV4](https://en.wikipedia.org/wiki/Toyota_RAV4_(XA50)) page.";
  const html = markdownToHtml(md);
  assert.match(html, /href="https:\/\/en\.wikipedia\.org\/wiki\/Toyota_RAV4_\(XA50\)"/);
  assert.match(html, />RAV4<\/a> page\./);
});

test("a rejected link leaves clean text, not a stray bracket", () => {
  const html = markdownToHtml("Click [here](javascript:alert(1)) now.");
  assert.ok(!html.includes("javascript:"), "dangerous scheme must not survive");
  assert.equal(html, "<p>Click here now.</p>");
});

test("unmatched brackets do not swallow the rest of the text", () => {
  assert.equal(markdownToHtml("A [broken link( here."), "<p>A [broken link( here.</p>");
  assert.equal(markdownToHtml("An [unclosed](http://x.com here."), "<p>An [unclosed](http://x.com here.</p>");
});
