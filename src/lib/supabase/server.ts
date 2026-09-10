import "server-only";

import { createAdminClient } from "./admin";

/**
 * Server-side database handle.
 *
 * With no login there is no session to scope queries by, so every route uses
 * the service-role client. This is why the browser must never hold a Supabase
 * key: Row Level Security is still enabled on every table and now denies the
 * anon role outright, which makes the server routes the only way in. Access
 * control lives in this application, not in the database.
 */
export function db() {
  return createAdminClient();
}
