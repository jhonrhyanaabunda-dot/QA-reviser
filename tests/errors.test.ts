import { test } from "node:test";
import assert from "node:assert/strict";
import { describeError } from "../src/lib/errors";

/**
 * A misconfigured SUPABASE_URL made the database return its dashboard's HTML,
 * and the whole page was rendered into the UI as the error message. These
 * assertions are about what the user is told, which is the part that failed.
 */

test("an HTML response becomes a diagnosis, not a rendered web page", () => {
  const page = '<!DOCTYPE html><html lang="en"><head><title>Supabase</title>' +
    "<link rel=\"icon\"/>".repeat(200) + "</head><body>dashboard</body></html>";
  const message = describeError(new Error(page));

  assert.ok(!message.includes("<"), "no markup may reach the user");
  assert.ok(message.length < 300, `still too long: ${message.length} chars`);
  assert.match(message, /SUPABASE_URL/);
  assert.match(message, /Project URL/);
});

test("a lowercase or xml-prefixed page is caught too", () => {
  for (const page of ["<html><body>x</body></html>", '<?xml version="1.0"?><html></html>']) {
    assert.match(describeError(new Error(page)), /SUPABASE_URL/);
  }
});

test("an unreachable host names the setting to check", () => {
  const message = describeError(new Error("fetch failed"));
  assert.match(message, /Could not reach the database/);
  assert.match(message, /SUPABASE_URL/);
});

test("a rejected key points at the credential, not the URL", () => {
  const message = describeError(new Error("Invalid API key"));
  assert.match(message, /SUPABASE_SERVICE_ROLE_KEY/);
});

test("an ordinary message passes through unchanged", () => {
  const message = "duplicate key value violates unique constraint";
  assert.equal(describeError(new Error(message)), message);
});

test("a very long message is capped", () => {
  const message = describeError(new Error("x".repeat(5000)));
  assert.ok(message.length <= 301, `got ${message.length}`);
  assert.ok(message.endsWith("…"));
});

test("non-Error values are handled", () => {
  assert.equal(describeError("plain string"), "plain string");
  assert.equal(describeError({ message: "from an object" }), "from an object");
  assert.equal(describeError(null), "null");
  assert.equal(describeError(new Error("")), "Unknown error.");
});
