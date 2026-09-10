/**
 * Turn a failure into something a person can act on.
 *
 * Database and network errors arrive with whatever the far end sent back. When
 * a URL is misconfigured that is an entire HTML page, and interpolating it into
 * a message puts a rendered web page in the user interface — which is both
 * useless and hides the one fact that matters. Anything that looks like markup
 * is replaced with a diagnosis, and everything else is capped so a long stack
 * or query cannot fill the screen.
 */

const MAX_LENGTH = 300;

export function describeError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (error as { message?: string })?.message ?? String(error);

  const message = (raw ?? "").trim();
  if (!message) return "Unknown error.";

  if (/^\s*<(?:!doctype|html|\?xml)/i.test(message) || /<\/html>/i.test(message)) {
    return (
      "The database endpoint returned a web page instead of data. This almost " +
      "always means SUPABASE_URL is wrong — it should be Project Settings → " +
      "API → Project URL (https://your-project-ref.supabase.co), not the dashboard address."
    );
  }

  if (message.includes("fetch failed") || message.includes("ENOTFOUND")) {
    return `Could not reach the database. Check SUPABASE_URL is correct and the project is running. (${message.slice(0, 120)})`;
  }

  if (/JWT|api key|apikey|Invalid authentication/i.test(message)) {
    return `The database rejected our credentials. Check SUPABASE_SERVICE_ROLE_KEY. (${message.slice(0, 120)})`;
  }

  return message.length > MAX_LENGTH ? `${message.slice(0, MAX_LENGTH)}…` : message;
}
