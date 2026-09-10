import { env } from "./env";

/**
 * Firecrawl fallback for pages that genuinely need JavaScript rendering.
 *
 * This is deliberately a plain `fetch` against Firecrawl's HTTP API rather than
 * their SDK: it keeps the serverless bundle small and means there is no local
 * browser process anywhere in the system. If FIRECRAWL_API_KEY is unset the
 * whole module no-ops and callers record a warning instead of failing.
 */

const API = "https://api.firecrawl.dev/v2/scrape";
const TIMEOUT_MS = 45_000;

export interface FirecrawlPage {
  html: string;
  markdown: string;
  title: string | null;
  description: string | null;
  sourceUrl: string;
}

export class FirecrawlUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirecrawlUnavailable";
  }
}

export function firecrawlEnabled(): boolean {
  return env.hasFirecrawl;
}

export async function scrapeWithFirecrawl(url: string): Promise<FirecrawlPage> {
  const key = env.firecrawlApiKey;
  if (!key) {
    throw new FirecrawlUnavailable(
      "FIRECRAWL_API_KEY is not set, so JavaScript-rendered pages cannot be read.",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(API, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown", "html"],
        onlyMainContent: true,
        blockAds: true,
        timeout: 30_000,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new FirecrawlUnavailable(
        `Firecrawl returned ${response.status}: ${body.slice(0, 300)}`,
      );
    }

    const payload = (await response.json()) as {
      success?: boolean;
      error?: string;
      data?: {
        html?: string;
        rawHtml?: string;
        markdown?: string;
        metadata?: {
          title?: string;
          description?: string;
          sourceURL?: string;
          statusCode?: number;
        };
      };
    };

    if (!payload.success || !payload.data) {
      throw new FirecrawlUnavailable(
        `Firecrawl could not scrape ${url}: ${payload.error ?? "unknown error"}`,
      );
    }

    const data = payload.data;
    return {
      html: data.html ?? data.rawHtml ?? "",
      markdown: data.markdown ?? "",
      title: data.metadata?.title ?? null,
      description: data.metadata?.description ?? null,
      sourceUrl: data.metadata?.sourceURL ?? url,
    };
  } catch (error) {
    if (error instanceof FirecrawlUnavailable) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new FirecrawlUnavailable(`Firecrawl timed out after ${TIMEOUT_MS}ms on ${url}`);
    }
    throw new FirecrawlUnavailable(
      `Firecrawl request failed for ${url}: ${(error as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
