"use client";

import { useState } from "react";
import { RevisedArticleDiff } from "./revised-article-diff";

const SEVERITY_COLOR: Record<string, string> = {
  critical: "var(--critical)",
  high: "var(--high)",
  medium: "var(--medium)",
  low: "var(--low)",
  info: "var(--info)",
};

const SEVERITY_RANK: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4,
};

interface Issue {
  id: string;
  rule_code: string | null;
  category: string;
  severity: string;
  title: string;
  detail: string | null;
  evidence: string | null;
  suggestion: string | null;
  status: string;
  phase: string;
  auto_fixable: boolean;
}

interface LinkCheck {
  id: string;
  url: string;
  anchor_text: string | null;
  link_type: string;
  is_dealership: boolean;
  status_code: number | null;
  ok: boolean;
  error: string | null;
}

interface FactCheck {
  id: string;
  claim: string;
  verdict: string;
  confidence: number;
  source_url: string | null;
  evidence: string | null;
  notes: string | null;
}

interface AutoFix {
  id: string;
  rule_code: string | null;
  kind: string;
  before_text: string;
  after_text: string;
  reason: string | null;
  applied: boolean;
  skipped_reason: string | null;
}

interface Article {
  kind: string;
  title: string | null;
  markdown: string | null;
  word_count: number;
}

interface Result {
  score: number;
  final_score: number;
  summary: string | null;
  totals: Record<string, unknown>;
}

export interface ReportData {
  job: { id: string; source_url: string; status: string; created_at: string };
  articles: Article[];
  issues: Issue[];
  links: LinkCheck[];
  facts: FactCheck[];
  fixes: AutoFix[];
  result: Result | null;
  crawledPages: { url: string; title: string | null; status_code: number | null }[];
}

type Tab = "issues" | "links" | "facts" | "fixes" | "article";

export function AuditReport({ data }: { data: ReportData }) {
  const [tab, setTab] = useState<Tab>("issues");

  const totals = (data.result?.totals ?? {}) as {
    links?: { total: number; broken: number; dealership: number };
    facts?: { contradicted: number; unverified: number; supported: number };
    fixes?: { applied: number; proposed: number };
    warnings?: string[];
  };

  const initialIssues = data.issues
    .filter((i) => i.phase === "initial")
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "issues", label: "Issues", count: initialIssues.length },
    { key: "links", label: "Links", count: data.links.length },
    { key: "facts", label: "Facts", count: data.facts.length },
    { key: "fixes", label: "Fixes", count: data.fixes.filter((f) => f.applied).length },
    { key: "article", label: "Revised article", count: 0 },
  ];

  return (
    <div className="space-y-6">
      {/* --- score + summary --- */}
      <section className="panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <h2 className="text-sm font-semibold">Result</h2>
            {data.result?.summary && (
              <p className="mt-2 max-w-2xl text-sm leading-relaxed">{data.result.summary}</p>
            )}
          </div>
          <div className="flex gap-6">
            <Score label="Before fixes" value={data.result?.score ?? 0} />
            <Score label="After fixes" value={data.result?.final_score ?? 0} highlight />
          </div>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-4 border-t pt-4 sm:grid-cols-4">
          <Stat label="Issues found" value={initialIssues.length} />
          <Stat
            label="Broken links"
            value={totals.links?.broken ?? data.links.filter((l) => !l.ok).length}
            alert={(totals.links?.broken ?? 0) > 0}
          />
          <Stat
            label="Contradicted claims"
            value={totals.facts?.contradicted ?? 0}
            alert={(totals.facts?.contradicted ?? 0) > 0}
          />
          <Stat label="Fixes applied" value={totals.fixes?.applied ?? 0} />
        </dl>

        {(totals.warnings?.length ?? 0) > 0 && (
          <details className="mt-4 text-xs muted">
            <summary className="cursor-pointer">
              {totals.warnings!.length} warning(s) during the audit
            </summary>
            <ul className="mt-2 list-inside list-disc space-y-1">
              {totals.warnings!.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/* --- tabs --- */}
      <div className="flex flex-wrap gap-1 border-b pb-px">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className="rounded-t px-3 py-2 text-sm"
            style={{
              borderBottom: `2px solid ${tab === t.key ? "var(--accent)" : "transparent"}`,
              color: tab === t.key ? "var(--ink)" : "var(--ink-muted)",
              fontWeight: tab === t.key ? 600 : 400,
            }}
          >
            {t.label}
            {t.count > 0 && <span className="ml-1.5 text-xs muted">{t.count}</span>}
          </button>
        ))}
      </div>

      {tab === "issues" && <IssuesTab jobId={data.job.id} issues={initialIssues} />}
      {tab === "links" && <LinksTab links={data.links} />}
      {tab === "facts" && <FactsTab facts={data.facts} />}
      {tab === "fixes" && <FixesTab fixes={data.fixes} />}
      {tab === "article" && <ArticleTab articles={data.articles} fixes={data.fixes} />}
    </div>
  );
}

function Score({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  const color = value >= 85 ? "var(--good)" : value >= 60 ? "var(--medium)" : "var(--critical)";
  return (
    <div className="text-right">
      <div
        className="text-3xl font-semibold tabular-nums"
        style={{ color: highlight ? color : "var(--ink-muted)" }}
      >
        {value}
      </div>
      <div className="text-xs muted">{label}</div>
    </div>
  );
}

function Stat({ label, value, alert }: { label: string; value: number; alert?: boolean }) {
  return (
    <div>
      <dt className="text-xs muted">{label}</dt>
      <dd
        className="text-lg font-semibold tabular-nums"
        style={{ color: alert ? "var(--critical)" : "var(--ink)" }}
      >
        {value}
      </dd>
    </div>
  );
}

function IssuesTab({ jobId, issues }: { jobId: string; issues: Issue[] }) {
  if (issues.length === 0) {
    return <p className="panel p-5 text-sm muted">No issues were found.</p>;
  }
  return (
    <ul className="space-y-2">
      {issues.map((issue) => (
        <IssueCard key={issue.id} jobId={jobId} issue={issue} />
      ))}
    </ul>
  );
}

function IssueCard({ jobId, issue }: { jobId: string; issue: Issue }) {
  const [verdict, setVerdict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendFeedback(value: "accept" | "reject") {
    setBusy(true);
    try {
      const response = await fetch(`/api/audits/${jobId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId: issue.id, verdict: value }),
      });
      if (response.ok) setVerdict(value);
    } finally {
      setBusy(false);
    }
  }

  const color = SEVERITY_COLOR[issue.severity] ?? "var(--info)";

  return (
    <li className="panel p-4" style={{ borderLeft: `3px solid ${color}` }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="rounded px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide"
              style={{ color, border: `1px solid ${color}` }}
            >
              {issue.severity}
            </span>
            <span className="text-xs muted">{issue.rule_code}</span>
            {issue.status === "fixed" && (
              <span className="text-xs" style={{ color: "var(--good)" }}>auto-fixed</span>
            )}
            {issue.status === "resolved" && (
              <span className="text-xs" style={{ color: "var(--good)" }}>resolved</span>
            )}
            {issue.status === "dismissed" && (
              <span className="text-xs muted">dismissed</span>
            )}
          </div>

          <h3 className="mt-1.5 text-sm font-medium">{issue.title}</h3>
          {issue.detail && <p className="mt-1 text-sm muted">{issue.detail}</p>}

          {issue.evidence && (
            <blockquote
              className="mt-2 rounded px-3 py-2 text-xs leading-relaxed"
              style={{ background: "var(--accent-soft)", fontFamily: "var(--font-mono)" }}
            >
              {issue.evidence}
            </blockquote>
          )}

          {issue.suggestion && (
            <p className="mt-2 text-sm">
              <span className="muted">Suggested: </span>
              {issue.suggestion}
            </p>
          )}
        </div>

        <div className="flex shrink-0 gap-1">
          {verdict ? (
            <span className="text-xs muted">
              {verdict === "accept" ? "Marked valid" : "Marked wrong"}
            </span>
          ) : (
            <>
              <button
                className="btn text-xs"
                disabled={busy}
                onClick={() => sendFeedback("accept")}
                title="This finding is correct"
              >
                Valid
              </button>
              <button
                className="btn text-xs"
                disabled={busy}
                onClick={() => sendFeedback("reject")}
                title="This finding is wrong"
              >
                Wrong
              </button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

function LinksTab({ links }: { links: LinkCheck[] }) {
  if (links.length === 0) {
    return <p className="panel p-5 text-sm muted">The article contains no links.</p>;
  }
  const sorted = [...links].sort((a, b) => Number(a.ok) - Number(b.ok));

  return (
    <div className="panel overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs muted">
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-4 py-2 font-medium">Anchor</th>
            <th className="px-4 py-2 font-medium">URL</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((link) => (
            <tr key={link.id} className="border-b last:border-0">
              <td className="px-4 py-2 tabular-nums">
                <span style={{ color: link.ok ? "var(--good)" : "var(--critical)" }}>
                  {link.status_code ?? "—"}
                </span>
              </td>
              <td className="px-4 py-2 text-xs muted">
                {link.is_dealership ? "dealership" : link.link_type}
              </td>
              <td className="max-w-[14rem] truncate px-4 py-2 text-xs">
                {link.anchor_text || <span className="muted">(none)</span>}
              </td>
              <td className="max-w-[22rem] px-4 py-2">
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="block truncate text-xs underline"
                >
                  {link.url}
                </a>
                {link.error && (
                  <span className="text-xs" style={{ color: "var(--critical)" }}>
                    {link.error}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FactsTab({ facts }: { facts: FactCheck[] }) {
  if (facts.length === 0) {
    return (
      <p className="panel p-5 text-sm muted">
        No verifiable claims were extracted, or fact verification was skipped.
      </p>
    );
  }

  const color: Record<string, string> = {
    supported: "var(--good)",
    contradicted: "var(--critical)",
    unverified: "var(--info)",
  };

  const order: Record<string, number> = { contradicted: 0, unverified: 1, supported: 2 };
  const sorted = [...facts].sort((a, b) => order[a.verdict] - order[b.verdict]);

  return (
    <ul className="space-y-2">
      {sorted.map((fact) => (
        <li
          key={fact.id}
          className="panel p-4"
          style={{ borderLeft: `3px solid ${color[fact.verdict]}` }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="rounded px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide"
              style={{ color: color[fact.verdict], border: `1px solid ${color[fact.verdict]}` }}
            >
              {fact.verdict}
            </span>
            <span className="text-xs muted">confidence {fact.confidence.toFixed(2)}</span>
          </div>
          <p className="mt-2 text-sm">{fact.claim}</p>
          {fact.notes && <p className="mt-1 text-sm muted">{fact.notes}</p>}
          {fact.evidence && (
            <blockquote
              className="mt-2 rounded px-3 py-2 text-xs"
              style={{ background: "var(--accent-soft)" }}
            >
              {fact.evidence}
            </blockquote>
          )}
          {fact.source_url && (
            <a
              href={fact.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-block truncate text-xs underline muted"
            >
              {fact.source_url}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

function FixesTab({ fixes }: { fixes: AutoFix[] }) {
  const applied = fixes.filter((f) => f.applied);
  const proposed = fixes.filter((f) => !f.applied);

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-sm font-semibold">Applied ({applied.length})</h3>
        {applied.length === 0 ? (
          <p className="panel p-4 text-sm muted">No automatic fixes were applied.</p>
        ) : (
          <ul className="space-y-2">
            {applied.map((fix) => (
              <li key={fix.id} className="panel p-4">
                <div className="text-xs muted">{fix.rule_code}</div>
                <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                  <div
                    className="rounded px-2 py-1.5 line-through"
                    style={{ background: "var(--accent-soft)", fontFamily: "var(--font-mono)" }}
                  >
                    {fix.before_text}
                  </div>
                  <div
                    className="rounded px-2 py-1.5"
                    style={{
                      background: "var(--accent-soft)",
                      color: "var(--good)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {fix.after_text || "(removed)"}
                  </div>
                </div>
                {fix.reason && <p className="mt-2 text-sm muted">{fix.reason}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">
          Needs a human ({proposed.length})
        </h3>
        <p className="mb-2 text-xs muted">
          These were not applied automatically — either they change meaning, or the target text
          was ambiguous.
        </p>
        {proposed.length === 0 ? (
          <p className="panel p-4 text-sm muted">Nothing outstanding.</p>
        ) : (
          <ul className="space-y-2">
            {proposed.slice(0, 40).map((fix) => (
              <li key={fix.id} className="panel p-3 text-sm">
                <div className="text-xs muted">{fix.rule_code}</div>
                <div className="mt-1 truncate" style={{ fontFamily: "var(--font-mono)" }}>
                  {fix.before_text}
                </div>
                {fix.skipped_reason && (
                  <p className="mt-1 text-xs muted">{fix.skipped_reason}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ArticleTab({ articles, fixes }: { articles: Article[]; fixes: AutoFix[] }) {
  const revised = articles.find((a) => a.kind === "revised");
  const original = articles.find((a) => a.kind === "original");

  if (!revised?.markdown || !original?.markdown) {
    return <p className="panel p-5 text-sm muted">No article text is available.</p>;
  }

  return (
    <RevisedArticleDiff
      original={original.markdown}
      revised={revised.markdown}
      fixes={fixes.filter((f) => f.applied)}
    />
  );
}
