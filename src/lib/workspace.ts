import "server-only";

/**
 * The single workspace every row belongs to.
 *
 * The app has no login: there is one shared set of audits, dealerships and QA
 * rules. Keeping the `user_id` columns and pointing them all at one row means
 * the schema, foreign keys and existing data stay intact, so adding accounts
 * back later is a matter of restoring the auth trigger rather than migrating
 * every table.
 *
 * Matches the row seeded by supabase/migrations/0004_single_workspace.sql.
 */
export const WORKSPACE_USER_ID = "00000000-0000-4000-8000-000000000001";
