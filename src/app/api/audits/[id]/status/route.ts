import { after, NextResponse } from "next/server";
import { createServerSupabase, getUser } from "@/lib/supabase/server";
import { triggerAdvance } from "@/pipeline/runner";

/**
 * Lightweight polling endpoint.
 *
 * Returns only what the progress UI needs, so the client can poll every couple
 * of seconds without pulling the whole report down each time.
 *
 * It also nudges a stalled job back into motion. The pipeline chains itself and
 * a cron sweep is the backstop, but Vercel's Hobby plan allows only one cron
 * run per day — a job whose dispatch was dropped would sit untouched until the
 * next sweep. Since the browser is already polling this endpoint while someone
 * watches the audit, that poll is the fastest recovery signal available, and it
 * costs one conditional per request.
 */

/** A job idle this long with no live lease is presumed dropped. */
const STALL_MS = 90_000;
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { id } = await params;
  const supabase = await createServerSupabase();

  const { data, error } = await supabase
    .from("audit_jobs")
    // Must stay one string literal: supabase-js infers the row type from it,
    // and a concatenated expression degrades every column to `unknown`.
    .select("id, status, step, progress, status_message, error, created_at, finished_at, updated_at, lease_expires_at")
    .eq("id", id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Audit not found." }, { status: 404 });

  const unfinished = data.status === "queued" || data.status === "running";
  const leaseExpired =
    data.lease_expires_at === null || new Date(data.lease_expires_at).getTime() < Date.now();
  const idleFor = Date.now() - new Date(data.updated_at).getTime();

  if (unfinished && leaseExpired && idleFor > STALL_MS) {
    // Fire after responding so the poll stays fast. advanceJob's lease check
    // makes a duplicate trigger a no-op, so racing with the cron is harmless.
    after(() => triggerAdvance(id));
  }

  return NextResponse.json(
    { audit: data },
    { headers: { "Cache-Control": "no-store" } },
  );
}
