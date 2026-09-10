import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { z } from "zod";
import { db } from "@/lib/supabase/server";
import { WORKSPACE_USER_ID } from "@/lib/workspace";

/**
 * Human review of a finding.
 *
 * Feedback is what makes the rule library improve: a rule that keeps getting
 * rejected is a rule that is miscalibrated, and the rules page surfaces that
 * rate so it can be tuned or switched off.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  issueId: z.string().uuid(),
  verdict: z.enum(["accept", "reject", "modify"]),
  note: z.string().max(2000).optional(),
});

async function handlePOST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {

  const { id: jobId } = await params;

  let payload: z.infer<typeof schema>;
  try {
    payload = schema.parse(await request.json());
  } catch (error) {
    return NextResponse.json({ error: describeError(error) }, { status: 400 });
  }

  const supabase = db();

  // RLS scopes this to the caller's own issues.
  const { data: issue } = await supabase
    .from("issues")
    .select("id, rule_id, job_id")
    .eq("id", payload.issueId)
    .eq("job_id", jobId)
    .maybeSingle();

  if (!issue) return NextResponse.json({ error: "Issue not found." }, { status: 404 });

  const { data, error } = await supabase
    .from("qa_feedback")
    .insert({
      user_id: WORKSPACE_USER_ID,
      issue_id: issue.id,
      rule_id: issue.rule_id,
      job_id: jobId,
      verdict: payload.verdict,
      note: payload.note ?? null,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: describeError(error) }, { status: 500 });

  // Reject means the finding was wrong — reflect that on the issue itself.
  if (payload.verdict === "reject") {
    await supabase.from("issues").update({ status: "dismissed" }).eq("id", issue.id);
  }

  return NextResponse.json({ feedback: data }, { status: 201 });
}

export const POST = apiHandler(handlePOST);
