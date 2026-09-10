import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { db } from "@/lib/supabase/server";

/** GET /api/audits/:id — the full report. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleGET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {

  const { id } = await params;
  const supabase = db();

  const { data: job, error } = await supabase
    .from("audit_jobs")
    .select("*, dealerships(name, primary_domain)")
    .eq("id", id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: describeError(error) }, { status: 500 });
  if (!job) return NextResponse.json({ error: "Audit not found." }, { status: 404 });

  const [articles, issues, links, facts, fixes, result, pages] = await Promise.all([
    supabase.from("articles").select("*").eq("job_id", id),
    supabase.from("issues").select("*").eq("job_id", id).order("severity", { ascending: true }),
    supabase.from("link_checks").select("*").eq("job_id", id),
    supabase.from("fact_checks").select("*").eq("job_id", id),
    supabase.from("auto_fixes").select("*").eq("job_id", id),
    supabase.from("audit_results").select("*").eq("job_id", id).maybeSingle(),
    supabase.from("crawled_pages").select("url, title, status_code").eq("job_id", id),
  ]);

  return NextResponse.json({
    job,
    articles: articles.data ?? [],
    issues: issues.data ?? [],
    links: links.data ?? [],
    facts: facts.data ?? [],
    fixes: fixes.data ?? [],
    result: result.data ?? null,
    crawledPages: pages.data ?? [],
  });
}

/** DELETE /api/audits/:id — remove an audit and everything under it. */
async function handleDELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {

  const { id } = await params;
  const supabase = db();

  const { error } = await supabase.from("audit_jobs").delete().eq("id", id);
  if (error) return NextResponse.json({ error: describeError(error) }, { status: 500 });

  return NextResponse.json({ deleted: id });
}

export const GET = apiHandler(handleGET);
export const DELETE = apiHandler(handleDELETE);
