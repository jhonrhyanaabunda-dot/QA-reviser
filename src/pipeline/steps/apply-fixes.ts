import "server-only";

import { checkLink } from "@/lib/http";
import { countWords } from "@/lib/extract";
import type { StepContext, StepOutcome } from "../runner";
import { loadRules } from "../rules";
import { loadExtractedArticle } from "./shared";

/**
 * Step 9: apply safe auto-fixes.
 *
 * "Safe" is a narrow definition and it is enforced here, not left to the model:
 * a fix is applied only when it is a mechanical substitution that changes no
 * meaning, its target text still appears in the article exactly once, and the
 * rule that produced it is marked `safe`. Everything else is recorded as a
 * proposal for a human — written to `auto_fixes` with `applied: false` and a
 * reason, so nothing is silently dropped.
 */

type FixCandidate = {
  issueId: string | null;
  ruleCode: string;
  before: string;
  after: string;
  reason: string;
};

export async function applyFixesStep({ db, job, warn }: StepContext): Promise<StepOutcome> {
  const article = await loadExtractedArticle(db, job.id);
  if (!article) return { kind: "fail", error: "No extracted article to revise." };

  const rules = await loadRules(db, job.user_id, job.dealership_id);
  const safeCodes = new Set(rules.filter((r) => r.fix_mode === "safe").map((r) => r.code));
  const replacements = new Map(
    rules.filter((r) => r.pattern && r.replacement !== null).map((r) => [r.code, r]),
  );

  const { data: issueRows } = await db
    .from("issues")
    .select("id, rule_code, title, location, auto_fixable, evidence")
    .eq("job_id", job.id)
    .eq("phase", "initial");

  const issues = issueRows ?? [];
  const candidates: FixCandidate[] = [];
  const skipped: FixCandidate[] = [];

  // --- 1. Model-proposed substitutions ------------------------------------
  for (const issue of issues) {
    if (!issue.auto_fixable || !issue.rule_code || !safeCodes.has(issue.rule_code)) continue;

    const location = (issue.location ?? {}) as Record<string, unknown>;
    const before = typeof location.exact === "string" ? location.exact : null;
    const after = typeof location.replacement === "string" ? location.replacement : null;
    if (!before || !after || before === after) continue;

    candidates.push({
      issueId: issue.id,
      ruleCode: issue.rule_code,
      before,
      after,
      reason: issue.title,
    });
  }

  // --- 2. Deterministic pattern replacements ------------------------------
  let text = article.text;
  let markdown = article.markdown;

  const applied: FixCandidate[] = [];

  for (const [code, rule] of replacements) {
    if (!safeCodes.has(code) || !rule.pattern || rule.replacement === null) continue;
    // Straight quotes need position-aware conversion, not a flat substitution.
    if (code === "STYLE_STRAIGHT_QUOTES") continue;

    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern, "gm");
    } catch {
      continue;
    }

    const before = markdown;
    markdown = markdown.replace(regex, rule.replacement);
    text = text.replace(regex, rule.replacement);

    if (before !== markdown) {
      applied.push({
        issueId: issues.find((i) => i.rule_code === code)?.id ?? null,
        ruleCode: code,
        before: `${countOccurrences(before, regex)} occurrence(s)`,
        after: rule.replacement || "(removed)",
        reason: rule.title,
      });
    }
  }

  // --- 3. Typographic quotes ----------------------------------------------
  if (safeCodes.has("STYLE_STRAIGHT_QUOTES")) {
    const curled = curlQuotes(markdown);
    if (curled !== markdown) {
      markdown = curled;
      text = curlQuotes(text);
      applied.push({
        issueId: issues.find((i) => i.rule_code === "STYLE_STRAIGHT_QUOTES")?.id ?? null,
        ruleCode: "STYLE_STRAIGHT_QUOTES",
        before: "straight quotes",
        after: "typographic quotes",
        reason: "Converted straight quotes and apostrophes to typographic equivalents.",
      });
    }
  }

  // --- 4. http:// → https:// where the secure URL actually works ----------
  const insecure = issues.filter(
    (issue) => issue.rule_code === "LINK_HTTP_INSECURE" && issue.auto_fixable,
  );
  for (const issue of insecure) {
    const location = (issue.location ?? {}) as Record<string, unknown>;
    const url = typeof location.url === "string" ? location.url : null;
    if (!url || !url.startsWith("http://")) continue;

    const secure = `https://${url.slice("http://".length)}`;
    const status = await checkLink(secure, { timeoutMs: 6_000 });
    const candidate: FixCandidate = {
      issueId: issue.id,
      ruleCode: "LINK_HTTP_INSECURE",
      before: url,
      after: secure,
      reason: "The https version of this link resolves, so the insecure link can be upgraded.",
    };

    if (!status.ok) {
      skipped.push({
        ...candidate,
        reason: `Left as-is: ${secure} did not respond successfully.`,
      });
      continue;
    }

    if (markdown.includes(url)) {
      markdown = markdown.split(url).join(secure);
      text = text.split(url).join(secure);
      applied.push(candidate);
    }
  }

  // --- 5. Apply the model-proposed substitutions, uniqueness-guarded ------
  for (const candidate of candidates) {
    const occurrences = markdown.split(candidate.before).length - 1;

    if (occurrences === 0) {
      skipped.push({
        ...candidate,
        reason: `Not applied: “${truncate(candidate.before)}” no longer appears in the article.`,
      });
      continue;
    }

    if (occurrences > 1) {
      skipped.push({
        ...candidate,
        reason:
          `Not applied: “${truncate(candidate.before)}” appears ${occurrences} times, so an ` +
          `automatic replacement could change the wrong one. Needs a human.`,
      });
      continue;
    }

    // split/join rather than String.replace: a replacement containing "$&"
    // or "$1" would otherwise be interpreted as a substitution pattern and
    // corrupt the text. The uniqueness check above makes this exact.
    markdown = markdown.split(candidate.before).join(candidate.after);
    text = text.split(candidate.before).join(candidate.after);
    applied.push(candidate);
  }

  // --- 6. Everything else is a proposal, not a fix ------------------------
  for (const issue of issues) {
    if (issue.auto_fixable) continue;
    const location = (issue.location ?? {}) as Record<string, unknown>;
    const before = typeof location.exact === "string" ? location.exact : issue.evidence;
    if (!before) continue;
    skipped.push({
      issueId: issue.id,
      ruleCode: issue.rule_code ?? "UNKNOWN",
      before,
      after: "",
      reason: "Requires editorial judgment — reported for review rather than auto-fixed.",
    });
  }

  const shouldPersist = job.options.applyFixes !== false;

  await db.from("auto_fixes").delete().eq("job_id", job.id);

  if (applied.length > 0 || skipped.length > 0) {
    const { error } = await db.from("auto_fixes").insert([
      ...applied.map((fix) => ({
        job_id: job.id,
        issue_id: fix.issueId,
        rule_code: fix.ruleCode,
        kind: "text_replace",
        before_text: fix.before,
        after_text: fix.after,
        reason: fix.reason,
        applied: shouldPersist,
        skipped_reason: shouldPersist ? null : "Auto-fixes were disabled for this audit.",
      })),
      ...skipped.slice(0, 100).map((fix) => ({
        job_id: job.id,
        issue_id: fix.issueId,
        rule_code: fix.ruleCode,
        kind: "proposal",
        before_text: fix.before,
        after_text: fix.after,
        reason: fix.reason,
        applied: false,
        skipped_reason: fix.reason,
      })),
    ]);
    if (error) warn(`Could not store auto-fixes: ${error.message}`);
  }

  if (applied.length > 0 && shouldPersist) {
    await db
      .from("issues")
      .update({ status: "fixed" })
      .in(
        "id",
        applied.map((fix) => fix.issueId).filter((id): id is string => Boolean(id)),
      );
  }

  const revisedText = shouldPersist ? text : article.text;
  const revisedMarkdown = shouldPersist ? markdown : article.markdown;

  const { error: articleError } = await db.from("articles").upsert(
    {
      job_id: job.id,
      kind: "revised",
      url: article.url,
      title: article.title,
      byline: article.byline,
      text: revisedText,
      markdown: revisedMarkdown,
      word_count: countWords(revisedText),
      meta: {
        metaDescription: article.metaDescription,
        headings: article.headings,
        images: article.images,
        fixesApplied: shouldPersist ? applied.length : 0,
        fixesProposed: skipped.length,
      },
    },
    { onConflict: "job_id,kind" },
  );

  if (articleError) {
    return { kind: "fail", error: `Could not save the revised article: ${articleError.message}` };
  }

  return {
    kind: "advance",
    message: "Final verification...",
  };
}

function countOccurrences(value: string, regex: RegExp): number {
  return [...value.matchAll(new RegExp(regex.source, regex.flags))].length;
}

function truncate(value: string, length = 60): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

/**
 * Straight → typographic quotes.
 *
 * Deliberately conservative: markdown link syntax, code fences and inline code
 * are left untouched so a fix can't break a URL or a snippet.
 */
export function curlQuotes(value: string): string {
  const segments = value.split(/(```[\s\S]*?```|`[^`\n]*`|\]\([^)]*\))/g);

  return segments
    .map((segment, index) => {
      // Odd indices are the captured protected segments.
      if (index % 2 === 1) return segment;
      return segment
        .replace(/(^|[\s([{<"'‘“–—])"/g, "$1“")
        .replace(/"/g, "”")
        .replace(/(\d)'/g, "$1′")
        .replace(/(^|[\s([{<"'‘“–—])'/g, "$1‘")
        .replace(/'/g, "’");
    })
    .join("");
}
