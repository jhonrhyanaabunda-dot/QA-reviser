"use client";

import { useCallback, useEffect, useState } from "react";
import { AuditProgress } from "./audit-progress";
import { AuditReport, type ReportData } from "./audit-report";

/**
 * Progress while the audit runs, the report once it settles.
 *
 * The report is fetched only after the job reaches a terminal state, so the
 * polling loop stays cheap — the status endpoint returns a handful of fields
 * rather than the whole report on every tick.
 */
export function AuditView({
  jobId,
  initial,
}: {
  jobId: string;
  initial: {
    id: string;
    status: string;
    step: string;
    progress: number;
    status_message: string;
    error: string | null;
  };
}) {
  const settled =
    initial.status === "complete" || initial.status === "failed" || initial.status === "canceled";

  const [report, setReport] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(settled);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/audits/${jobId}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load the report.");
      setReport(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    if (settled) void load();
  }, [settled, load]);

  return (
    <div className="space-y-6">
      <AuditProgress jobId={jobId} initial={initial} onComplete={load} />

      {error && (
        <p className="panel p-4 text-sm" style={{ color: "var(--critical)" }} role="alert">
          {error}
        </p>
      )}

      {loading && !report && <p className="text-sm muted">Loading report…</p>}
      {report && report.job.status !== "failed" && <AuditReport data={report} />}
    </div>
  );
}
