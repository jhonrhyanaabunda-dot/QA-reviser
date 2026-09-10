/**
 * Central environment access. Server-only values are read lazily so that a
 * missing optional key never breaks the build — only the code path that
 * actually needs it fails, with a message naming the variable.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Add it in Vercel → Settings → Environment Variables (or .env.local for dev).`,
    );
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const env = {
  // --- Supabase ---
  get supabaseUrl() {
    return required("NEXT_PUBLIC_SUPABASE_URL");
  },
  get supabaseAnonKey() {
    return required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  },
  get supabaseServiceRoleKey() {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },

  // --- AI ---
  get anthropicApiKey() {
    return required("ANTHROPIC_API_KEY");
  },
  get aiModel() {
    return optional("AI_MODEL") ?? "claude-opus-5";
  },
  get aiEffort(): "low" | "medium" | "high" {
    const raw = optional("AI_EFFORT");
    return raw === "low" || raw === "high" ? raw : "medium";
  },

  // --- Firecrawl (optional) ---
  get firecrawlApiKey() {
    return optional("FIRECRAWL_API_KEY");
  },
  get hasFirecrawl() {
    return Boolean(optional("FIRECRAWL_API_KEY"));
  },

  // --- Pipeline ---
  get internalJobSecret() {
    return required("INTERNAL_JOB_SECRET");
  },
  get cronSecret() {
    return optional("CRON_SECRET");
  },

  /**
   * Vercel Deployment Protection bypass.
   *
   * Preview deployments are protected by default, so the pipeline's calls back
   * into itself are answered by Vercel's auth wall rather than the route — the
   * audit then stalls with no error anywhere. Vercel exposes this secret
   * automatically once protection is enabled; when present it is sent on the
   * internal requests so they reach the function.
   */
  get vercelBypassSecret() {
    return optional("VERCEL_AUTOMATION_BYPASS_SECRET");
  },
} as const;

/**
 * Absolute origin of this deployment.
 *
 * The self-chaining pipeline calls back into itself, so it needs a real origin
 * rather than a relative path. Preference order matters: VERCEL_URL points at
 * the *immutable deployment* URL, which is what we want — a step chain that
 * started on one deployment should finish there rather than hopping onto a
 * newer one mid-audit.
 */
export function appUrl(): string {
  const explicit = optional("APP_URL");
  if (explicit) return explicit.replace(/\/$/, "");

  const vercelUrl = optional("VERCEL_URL");
  if (vercelUrl) return `https://${vercelUrl}`;

  const prodUrl = optional("VERCEL_PROJECT_PRODUCTION_URL");
  if (prodUrl) return `https://${prodUrl}`;

  return "http://localhost:3000";
}
