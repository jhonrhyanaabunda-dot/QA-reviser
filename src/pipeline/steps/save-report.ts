import "server-only";

import { prose } from "@/lib/ai";
import { SEVERITY_ORDER, type Severity } from "@/lib/types";
import type { StepContext, StepOutcome } from "../runner";
import { computeScore } from "../rules";
import { loadExtractedArticle } from "./shared";

/**
 * Step 11: assemble and save the report.
 *
 * Every number in the report is computed from stored rows, not from the model.
 * The model writes only the narrative summary, and only after the totals exist —
 * so the prose can never disagree with the table above it.
 */
export async function saveReportStep({ db, job, state, warn }: StepContext): Promise<StepOutcome> {
  const [original, revised] = await Promise.all([
    loadExtractedArticle(db, job.id, "original"),
    loadExtractedArticle(db, job.id, "revised"),
  ]);

  const [{ data: issues }, { data: links }, { data: facts }, { data: fixes }, { data: pages }] =
    await Promise.all([
      db.from("issues").select("*").eq("job_id", job.id),
      db.from("link_checks").select("*").eq("job_id", job.id),
      db.from("fact_checks").select("*").eq("job_id", job.id),
      db.from("auto_fixes").select("*").eq("job_id", job.id),
      db.from("crawled_pages").select("url").eq("job_id", job.id),
    ]);

  const initialIssues = (issues ?? []).filter((i) => i.phase === "initial");
  const finalIssues = (issues ?? []).filter((i) => i.phase === "final");

  const severityCounts = countBy(initialIssues.map((i) => i.severity as Severity));
  const categoryCounts = countBy(initialIssues.map((i) => i.category));

  const linkRows = links ?? [];
  const factRows = facts ?? [];
  const fixRows = fixes ?? [];

  const score = computeScore(initialIssues);
  const finalScore = computeScore(finalIssues);

  const totals = {
    issues: initialIssues.length,
    issuesResolved: initialIssues.filter((i) => i.status === "resolved").length,
    issuesRemaining: finalIssues.length,
    bySeverity: severityCounts,
    byCategory: categoryCounts,
    links: {
      total: linkRows.length,
      internal: linkRows.filter((l) => l.link_type === "internal").length,
      external: linkRows.filter((l) => l.link_type === "external").length,
      dealership: linkRows.filter((l) => l.is_dealership).length,
      broken: linkRows.filter((l) => !l.ok).length,
    },
    facts: {
      total: factRows.length,
      supported: factRows.filter((f) => f.verdict === "supported").length,
      contradicted: factRows.filter((f) => f.verdict === "contradicted").length,
      unverified: factRows.filter((f) => f.verdict === "unverified").length,
    },
    fixes: {
      applied: fixRows.filter((f) => f.applied).length,
      proposed: fixRows.filter((f) => !f.applied).length,
    },
    dealershipPagesCrawled: (pages ?? []).length,
    wordCount: {
      original: original?.wordCount ?? 0,
      revised: revised?.wordCount ?? 0,
    },
    warnings: state.warnings ?? [],
  };

  let summary = fallbackSummary(totals, score, finalScore);
  try {
    summary = await prose({
      system:
        `You write the executive summary of an automotive content QA report for the ` +
        `editor who has to act on it.\n\n` +
        `Write 3–5 sentences of plain prose. Lead with the most consequential finding. ` +
        `Name specific problems rather than categories. State what a human still needs ` +
        `to decide. Do not restate the counts — they are already in the table. No ` +
        `headings, no bullet points, no preamble.`,
      prompt: buildSummaryPrompt(totals, initialIssues, factRows, score, finalScore),
      maxTokens: 700,
      effort: "low",
    });
  } catch (error) {
    warn(`Report summary was generated locally: ${(error as Error).message}`);
  }

  const { error } = await db.from("audit_results").upsert(
    {
      job_id: job.id,
      score,
      final_score: finalScore,
      summary,
      totals,
      report: {
        generatedAt: new Date().toISOString(),
        sourceUrl: job.source_url,
        title: original?.title ?? null,
        renderMode: state.renderMode ?? "fetch",
        topIssues: initialIssues
          .slice()
          .sort(
            (a, b) =>
              SEVERITY_ORDER.indexOf(a.severity as Severity) -
              SEVERITY_ORDER.indexOf(b.severity as Severity),
          )
          .slice(0, 10)
          .map((i) => ({
            code: i.rule_code,
            severity: i.severity,
            title: i.title,
            evidence: i.evidence,
          })),
      },
    },
    { onConflict: "job_id" },
  );

  if (error) return { kind: "fail", error: `Could not save the report: ${error.message}` };

  return { kind: "advance", message: "Audit complete" };
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function buildSummaryPrompt(
  totals: Record<string, unknown>,
  issues: { severity: string; title: string; rule_code: string | null; detail: string | null }[],
  facts: { verdict: string; claim: string; notes: string | null }[],
  score: number,
  finalScore: number,
): string {
  const ranked = issues
    .slice()
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity as Severity) -
        SEVERITY_ORDER.indexOf(b.severity as Severity),
    )
    .slice(0, 15)
    .map((i) => `- [${i.severity}] ${i.rule_code}: ${i.title}${i.detail ? ` — ${i.detail}` : ""}`)
    .join("\n");

  const contradictions = facts
    .filter((f) => f.verdict === "contradicted")
    .map((f) => `- ${f.claim} — ${f.notes ?? ""}`)
    .join("\n");

  return [
    `Score before fixes: ${score}/100. Score after fixes: ${finalScore}/100.`,
    `Totals: ${JSON.stringify(totals)}`,
    ranked ? `\nMost severe findings:\n${ranked}` : "\nNo issues were found.",
    contradictions ? `\nClaims contradicting the dealership site:\n${contradictions}` : "",
  ].join("\n");
}

function fallbackSummary(
  totals: { issues: number; links: { broken: number }; facts: { contradicted: number } },
  score: number,
  finalScore: number,
): string {
  const parts = [
    `The audit found ${totals.issues} issue${totals.issues === 1 ? "" : "s"} and scored the article ${score}/100 before fixes and ${finalScore}/100 after.`,
  ];
  if (totals.links.broken > 0) {
    parts.push(`${totals.links.broken} link${totals.links.broken === 1 ? "" : "s"} did not resolve.`);
  }
  if (totals.facts.contradicted > 0) {
    parts.push(
      `${totals.facts.contradicted} claim${totals.facts.contradicted === 1 ? "" : "s"} contradicted the dealership website and need${totals.facts.contradicted === 1 ? "s" : ""} a human decision.`,
    );
  }
  return parts.join(" ");
}
