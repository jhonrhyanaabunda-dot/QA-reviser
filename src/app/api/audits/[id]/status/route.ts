import { NextResponse } from "next/server";
import { createServerSupabase, getUser } from "@/lib/supabase/server";

/**
 * Lightweight polling endpoint.
 *
 * Returns only what the progress UI needs, so the client can poll every couple
 * of seconds without pulling the whole report down each time.
 */
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
    .select("id, status, step, progress, status_message, error, created_at, finished_at")
    .eq("id", id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Audit not found." }, { status: 404 });

  return NextResponse.json(
    { audit: data },
    { headers: { "Cache-Control": "no-store" } },
  );
}
