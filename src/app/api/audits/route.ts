import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/supabase/server";
import { WORKSPACE_USER_ID } from "@/lib/workspace";
import { parseUserUrl } from "@/lib/url";
import { STEP_META } from "@/lib/types";
import { triggerAdvance } from "@/pipeline/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const submitSchema = z.object({
  url: z.string().min(4),
  dealershipId: z.string().uuid().nullable().optional(),
  applyFixes: z.boolean().optional(),
  skipFactCheck: z.boolean().optional(),
  maxCrawlPages: z.number().int().min(0).max(60).optional(),
});

/** GET /api/audits — the signed-in user's audits, newest first. */
export async function GET(request: NextRequest) {

  const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? 25), 100);
  const supabase = db();

  const { data, error } = await supabase
    .from("audit_jobs")
    .select("id, source_url, status, step, progress, status_message, error, created_at, finished_at, dealership_id")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ audits: data ?? [] });
}

/**
 * POST /api/audits — submit an article for audit.
 *
 * Creates the job row, returns immediately, and kicks the pipeline. The client
 * polls the status endpoint from here; this request never waits for the audit.
 */
export async function POST(request: NextRequest) {

  let payload: z.infer<typeof submitSchema>;
  try {
    payload = submitSchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: `Invalid request: ${(error as Error).message}` },
      { status: 400 },
    );
  }

  const url = parseUserUrl(payload.url);
  if (!url) {
    return NextResponse.json(
      { error: "That doesn't look like a valid article URL." },
      { status: 400 },
    );
  }

  const supabase = db();

  // RLS already scopes this, but checking explicitly gives a useful error
  // instead of a silent null dealership on a mistyped id.
  if (payload.dealershipId) {
    const { data: dealership } = await supabase
      .from("dealerships")
      .select("id")
      .eq("id", payload.dealershipId)
      .maybeSingle();
    if (!dealership) {
      return NextResponse.json({ error: "Unknown dealership." }, { status: 400 });
    }
  }

  const { data, error } = await supabase
    .from("audit_jobs")
    .insert({
      user_id: WORKSPACE_USER_ID,
      dealership_id: payload.dealershipId ?? null,
      source_url: url.toString(),
      status: "queued",
      step: "fetch_article",
      progress: STEP_META.fetch_article.progress,
      status_message: "Audit started",
      options: {
        applyFixes: payload.applyFixes ?? true,
        skipFactCheck: payload.skipFactCheck ?? false,
        ...(payload.maxCrawlPages !== undefined ? { maxCrawlPages: payload.maxCrawlPages } : {}),
      },
    })
    .select("id, source_url, status, step, progress, status_message, created_at")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: `Could not start the audit: ${error?.message ?? "unknown error"}` },
      { status: 500 },
    );
  }

  // Fire the first step. If this dispatch is lost the reaper picks it up.
  await triggerAdvance(data.id);

  return NextResponse.json({ audit: data }, { status: 201 });
}
