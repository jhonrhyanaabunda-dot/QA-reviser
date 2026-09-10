import "server-only";

import { createClient } from "@supabase/supabase-js";
import { env } from "../env";
import type { Database } from "./database.types";

/**
 * Service-role client — bypasses RLS.
 *
 * Used only by the pipeline, which runs without a user session but must still
 * write to job-scoped tables. The `server-only` import above makes it a build
 * error to ever pull this into a client component.
 */
let cached: ReturnType<typeof createClient<Database>> | null = null;

export function createAdminClient() {
  if (!cached) {
    cached = createClient<Database>(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}
