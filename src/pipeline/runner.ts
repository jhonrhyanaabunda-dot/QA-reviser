import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { appUrl, env } from "@/lib/env";
import { JOB_STEPS, STEP_META, type AuditJob, type JobState, type JobStep } from "@/lib/types";
import type { AuditJobRow } from "@/lib/supabase/database.types";

/**
 * The audit pipeline runner.
 *
 * An audit is a state machine persisted in `audit_jobs`. One HTTP invocation
 * advances it by exactly one step, writes the result, and hands off to the next
 * invocation — so no single serverless request ever has to hold an unbounded
 * crawl open. Steps that can exceed a function's time budget (crawling,
 * link checking) process a bounded chunk and re-enter themselves.
 *
 * Ownership is a lease, not a lock: a worker claims a job by stamping
 * `lease_expires_at` into the future. If the chain breaks — a cold-start
 * timeout, a killed invocation — the lease lapses and the cron reaper picks the
 * job back up where it left off.
 */

const LEASE_MS = 110_000;
const MAX_ATTEMPTS_PER_STEP = 3;

export type StepOutcome =
  | { kind: "advance"; message?: string; state?: Partial<JobState> }
  | { kind: "repeat"; message?: string; state?: Partial<JobState> }
  | { kind: "fail"; error: string };

export interface StepContext {
  db: ReturnType<typeof createAdminClient>;
  job: AuditJob;
  state: JobState;
  /** Records a non-fatal problem on the job without failing the audit. */
  warn: (message: string) => void;
}

export type StepHandler = (ctx: StepContext) => Promise<StepOutcome>;

export function nextStepAfter(step: JobStep): JobStep {
  const index = JOB_STEPS.indexOf(step);
  if (index < 0 || index >= JOB_STEPS.length - 1) return "complete";
  return JOB_STEPS[index + 1];
}

function toJob(row: AuditJobRow): AuditJob {
  return {
    ...row,
    state: (row.state ?? {}) as JobState,
    options: (row.options ?? {}) as AuditJob["options"],
  };
}

/**
 * Take ownership of a job for one step.
 *
 * Returns null when another worker holds a live lease — that is the normal
 * outcome of a duplicate trigger, not an error.
 */
async function claim(jobId: string): Promise<AuditJob | null> {
  const db = createAdminClient();
  const now = new Date();
  const lease = new Date(now.getTime() + LEASE_MS).toISOString();

  const { data: current, error: readError } = await db
    .from("audit_jobs")
    .select("*")
    .eq("id", jobId)
    .single();

  if (readError || !current) return null;
  if (current.status === "complete" || current.status === "failed" || current.status === "canceled") {
    return null;
  }

  const leaseLive =
    current.status === "running" &&
    current.lease_expires_at !== null &&
    new Date(current.lease_expires_at) > now;
  if (leaseLive) return null;

  // Conditional update doubles as the lock: if a second worker got here first,
  // its lease is already in the row and this matches zero rows.
  const query = db
    .from("audit_jobs")
    .update({
      status: "running",
      lease_expires_at: lease,
      attempts: current.attempts + 1,
      started_at: current.started_at ?? now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("id", jobId)
    .eq("step", current.step);

  const { data, error } = await (current.lease_expires_at === null
    ? query.is("lease_expires_at", null)
    : query.eq("lease_expires_at", current.lease_expires_at)
  )
    .select("*")
    .maybeSingle();

  if (error || !data) return null;
  return toJob(data);
}

async function release(
  jobId: string,
  patch: Partial<AuditJobRow>,
): Promise<void> {
  const db = createAdminClient();
  await db
    .from("audit_jobs")
    .update({ ...patch, lease_expires_at: null, updated_at: new Date().toISOString() })
    .eq("id", jobId);
}

export interface AdvanceResult {
  status: "advanced" | "repeated" | "complete" | "failed" | "skipped";
  step: JobStep;
  message: string;
  /** True when another invocation should be triggered. */
  continues: boolean;
}

/** Runs exactly one step of a job. Never throws — failures land on the row. */
export async function advanceJob(jobId: string): Promise<AdvanceResult> {
  const job = await claim(jobId);
  if (!job) {
    return {
      status: "skipped",
      step: "complete",
      message: "Job is already finished or held by another worker.",
      continues: false,
    };
  }

  if (job.step === "complete") {
    await release(jobId, {
      status: "complete",
      progress: 100,
      status_message: STEP_META.complete.label,
      finished_at: new Date().toISOString(),
    });
    return { status: "complete", step: "complete", message: "Audit complete", continues: false };
  }

  const db = createAdminClient();
  const warnings: string[] = [];
  const context: StepContext = {
    db,
    job,
    state: job.state ?? {},
    warn: (message) => warnings.push(message),
  };

  let outcome: StepOutcome;
  try {
    const handler = await loadHandler(job.step);
    outcome = await handler(context);
  } catch (error) {
    outcome = {
      kind: "fail",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const mergedState: JobState = {
    ...context.state,
    ...(outcome.kind === "fail" ? {} : outcome.state ?? {}),
  };
  if (warnings.length) {
    mergedState.warnings = [...(mergedState.warnings ?? []), ...warnings].slice(-50);
  }

  if (outcome.kind === "fail") {
    // Transient failures get retried on the same step; persistent ones stop the
    // audit rather than burning the whole budget on a wedged step.
    const exhausted = job.attempts >= MAX_ATTEMPTS_PER_STEP;
    if (exhausted) {
      await release(jobId, {
        status: "failed",
        error: outcome.error,
        status_message: `Failed during ${job.step.replace(/_/g, " ")}`,
        state: mergedState,
        finished_at: new Date().toISOString(),
      });
      return {
        status: "failed",
        step: job.step,
        message: outcome.error,
        continues: false,
      };
    }

    await release(jobId, {
      status: "queued",
      error: outcome.error,
      state: mergedState,
      status_message: `Retrying ${job.step.replace(/_/g, " ")} (attempt ${job.attempts + 1})`,
    });
    return {
      status: "repeated",
      step: job.step,
      message: `Retrying after error: ${outcome.error}`,
      continues: true,
    };
  }

  if (outcome.kind === "repeat") {
    await release(jobId, {
      status: "queued",
      error: null,
      attempts: 0,
      state: mergedState,
      status_message: outcome.message ?? STEP_META[job.step].label,
    });
    return {
      status: "repeated",
      step: job.step,
      message: outcome.message ?? STEP_META[job.step].label,
      continues: true,
    };
  }

  const next = nextStepAfter(job.step);
  const finished = next === "complete";

  await release(jobId, {
    status: finished ? "complete" : "queued",
    step: next,
    error: null,
    attempts: 0,
    state: mergedState,
    progress: STEP_META[next].progress,
    status_message: outcome.message ?? STEP_META[next].label,
    ...(finished ? { finished_at: new Date().toISOString(), progress: 100 } : {}),
  });

  return {
    status: finished ? "complete" : "advanced",
    step: next,
    message: outcome.message ?? STEP_META[next].label,
    continues: !finished,
  };
}

/**
 * Steps are imported lazily so a single invocation only pulls in the code for
 * the step it is actually running — cheerio and the Anthropic SDK never load
 * for a step that does not need them.
 */
async function loadHandler(step: JobStep): Promise<StepHandler> {
  switch (step) {
    case "fetch_article":
      return (await import("./steps/fetch-article")).fetchArticleStep;
    case "extract_content":
      return (await import("./steps/extract-content")).extractContentStep;
    case "crawl_dealership":
      return (await import("./steps/crawl-dealership")).crawlDealershipStep;
    case "analyze_links":
      return (await import("./steps/analyze-links")).analyzeLinksStep;
    case "analyze_qa_rules":
      return (await import("./steps/analyze-qa-rules")).analyzeQaRulesStep;
    case "verify_facts":
      return (await import("./steps/verify-facts")).verifyFactsStep;
    case "apply_fixes":
      return (await import("./steps/apply-fixes")).applyFixesStep;
    case "final_audit":
      return (await import("./steps/final-audit")).finalAuditStep;
    case "save_report":
      return (await import("./steps/save-report")).saveReportStep;
    default:
      throw new Error(`No handler for step ${step}`);
  }
}

/**
 * Kick the next invocation.
 *
 * The advance route acknowledges before doing its work, so this resolves in
 * milliseconds and the current function can exit instead of nesting inside the
 * whole downstream chain. The abort is a belt-and-braces timeout: even if the
 * dispatch is cut off, the reaper cron will resume the job.
 */
export async function triggerAdvance(jobId: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  try {
    await fetch(`${appUrl()}/api/jobs/advance`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": env.internalJobSecret,
        // Present only when Deployment Protection is enabled. Without it a
        // protected preview answers this request with Vercel's login page
        // instead of running the step, and the audit stalls silently.
        ...(env.vercelBypassSecret
          ? { "x-vercel-protection-bypass": env.vercelBypassSecret }
          : {}),
      },
      body: JSON.stringify({ jobId }),
    });
  } catch {
    // Swallowed on purpose — the reaper is the recovery path.
  } finally {
    clearTimeout(timer);
  }
}
