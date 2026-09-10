import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Server-side HTML fetching.
 *
 * Users submit arbitrary URLs and we fetch them from inside our own
 * infrastructure, so every request goes through an SSRF guard first: the
 * hostname is resolved and rejected if it lands on a loopback, link-local, or
 * private range. Responses are also size-capped so a huge file can't blow the
 * function's memory.
 */

const MAX_BYTES = 3_000_000; // 3 MB of HTML is far more than any article needs
const DEFAULT_TIMEOUT_MS = 12_000;

const USER_AGENT =
  "Mozilla/5.0 (compatible; QAReviserBot/1.0; +https://github.com/) AppleWebKit/537.36";

export class FetchError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly kind: "blocked" | "timeout" | "http" | "network" | "too_large" = "network",
  ) {
    super(message);
    this.name = "FetchError";
  }
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();

    // IPv4-mapped addresses decide on the embedded IPv4 address. The URL
    // parser normalizes "::ffff:10.0.0.1" to the hex form "::ffff:a00:1", so
    // both spellings have to be handled or the dotted one is the only one
    // that gets checked.
    const dotted = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateIp(dotted[1]);

    const hex = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      return isPrivateIp(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
    }

    // Everything else: only 2000::/3 is global unicast. Treating the rest as
    // non-public covers loopback (::1), unique-local (fc00::/7), link-local
    // (fe80::/10), and anything else added later, rather than enumerating
    // ranges and missing one.
    return !(v6.startsWith("2") || v6.startsWith("3"));
  }

  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** Throws if the URL points anywhere we must not fetch from our own network. */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchError(`Not a valid URL: ${rawUrl}`, undefined, "blocked");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchError(`Unsupported protocol: ${url.protocol}`, undefined, "blocked");
  }

  // URL.hostname keeps the brackets on an IPv6 literal ("[::1]"), which makes
  // isIP() fail and would otherwise let every IPv6 address skip the private
  // range check below.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new FetchError(`Refusing to fetch internal host: ${host}`, undefined, "blocked");
  }

  if (isIP(host)) {
    if (isPrivateIp(host)) {
      throw new FetchError(`Refusing to fetch private address: ${host}`, undefined, "blocked");
    }
    return;
  }

  try {
    const results = await lookup(host, { all: true });
    if (results.some((r) => isPrivateIp(r.address))) {
      throw new FetchError(
        `Refusing to fetch ${host}: resolves to a private address`,
        undefined,
        "blocked",
      );
    }
  } catch (error) {
    if (error instanceof FetchError) throw error;
    throw new FetchError(`Could not resolve host: ${host}`, undefined, "network");
  }
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  html: string;
  redirected: boolean;
}

/** Fetch a page as HTML, with SSRF guard, timeout and size cap. */
export async function fetchHtml(
  rawUrl: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<FetchResult> {
  await assertPublicUrl(rawUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(rawUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    const contentType = response.headers.get("content-type") ?? "";

    if (!response.ok) {
      throw new FetchError(
        `HTTP ${response.status} fetching ${rawUrl}`,
        response.status,
        "http",
      );
    }

    if (contentType && !/text\/html|application\/xhtml|text\/plain|\+xml/i.test(contentType)) {
      throw new FetchError(
        `Expected HTML but got ${contentType}`,
        response.status,
        "http",
      );
    }

    const html = await readCapped(response);

    return {
      url: rawUrl,
      finalUrl: response.url || rawUrl,
      status: response.status,
      contentType,
      html,
      redirected: Boolean(response.url) && response.url !== rawUrl,
    };
  } catch (error) {
    if (error instanceof FetchError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new FetchError(`Timed out after ${timeoutMs}ms fetching ${rawUrl}`, undefined, "timeout");
    }
    throw new FetchError(
      `Network error fetching ${rawUrl}: ${(error as Error).message}`,
      undefined,
      "network",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const chunks: string[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      chunks.push(decoder.decode(value.slice(0, Math.max(0, MAX_BYTES - (total - value.byteLength)))));
      break;
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());

  return chunks.join("");
}

export interface LinkStatus {
  status: number | null;
  ok: boolean;
  finalUrl: string | null;
  redirected: boolean;
  error: string | null;
}

/**
 * Liveness check for a single link. HEAD first (cheap), falling back to a
 * ranged GET — plenty of servers return 405 or 403 for HEAD but serve GET fine.
 */
export async function checkLink(
  rawUrl: string,
  { timeoutMs = 8_000 }: { timeoutMs?: number } = {},
): Promise<LinkStatus> {
  const attempt = async (method: "HEAD" | "GET"): Promise<LinkStatus> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(rawUrl, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "*/*",
          ...(method === "GET" ? { Range: "bytes=0-2048" } : {}),
        },
      });
      return {
        status: response.status,
        ok: response.ok || response.status === 206,
        finalUrl: response.url || rawUrl,
        redirected: Boolean(response.url) && response.url !== rawUrl,
        error: null,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    await assertPublicUrl(rawUrl);
  } catch (error) {
    return {
      status: null,
      ok: false,
      finalUrl: null,
      redirected: false,
      error: (error as Error).message,
    };
  }

  try {
    const head = await attempt("HEAD");
    if (head.ok || (head.status !== null && head.status < 400 && head.status !== 405)) {
      return head;
    }
    return await attempt("GET");
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `Timed out after ${timeoutMs}ms`
        : (error as Error).message;
    return { status: null, ok: false, finalUrl: null, redirected: false, error: message };
  }
}
