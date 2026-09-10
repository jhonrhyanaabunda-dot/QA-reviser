import { test } from "node:test";
import assert from "node:assert/strict";
import { computeScore, runRegexRules, runStructuralRules } from "../src/pipeline/rules";
import { extractArticle } from "../src/lib/extract";
import type { QaRule, Severity } from "../src/lib/types";

function rule(partial: Partial<QaRule> & Pick<QaRule, "code" | "kind">): QaRule {
  return {
    id: `id-${partial.code}`,
    user_id: null,
    dealership_id: null,
    title: partial.code,
    description: "test rule",
    category: "style",
    severity: "medium",
    pattern: null,
    replacement: null,
    guidance: null,
    fix_mode: "suggest",
    is_active: true,
    is_builtin: true,
    sort_order: 1,
    ...partial,
  } as QaRule;
}

// --- Patterns copied verbatim from supabase/migrations/0003_seed_rules.sql ---
const GUARANTEE =
  "\\b(guaranteed\\s+(?:approval|financing|credit)|everyone\\s+(?:is\\s+)?(?:approved|qualifies)|lowest\\s+price(?:s)?\\s+(?:anywhere|in\\s+the\\s+(?:state|country|nation))|no\\s+credit\\s+check\\s+(?:required|needed)|100%\\s+approval)\\b";
const NOT_ONLY = "\\bnot only\\b[^.!?]{0,120}?\\bbut also\\b";
const DELVE =
  "\\b(delve[sd]?\\s+into|a\\s+testament\\s+to|rich\\s+tapestry|in\\s+the\\s+realm\\s+of|navigat(?:e|ing)\\s+the\\s+(?:landscape|complexities)|unlock(?:ing)?\\s+the\\s+(?:full\\s+)?potential|game[\\s-]changer|when\\s+it\\s+comes\\s+to)\\b";

test("compliance pattern catches guarantee language", () => {
  const rules = [rule({ code: "GUARANTEE_LANGUAGE", kind: "regex", pattern: GUARANTEE, severity: "critical" })];
  const found = runRegexRules(
    rules,
    "We offer guaranteed approval and the lowest prices anywhere in the state.",
  );
  assert.equal(found.length, 2, "both phrases should be caught");
  assert.equal(found[0].severity, "critical");
  assert.match(found[0].evidence!, /guaranteed approval/);
});

test("compliance pattern does not fire on qualified language", () => {
  const rules = [rule({ code: "GUARANTEE_LANGUAGE", kind: "regex", pattern: GUARANTEE })];
  const found = runRegexRules(
    rules,
    "Financing is subject to credit approval. Ask about our competitive pricing.",
  );
  assert.equal(found.length, 0);
});

test("AI-pattern rules catch LLM tells", () => {
  const rules = [
    rule({ code: "AI_NOT_ONLY_BUT", kind: "regex", pattern: NOT_ONLY }),
    rule({ code: "AI_DELVE_VOCAB", kind: "regex", pattern: DELVE }),
  ];
  const found = runRegexRules(
    rules,
    "This SUV is not only spacious but also efficient. Let's delve into the trims. " +
      "When it comes to towing, it is a game-changer.",
  );
  const codes = found.map((f) => f.rule_code);
  assert.ok(codes.includes("AI_NOT_ONLY_BUT"));
  assert.ok(codes.filter((c) => c === "AI_DELVE_VOCAB").length >= 3);
});

test("count-threshold rules only fire above the threshold", () => {
  const rules = [rule({ code: "STYLE_EXCLAMATION", kind: "regex", pattern: "!", severity: "low" })];

  assert.equal(runRegexRules(rules, "Great deal!").length, 0, "one is allowed");

  const many = runRegexRules(rules, "Wow! Amazing! Come in today!");
  assert.equal(many.length, 1, "reports once, not per match");
  assert.match(many[0].detail!, /3 occurrences/);
});

test("em-dash rule tolerates normal usage and flags spam", () => {
  const rules = [rule({ code: "AI_EM_DASH_SPAM", kind: "regex", pattern: "—" })];
  assert.equal(runRegexRules(rules, "The RAV4 — our best seller — is here.").length, 0);
  assert.equal(runRegexRules(rules, "A — B — C — D — E").length, 1);
});

test("an invalid user-authored pattern is skipped, not fatal", () => {
  const rules = [
    rule({ code: "BROKEN", kind: "regex", pattern: "([unclosed" }),
    rule({ code: "WORKS", kind: "regex", pattern: "\\bhello\\b" }),
  ];
  const found = runRegexRules(rules, "hello there");
  assert.equal(found.length, 1);
  assert.equal(found[0].rule_code, "WORKS");
});

test("a rule matching many times is capped and summarized", () => {
  const rules = [rule({ code: "MANY", kind: "regex", pattern: "\\bx\\b" })];
  const found = runRegexRules(rules, Array(20).fill("x").join(" "));
  assert.equal(found.length, 9, "8 individual findings plus one summary row");
  assert.equal(found.at(-1)!.severity, "info");
  assert.match(found.at(-1)!.title, /12 more occurrences/);
});

// --- structural rules ------------------------------------------------------
const STRUCTURAL_RULES = [
  rule({ code: "STRUCT_NO_H1", kind: "structural", severity: "high" }),
  rule({ code: "STRUCT_HEADING_SKIP", kind: "structural" }),
  rule({ code: "SEO_IMG_NO_ALT", kind: "structural" }),
  rule({ code: "SEO_THIN_CONTENT", kind: "structural" }),
  rule({ code: "SEO_TITLE_LENGTH", kind: "structural" }),
  rule({ code: "SEO_NO_META_DESCRIPTION", kind: "structural" }),
  rule({ code: "STRUCT_WALL_OF_TEXT", kind: "structural", severity: "low" }),
];

test("structural rules flag a skipped heading level", () => {
  const html = `<html><head><title>t</title></head><body><article>
    <h1>Title</h1><p>${"word ".repeat(60)}</p>
    <h4>Jumped</h4><p>${"word ".repeat(60)}</p>
  </article></body></html>`;
  const found = runStructuralRules(STRUCTURAL_RULES, extractArticle(html, "https://x.com/a"));
  const skip = found.find((f) => f.rule_code === "STRUCT_HEADING_SKIP");
  assert.ok(skip, "H1 → H4 must be reported");
  assert.match(skip!.title, /H1 to H4/);
});

test("structural rules flag a duplicated H1", () => {
  const html = `<html><head><title>t</title></head><body><article>
    <h1>One</h1><p>${"word ".repeat(60)}</p><h1>Two</h1><p>${"word ".repeat(60)}</p>
  </article></body></html>`;
  const found = runStructuralRules(STRUCTURAL_RULES, extractArticle(html, "https://x.com/a"));
  const h1 = found.find((f) => f.rule_code === "STRUCT_NO_H1");
  assert.ok(h1);
  assert.match(h1!.title, /2 H1 headings/);
});

test("structural rules flag images without alt text only", () => {
  const html = `<html><head><title>t</title></head><body><article>
    <h1>T</h1><p>${"word ".repeat(60)}</p>
    <img src="/a.jpg" alt="described"><img src="/b.jpg"><img src="/c.jpg" alt="">
  </article></body></html>`;
  const found = runStructuralRules(STRUCTURAL_RULES, extractArticle(html, "https://x.com/a"));
  const alt = found.filter((f) => f.rule_code === "SEO_IMG_NO_ALT");
  assert.equal(alt.length, 2, "missing and empty alt both count; described does not");
});

test("structural rules flag thin content", () => {
  const html = `<html><head><title>t</title></head><body><article>
    <h1>T</h1><p>${"word ".repeat(40)}</p></article></body></html>`;
  const found = runStructuralRules(STRUCTURAL_RULES, extractArticle(html, "https://x.com/a"));
  assert.ok(found.some((f) => f.rule_code === "SEO_THIN_CONTENT"));
});

test("a well-formed article produces no structural findings", () => {
  const body = Array.from(
    { length: 6 },
    (_, i) => `<h2>Section ${i}</h2><p>${"Solid useful sentence goes here. ".repeat(11)}</p>`,
  ).join("");
  const html = `<html><head>
    <title>A Reasonable Forty Character Article Title</title>
    <meta name="description" content="${"A useful description of the article. ".repeat(4)}">
  </head><body><article><h1>A Reasonable Forty Character Article Title</h1>${body}
  <img src="/a.jpg" alt="ok"></article></body></html>`;

  const article = extractArticle(html, "https://x.com/a");
  const found = runStructuralRules(STRUCTURAL_RULES, article);
  assert.deepEqual(found, [], `unexpected findings: ${found.map((f) => f.title).join(", ")}`);
});

// --- scoring ---------------------------------------------------------------
test("score is 100 with no issues and decreases with severity", () => {
  assert.equal(computeScore([]), 100);
  const one = (s: Severity) => computeScore([{ severity: s }]);
  assert.ok(one("info") > one("low"));
  assert.ok(one("low") > one("medium"));
  assert.ok(one("medium") > one("high"));
  assert.ok(one("high") > one("critical"));
});

test("repeated findings of one rule have diminishing cost", () => {
  const of = (n: number) => computeScore(Array(n).fill({ severity: "medium" as Severity }));
  const firstHit = 100 - of(1);
  const tenthHit = of(9) - of(10);
  assert.ok(tenthHit < firstHit, "the tenth medium issue costs less than the first");
  assert.ok(of(30) > 0, "a noisy rule cannot drive the score to zero on its own");
});

test("score is clamped to 0-100", () => {
  const many = Array(200).fill({ severity: "critical" as Severity });
  const score = computeScore(many);
  assert.ok(score >= 0 && score <= 100, `got ${score}`);
});
