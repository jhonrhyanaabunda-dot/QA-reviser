import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * The rule library lives in SQL, so nothing in the TypeScript build checks it.
 * A pattern that does not compile is silently skipped at runtime — the rule
 * simply stops firing, with no error anywhere. These tests are the only thing
 * standing between a typo and a rule that quietly never runs again.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  path.join(here, "..", "supabase", "migrations", "0003_seed_rules.sql"),
  "utf8",
);

interface SeedRule {
  code: string;
  kind: string;
  severity: string;
  pattern: string | null;
  fixMode: string;
}

/** Parse the VALUES tuples. Each starts `(null, 'CODE', 'Title', 'Desc',`. */
function parseSeedRules(): SeedRule[] {
  const rules: SeedRule[] = [];
  const blocks = sql.split(/\n\(null, /).slice(1);

  for (const block of blocks) {
    const code = block.match(/^'([A-Z0-9_]+)'/)?.[1];
    if (!code) continue;

    // Fields 5-7 after the three text fields: category, kind, severity.
    const meta = block.match(
      /'((?:[^']|'')*)',\s*'(regex|ai|link|structural)',\s*'(info|low|medium|high|critical)',\s*/,
    );
    if (!meta) continue;

    const rest = block.slice(meta.index! + meta[0].length);
    const pattern = rest.startsWith("null")
      ? null
      : rest.match(/^'((?:[^']|'')*)'/)?.[1].replace(/''/g, "'") ?? null;

    const fixMode = block.match(/'(none|safe|suggest)',\s*true,\s*\d+\)/)?.[1] ?? "suggest";

    rules.push({ code, kind: meta[2], severity: meta[3], pattern, fixMode });
  }
  return rules;
}

const rules = parseSeedRules();

test("the seed file parses into a non-trivial rule library", () => {
  assert.ok(rules.length >= 30, `only parsed ${rules.length} rules`);
});

test("every rule code is unique", () => {
  const seen = new Set<string>();
  const duplicates = rules.filter((r) => (seen.has(r.code) ? true : (seen.add(r.code), false)));
  assert.deepEqual(duplicates.map((d) => d.code), []);
});

test("every regex rule has a pattern that compiles", () => {
  const broken: string[] = [];
  for (const rule of rules.filter((r) => r.kind === "regex")) {
    if (!rule.pattern) {
      broken.push(`${rule.code}: kind is regex but pattern is null`);
      continue;
    }
    try {
      new RegExp(rule.pattern, "gim");
    } catch (error) {
      broken.push(`${rule.code}: ${(error as Error).message}`);
    }
  }
  assert.deepEqual(broken, []);
});

test("non-regex rules do not carry a pattern", () => {
  const stray = rules
    .filter((r) => r.kind !== "regex" && r.pattern !== null)
    .map((r) => `${r.code} (${r.kind}) has a pattern that will never run`);
  assert.deepEqual(stray, []);
});

test("no regex pattern matches the empty string", () => {
  // A pattern matching "" fires on every position in the article.
  const catastrophic = rules
    .filter((r) => r.kind === "regex" && r.pattern)
    .filter((r) => new RegExp(r.pattern!).test(""))
    .map((r) => r.code);
  assert.deepEqual(catastrophic, []);
});

test("every rule set to auto-fix is one we can apply safely", () => {
  // apply-fixes only knows how to auto-apply a regex substitution, the
  // typographic-quote conversion, the https upgrade, or a model-proposed
  // replacement on an `ai` rule. Marking anything else `safe` is a rule that
  // claims it will be fixed and never is.
  const applicable = new Set(["STYLE_STRAIGHT_QUOTES", "LINK_HTTP_INSECURE"]);
  const unfixable = rules
    .filter((r) => r.fixMode === "safe")
    .filter((r) => !(r.kind === "regex" || r.kind === "ai" || applicable.has(r.code)))
    .map((r) => `${r.code} (${r.kind})`);
  assert.deepEqual(unfixable, []);
});

test("the rules the pipeline references by name all exist", () => {
  const codes = new Set(rules.map((r) => r.code));
  const referenced = [
    "AI_UNIFORM_PARAGRAPHS", "STRUCT_NO_H1", "STRUCT_HEADING_SKIP",
    "STRUCT_WALL_OF_TEXT", "SEO_TITLE_LENGTH", "SEO_NO_META_DESCRIPTION",
    "SEO_IMG_NO_ALT", "SEO_THIN_CONTENT",
    "LINK_BROKEN", "LINK_NO_INTERNAL", "LINK_COMPETITOR", "LINK_GENERIC_ANCHOR",
    "LINK_HTTP_INSECURE", "LINK_REDIRECT_CHAIN", "LINK_NO_AUTHORITY_CITED",
    "FACT_NAP_MISMATCH", "SPEC_UNVERIFIED",
    "STYLE_STRAIGHT_QUOTES", "STYLE_EXCLAMATION", "AI_EM_DASH_SPAM",
  ];
  const missing = referenced.filter((code) => !codes.has(code));
  assert.deepEqual(missing, [], "pipeline code names a rule the seed does not define");
});

test("count-threshold rules are all regex rules", () => {
  // COUNT_THRESHOLDS in rules.ts only applies inside runRegexRules.
  const thresholded = ["STYLE_EXCLAMATION", "AI_EM_DASH_SPAM", "STYLE_STRAIGHT_QUOTES",
                       "STYLE_DOUBLE_SPACE", "STYLE_TRAILING_WHITESPACE"];
  for (const code of thresholded) {
    const rule = rules.find((r) => r.code === code);
    assert.ok(rule, `${code} is missing from the seed`);
    assert.equal(rule!.kind, "regex", `${code} has a count threshold but is not a regex rule`);
  }
});
