import Link from "next/link";
import { AuditForm } from "@/components/audit-form";
import { createServerSupabase, getUser } from "@/lib/supabase/server";
import { StatusPill } from "@/components/status-pill";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getUser();
  if (!user) {
    return (
      <div className="py-10">
        <h1 className="text-xl font-semibold">QA Reviser</h1>
        <p className="mt-2 text-sm muted">
          <Link className="underline" href="/login">Sign in</Link> to run an audit.
        </p>
      </div>
    );
  }

  const supabase = await createServerSupabase();
  const { data: recent } = await supabase
    .from("audit_jobs")
    .select("id, source_url, status, progress, status_message, created_at")
    .order("created_at", { ascending: false })
    .limit(5);

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div>
        <h1 className="text-xl font-semibold">New audit</h1>
        <p className="mb-5 mt-1 text-sm muted">
          Paste a dealership article URL. The auditor extracts the content, crawls the
          dealership&rsquo;s approved pages, checks every link, applies your QA rules, verifies
          factual claims against the dealership site, and applies safe fixes.
        </p>
        <AuditForm />
      </div>

      <aside>
        <h2 className="mb-3 text-sm font-semibold">Recent audits</h2>
        {(recent ?? []).length === 0 ? (
          <p className="text-sm muted">Nothing yet.</p>
        ) : (
          <ul className="space-y-2">
            {(recent ?? []).map((job) => (
              <li key={job.id}>
                <Link href={`/audits/${job.id}`} className="panel block p-3 hover:opacity-80">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {hostOf(job.source_url)}
                    </span>
                    <StatusPill status={job.status} />
                  </div>
                  <p className="mt-1 truncate text-xs muted">{job.source_url}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Link href="/audits" className="mt-3 inline-block text-xs underline muted">
          View all audits
        </Link>
      </aside>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
