import "server-only";

import type { DetectedIssue } from "@/lib/types";
import type { StepContext, StepOutcome } from "../runner";
import {
  deterministicCodes,
  loadRules,
  runRegexRules,
  runStructuralRules,
  toIssueRow,
} from "../rules";
import { loadExtractedArticle } from "./shared";

/**
 * Step 10: re-audit the revised article.
 *
 * This runs the deterministic rules again over the post-fix text. Its job is to
 * prove the fixes actually worked rather than assert it — an issue that no
 * longer reproduces is marked resolved, and anything a fix introduced shows up
 * here as a new `final`-phase finding.
 */
export async function finalAuditStep({ db, job, warn }: StepContext): Promise<StepOutcome> {
  const revised = await loadExtractedArticle(db, job.id, "revised");
  const article = revised ?? (await loadExtractedArticle(db, job.id, "original"));
  if (!article) return { kind: "fail", error: "No article available for the final audit." };

  const rules = await loadRules(db, job.user_id, job.dealership_id);

  const findings: DetectedIssue[] = [
    ...runRegexRules(rules, article.text),
    ...runStructuralRules(rules, article),
  ];

  // Re-running a step must not stack duplicate rows if the previous attempt
  // got as far as inserting.
  await db.from("issues").delete().eq("job_id", job.id).eq("phase", "final");

  if (findings.length > 0) {
    const { error } = await db.from("issues").insert(
      findings.map((issue) => toIssueRow(issue, job.id, "final")),
    );
    if (error) warn(`Could not store final-audit issues: ${error.message}`);
  }

  /**
   * Mark the initial findings that no longer reproduce.
   *
   * Only deterministic rules are re-run here, so only those can be judged
   * resolved. Marking an AI finding resolved because this pass didn't look for
   * it would claim a fix that never happened — the failure mode that matters
   * most in a tool whose whole job is to be trusted about what it checked.
   */
  const rerun = deterministicCodes(rules);
  const stillPresent = new Set(findings.map(fingerprint));

  const { data: initial } = await db
    .from("issues")
    // `title` matters: fingerprint() falls back to it for findings that carry
    // no quotable evidence (thin content, missing meta description). Leaving
    // it out made every one of those compare as absent and get marked
    // resolved — while the same finding was being re-reported as open.
    .select("id, rule_code, title, evidence, location, status")
    .eq("job_id", job.id)
    .eq("phase", "initial");

  const resolved = (initial ?? [])
    .filter((issue) => {
      if (issue.status === "resolved" || issue.status === "dismissed") return false;
      if (!issue.rule_code || !rerun.has(issue.rule_code)) return false;
      return !stillPresent.has(fingerprint(issue));
    })
    .map((issue) => issue.id);

  if (resolved.length > 0) {
    await db.from("issues").update({ status: "resolved" }).in("id", resolved);
  }

  return {
    kind: "advance",
    message: `Final verification... (${findings.length} remaining)`,
  };
}

/**
 * Identity of a finding, stable across the original and revised article.
 *
 * Regex findings carry `location.match`, structural findings carry evidence or
 * nothing at all — so the fingerprint falls back through those in order and
 * ends on the title, which is deterministic for a given rule and input.
 */
function fingerprint(issue: {
  rule_code: string | null;
  evidence?: string | null;
  title?: string;
  location?: unknown;
}): string {
  const location = (issue.location ?? {}) as { exact?: string; match?: string };
  const detail = location.exact ?? location.match ?? issue.evidence ?? issue.title ?? "";
  return `${issue.rule_code ?? ""}::${detail}`;
}
