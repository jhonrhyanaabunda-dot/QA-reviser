import Link from "next/link";
import { db } from "@/lib/supabase/server";
import { StatusPill } from "@/components/status-pill";

export const dynamic = "force-dynamic";

export default async function AuditsPage() {

  const supabase = db();
  const { data: audits } = await supabase
    .from("audit_jobs")
    .select("id, source_url, status, progress, status_message, created_at, finished_at")
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <div>
      <h1 className="mb-5 text-lg font-semibold">Audits</h1>

      {(audits ?? []).length === 0 ? (
        <p className="panel p-5 text-sm muted">
          No audits yet. <Link className="underline" href="/">Start one</Link>.
        </p>
      ) : (
        <ul className="space-y-2">
          {(audits ?? []).map((job) => (
            <li key={job.id}>
              <Link href={`/audits/${job.id}`} className="panel block p-4 hover:opacity-80">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{job.source_url}</p>
                    <p className="mt-0.5 text-xs muted">
                      {new Date(job.created_at).toLocaleString()} · {job.status_message}
                    </p>
                  </div>
                  <StatusPill status={job.status} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
