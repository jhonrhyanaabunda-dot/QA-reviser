import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AuditView } from "@/components/audit-view";
import { createServerSupabase, getUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AuditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getUser();
  if (!user) redirect("/login");

  const { id } = await params;
  const supabase = await createServerSupabase();

  const { data: job } = await supabase
    .from("audit_jobs")
    .select("id, source_url, status, step, progress, status_message, error, created_at")
    .eq("id", id)
    .maybeSingle();

  if (!job) notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link href="/audits" className="text-xs underline muted">← All audits</Link>
        <h1 className="mt-2 truncate text-lg font-semibold">
          {hostOf(job.source_url)}
        </h1>
        <a
          href={job.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-xs underline muted"
        >
          {job.source_url}
        </a>
      </div>

      <AuditView jobId={job.id} initial={job} />
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
