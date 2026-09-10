import { NextResponse, type NextRequest } from "next/server";
import { apiHandler } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { triggerAdvance } from "@/pipeline/runner";

/**
 * Recovery cron.
 *
 * The pipeline chains itself, which is fast but not durable — a dropped
 * dispatch or a killed invocation leaves a job parked mid-audit. This sweeps
 * every 5 minutes for jobs that are queued or hold an expired lease and kicks
 * them back into motion. It also fails jobs that have been stuck long enough
 * that something is genuinely wrong, so nothing sits in "Processing..." forever.
 */
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const STALE_AFTER_MS = 2 * 60_000;
const ABANDON_AFTER_MS = 30 * 60_000;
const MAX_RESUMED_PER_RUN = 10;

function authorized(request: NextRequest): boolean {
  const secret = env.cronSecret;
  // Vercel Cron signs its own requests; the shared secret covers manual calls.
  if (request.headers.get("x-vercel-cron")) return true;
  if (!secret) return false;
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

async function handleGET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createAdminClient();
  const now = Date.now();
  const staleBefore = new Date(now - STALE_AFTER_MS).toISOString();
  const abandonBefore = new Date(now - ABANDON_AFTER_MS).toISOString();

  const { data: abandoned } = await db
    .from("audit_jobs")
    .update({
      status: "failed",
      error: "The audit stopped responding and was abandoned after 30 minutes.",
      status_message: "Audit failed",
      finished_at: new Date().toISOString(),
      lease_expires_at: null,
    })
    .in("status", ["queued", "running"])
    .lt("updated_at", abandonBefore)
    .select("id");

  const { data: stalled, error } = await db
    .from("audit_jobs")
    .select("id, step, status, updated_at")
    .in("status", ["queued", "running"])
    .lt("updated_at", staleBefore)
    .order("updated_at", { ascending: true })
    .limit(MAX_RESUMED_PER_RUN);

  if (error) {
    return NextResponse.json({ error: describeError(error) }, { status: 500 });
  }

  const resumed: string[] = [];
  for (const job of stalled ?? []) {
    await triggerAdvance(job.id);
    resumed.push(job.id);
  }

  return NextResponse.json({
    resumed,
    abandoned: (abandoned ?? []).map((j) => j.id),
    checkedAt: new Date().toISOString(),
  });
}

export const GET = apiHandler(handleGET);
