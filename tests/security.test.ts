import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicUrl, FetchError } from "../src/lib/http";

/**
 * Users submit arbitrary URLs that we fetch from inside our own
 * infrastructure. These cases are the difference between a scraper and an
 * SSRF proxy, so they are asserted explicitly.
 */

async function blocked(url: string): Promise<boolean> {
  try {
    await assertPublicUrl(url);
    return false;
  } catch (error) {
    return error instanceof FetchError && error.kind === "blocked";
  }
}

test("loopback addresses are refused", async () => {
  assert.ok(await blocked("http://127.0.0.1/admin"));
  assert.ok(await blocked("http://127.1.2.3/"));
  assert.ok(await blocked("http://localhost:3000/api/jobs/advance"));
  assert.ok(await blocked("http://[::1]/"));
});

test("RFC1918 private ranges are refused", async () => {
  assert.ok(await blocked("http://10.0.0.1/"));
  assert.ok(await blocked("http://192.168.1.1/"));
  assert.ok(await blocked("http://172.16.0.1/"));
  assert.ok(await blocked("http://172.31.255.254/"));
});

test("172.32.x is public and must not be over-blocked", async () => {
  // 172.16-172.31 is private; 172.32 is not. An over-broad check would break
  // legitimate sites.
  assert.equal(await blocked("http://172.32.0.1/"), false);
});

test("cloud metadata endpoints are refused", async () => {
  assert.ok(await blocked("http://169.254.169.254/latest/meta-data/"));
  assert.ok(await blocked("http://169.254.170.2/v2/credentials"));
});

test("carrier-grade NAT and multicast are refused", async () => {
  assert.ok(await blocked("http://100.64.0.1/"));
  assert.ok(await blocked("http://224.0.0.1/"));
});

test("IPv4-mapped IPv6 cannot smuggle a private address", async () => {
  assert.ok(await blocked("http://[::ffff:10.0.0.1]/"));
  assert.ok(await blocked("http://[::ffff:127.0.0.1]/"));
});

test("IPv6 unique-local and link-local are refused", async () => {
  assert.ok(await blocked("http://[fd00::1]/"));
  assert.ok(await blocked("http://[fe80::1]/"));
});

test("internal hostnames are refused", async () => {
  assert.ok(await blocked("http://app.internal/"));
  assert.ok(await blocked("http://foo.localhost/"));
});

test("non-http protocols are refused", async () => {
  assert.ok(await blocked("file:///etc/passwd"));
  assert.ok(await blocked("gopher://evil/"));
  assert.ok(await blocked("ftp://files.example.com/"));
});

test("a normal public URL passes", async () => {
  await assert.doesNotReject(() => assertPublicUrl("https://example.com/blog/post"));
  await assert.doesNotReject(() => assertPublicUrl("http://8.8.8.8/"));
});

test("global-unicast IPv6 passes", async () => {
  // 2000::/3 is the only globally routable IPv6 range.
  await assert.doesNotReject(() => assertPublicUrl("http://[2606:4700:4700::1111]/"));
});
