import { after, NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { advanceJob, triggerAdvance } from "@/pipeline/runner";

/**
 * Internal pipeline endpoint. Advances one job by one step.
 *
 * It acknowledges *before* doing the work: the step then runs in `after()`,
 * so the caller's dispatch resolves in milliseconds and each invocation's
 * lifetime covers its own step only, rather than nesting inside the whole
 * downstream chain. Authenticated by a shared secret, never by a user session —
 * this route runs with no user context.
 */
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function authorized(request: NextRequest): boolean {
  const provided = request.headers.get("x-internal-secret") ?? "";
  let expected: string;
  try {
    expected = env.internalJobSecret;
  } catch {
    return false;
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let jobId: string | undefined;
  try {
    const body = (await request.json()) as { jobId?: string };
    jobId = body.jobId;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body with a jobId." }, { status: 400 });
  }

  if (!jobId) {
    return NextResponse.json({ error: "jobId is required." }, { status: 400 });
  }

  const id = jobId;

  after(async () => {
    try {
      const result = await advanceJob(id);
      if (result.continues) {
        await triggerAdvance(id);
      }
    } catch (error) {
      // advanceJob already records failures on the row; this only catches a
      // failure to reach the database at all, where the reaper takes over.
      console.error(`[pipeline] job ${id} advance threw:`, error);
    }
  });

  return NextResponse.json({ accepted: true, jobId: id }, { status: 202 });
}
