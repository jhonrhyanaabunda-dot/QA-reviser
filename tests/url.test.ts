import { test } from "node:test";
import assert from "node:assert/strict";
import {
  crawlPriority,
  hostMatchesDomain,
  isCrawlableUrl,
  matchesAnyDomain,
  normalizeUrl,
  parseUserUrl,
  registrableHost,
} from "../src/lib/url";

test("parseUserUrl tolerates a missing scheme", () => {
  assert.equal(parseUserUrl("example.com/blog")?.toString(), "https://example.com/blog");
  assert.equal(parseUserUrl("  https://a.co/x  ")?.toString(), "https://a.co/x");
});

test("parseUserUrl rejects non-http and hostless input", () => {
  assert.equal(parseUserUrl("javascript:alert(1)"), null);
  assert.equal(parseUserUrl("file:///etc/passwd"), null);
  assert.equal(parseUserUrl("localhost"), null, "no dot means not a public host");
  assert.equal(parseUserUrl(""), null);
});

test("normalizeUrl strips tracking params, hash and trailing slash", () => {
  assert.equal(
    normalizeUrl("https://a.co/page/?utm_source=x&id=7&gclid=z#top"),
    "https://a.co/page?id=7",
  );
});

test("normalizeUrl sorts params so the same page dedupes", () => {
  assert.equal(normalizeUrl("https://a.co/p?b=2&a=1"), normalizeUrl("https://a.co/p?a=1&b=2"));
});

test("normalizeUrl resolves against a base", () => {
  assert.equal(normalizeUrl("/inventory", "https://d.com/blog/post"), "https://d.com/inventory");
  assert.equal(normalizeUrl("../x", "https://d.com/a/b/c"), "https://d.com/a/x");
});

test("registrableHost drops www and lowercases", () => {
  assert.equal(registrableHost("https://WWW.Example.COM/x"), "example.com");
});

test("hostMatchesDomain covers subdomains but not lookalikes", () => {
  assert.ok(hostMatchesDomain("https://inventory.dealer.com/x", "dealer.com"));
  assert.ok(hostMatchesDomain("https://www.dealer.com", "dealer.com"));
  assert.ok(hostMatchesDomain("https://dealer.com", "www.dealer.com"));
  assert.ok(!hostMatchesDomain("https://notdealer.com", "dealer.com"));
  assert.ok(!hostMatchesDomain("https://dealer.com.evil.net", "dealer.com"));
});

test("matchesAnyDomain checks the whole approved list", () => {
  const approved = ["dealer.com", "dealerinventory.net"];
  assert.ok(matchesAnyDomain("https://used.dealerinventory.net/a", approved));
  assert.ok(!matchesAnyDomain("https://carvana.com", approved));
});

test("isCrawlableUrl skips assets and boilerplate paths", () => {
  assert.ok(isCrawlableUrl("https://d.com/new-inventory"));
  assert.ok(!isCrawlableUrl("https://d.com/brochure.pdf"));
  assert.ok(!isCrawlableUrl("https://d.com/wp-admin/edit.php"));
  assert.ok(!isCrawlableUrl("https://d.com/privacy"));
  assert.ok(!isCrawlableUrl("mailto:a@b.com"));
});

test("crawlPriority puts fact-carrying pages first", () => {
  const contact = crawlPriority("https://d.com/contact-us");
  const inventory = crawlPriority("https://d.com/new-inventory");
  const random = crawlPriority("https://d.com/blog/2024/03/some/deep/post");
  assert.ok(contact < inventory, "contact outranks inventory");
  assert.ok(inventory < random, "inventory outranks a deep blog post");
});
