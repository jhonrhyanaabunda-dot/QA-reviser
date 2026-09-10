/**
 * URL normalization and domain matching.
 *
 * Everything the crawler is allowed to touch is decided here. Two rules that
 * matter for safety: we never resolve a URL that isn't http(s), and we never
 * crawl a host that isn't on the dealership's approved domain list.
 */

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "gclid", "fbclid", "msclkid", "mc_cid", "mc_eid", "_ga", "ref",
]);

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Parse a user-supplied URL, tolerating a missing scheme. */
export function parseUserUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    return u;
  } catch {
    return null;
  }
}

/** Canonical form used for dedupe: no hash, no tracking params, no trailing slash. */
export function normalizeUrl(value: string, base?: string): string | null {
  try {
    const u = new URL(value, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return null;
  }
}

/** Hostname without a leading `www.`, lowercased. */
export function registrableHost(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** True when `url`'s host equals `domain` or is a subdomain of it. */
export function hostMatchesDomain(url: string, domain: string): boolean {
  const host = registrableHost(url);
  if (!host) return false;
  const target = domain.toLowerCase().replace(/^www\./, "").replace(/^https?:\/\//, "").split("/")[0];
  return host === target || host.endsWith(`.${target}`);
}

export function matchesAnyDomain(url: string, domains: string[]): boolean {
  return domains.some((d) => hostMatchesDomain(url, d));
}

/**
 * Paths that are never worth crawling for QA context — they burn the page
 * budget without contributing facts about the dealership.
 */
const SKIP_PATH = /\.(?:pdf|jpe?g|png|gif|svg|webp|avif|ico|css|js|zip|mp4|webm|woff2?|ttf)(?:$|\?)/i;
const SKIP_SEGMENT = /\/(?:wp-admin|wp-json|wp-content|cdn-cgi|feed|rss|tag|author|cart|checkout|login|signin|account|privacy|terms|sitemap)(?:\/|$)/i;

export function isCrawlableUrl(url: string): boolean {
  if (!isHttpUrl(url)) return false;
  if (SKIP_PATH.test(url)) return false;
  if (SKIP_SEGMENT.test(url)) return false;
  return true;
}

/**
 * Dealership pages that carry the facts an article is most likely to get
 * wrong: contact details, hours, inventory, financing, service.
 */
const HIGH_VALUE = [
  /\/(?:contact|about|hours|location|directions)/i,
  /\/(?:inventory|new|used|vehicles|showroom|specials|offers)/i,
  /\/(?:finance|financing|credit|lease)/i,
  /\/(?:service|parts|schedule|maintenance)/i,
];

/** Lower sorts first. Used to prioritize a bounded crawl frontier. */
export function crawlPriority(url: string): number {
  const index = HIGH_VALUE.findIndex((re) => re.test(url));
  if (index >= 0) return index;
  try {
    // Shallow pages before deep ones.
    return 10 + new URL(url).pathname.split("/").filter(Boolean).length;
  } catch {
    return 99;
  }
}
