"use client";

import { useEffect, useRef, useState } from "react";

/** The user-facing checkpoints, in the order the pipeline reaches them. */
const CHECKPOINTS = [
  { key: "start", label: "Audit started", at: 0 },
  { key: "processing", label: "Processing...", at: 5 },
  { key: "article", label: "Checking article...", at: 8 },
  { key: "dealership", label: "Checking dealership pages...", at: 32 },
  { key: "links", label: "Checking links...", at: 48 },
  { key: "rules", label: "Applying QA rules...", at: 62 },
  { key: "verify", label: "Final verification...", at: 74 },
  { key: "done", label: "Audit complete", at: 100 },
];

interface JobStatus {
  id: string;
  status: string;
  step: string;
  progress: number;
  status_message: string;
  error: string | null;
}

/**
 * Polls the status endpoint until the job settles.
 *
 * Polling rather than a socket is deliberate: it survives serverless cold
 * starts, needs no persistent connection, and a dropped poll costs nothing but
 * one extra interval. Backs off while the job is long-running so a slow crawl
 * doesn't generate hundreds of requests.
 */
export function AuditProgress({
  jobId,
  initial,
  onComplete,
}: {
  jobId: string;
  initial: JobStatus;
  onComplete?: () => void;
}) {
  const [job, setJob] = useState<JobStatus>(initial);
  const completed = useRef(false);

  useEffect(() => {
    if (job.status === "complete" || job.status === "failed" || job.status === "canceled") {
      if (!completed.current) {
        completed.current = true;
        onComplete?.();
      }
      return;
    }

    let cancelled = false;
    let delay = 1500;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const response = await fetch(`/api/audits/${jobId}/status`, { cache: "no-store" });
        if (response.ok) {
          const data = await response.json();
          if (!cancelled && data.audit) setJob(data.audit);
        }
      } catch {
        // A failed poll is not worth surfacing — the next one will succeed.
      }
      if (cancelled) return;
      delay = Math.min(delay * 1.25, 6000);
      timer = setTimeout(poll, delay);
    };

    timer = setTimeout(poll, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId, job.status, onComplete]);

  const failed = job.status === "failed";
  const progress = failed ? job.progress : Math.max(job.progress, 5);

  return (
    <div className="panel p-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">
          {failed ? "Audit failed" : job.status === "complete" ? "Audit complete" : job.status_message}
        </h2>
        <span className="text-xs tabular-nums muted">{progress}%</span>
      </div>

      <div
        className="h-1.5 w-full overflow-hidden rounded-full"
        style={{ background: "var(--border)" }}
        role="progressbar"
        aria-valuenow={progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Audit progress"
      >
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${progress}%`,
            background: failed ? "var(--critical)" : "var(--accent)",
          }}
        />
      </div>

      <ol className="mt-5 space-y-2">
        {CHECKPOINTS.map((checkpoint) => {
          const reached = progress >= checkpoint.at;
          const active =
            !failed &&
            job.status !== "complete" &&
            reached &&
            progress < (CHECKPOINTS[CHECKPOINTS.indexOf(checkpoint) + 1]?.at ?? 101);

          return (
            <li key={checkpoint.key} className="flex items-center gap-2.5 text-sm">
              <span
                aria-hidden
                className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-[0.6rem]"
                style={{
                  border: `1px solid ${reached ? "var(--accent)" : "var(--border-strong)"}`,
                  background: reached && !active ? "var(--accent)" : "transparent",
                  color: "#fff",
                }}
              >
                {reached && !active ? "✓" : ""}
              </span>
              <span
                style={{
                  color: reached ? "var(--ink)" : "var(--ink-muted)",
                  fontWeight: active ? 600 : 400,
                }}
              >
                {checkpoint.label}
              </span>
              {active && <span className="text-xs muted">…</span>}
            </li>
          );
        })}
      </ol>

      {failed && job.error && (
        <p
          className="mt-4 rounded p-3 text-sm"
          style={{ background: "var(--accent-soft)", color: "var(--critical)" }}
          role="alert"
        >
          {job.error}
        </p>
      )}
    </div>
  );
}
