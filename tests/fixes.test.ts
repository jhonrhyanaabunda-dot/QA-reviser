import { test } from "node:test";
import assert from "node:assert/strict";
import { curlQuotes } from "../src/pipeline/steps/apply-fixes";

/**
 * Quote conversion rewrites published copy, so the cases that must NOT change
 * matter more than the ones that must.
 */

test("opening and closing double quotes are distinguished", () => {
  assert.equal(curlQuotes('He said "hello" to us.'), "He said “hello” to us.");
});

test("apostrophes become right single quotes", () => {
  assert.equal(curlQuotes("It's the dealer's best year."), "It’s the dealer’s best year.");
});

test("a quote after an opening bracket opens, not closes", () => {
  assert.equal(curlQuotes('(see "the manual")'), "(see “the manual”)");
});

test("feet and inches keep a prime, not a curly quote", () => {
  assert.equal(curlQuotes("The bed is 6' long."), "The bed is 6′ long.");
});

test("markdown link targets are never touched", () => {
  const input = "See [our inventory](https://d.com/new?a=1&b='x') for details.";
  assert.equal(curlQuotes(input), "See [our inventory](https://d.com/new?a=1&b='x') for details.");
});

test("inline code is never touched", () => {
  assert.equal(curlQuotes("Use `it's = 'raw'` here."), "Use `it's = 'raw'` here.");
});

test("fenced code blocks are never touched", () => {
  const input = 'Before.\n\n```\nconst a = "keep";\nconst b = \'keep\';\n```\n\nAfter "quoted".';
  const output = curlQuotes(input);
  assert.ok(output.includes('const a = "keep";'), "code fence must survive verbatim");
  assert.ok(output.includes("const b = 'keep';"), "code fence must survive verbatim");
  assert.ok(output.includes("After “quoted”."), "prose outside the fence is still converted");
});

test("text with no quotes is returned unchanged", () => {
  const input = "The 2025 RAV4 tows 3,500 lbs when properly equipped.";
  assert.equal(curlQuotes(input), input);
});

test("conversion is idempotent", () => {
  const once = curlQuotes('She said "go" — it\'s time.');
  assert.equal(curlQuotes(once), once, "running the fix twice must not change it again");
});
