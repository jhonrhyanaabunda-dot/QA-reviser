import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countWords,
  extractArticle,
  markdownToPlainText,
  needsJsRendering,
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
