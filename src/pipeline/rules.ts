import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";
import { countWords } from "@/lib/extract";
import {
  SEVERITY_WEIGHT,
  type DetectedIssue,
  type ExtractedArticle,
  type QaRule,
  type Severity,
} from "@/lib/types";

/**
 * Deterministic half of the QA engine.
 *
 * Regex and structural rules run locally — they are exact, free, and instant,
 * so they carry the checks that don't need judgment. Only the rules whose
 * `kind` is `ai` are sent to the model. This keeps token spend proportional to
 * the checks that actually need reasoning, and it means the final re-audit can
 * re-verify the deterministic findings without a second round of AI calls.
 */

/** Built-in rules plus the user's own, with user rules overriding by code. */
export async function loadRules(
  db: ReturnType<typeof createAdminClient>,
  userId: string,
  dealershipId: string | null,
): Promise<QaRule[]> {
  const { data, error } = await db
    .from("qa_rules")
    .select("*")
    .or(`user_id.is.null,user_id.eq.${userId}`)
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) throw new Error(`Could not load QA rules: ${error.message}`);

  const byCode = new Map<string, QaRule>();
  for (const row of (data ?? []) as QaRule[]) {
    // Rules scoped to a different dealership don't apply here.
    if (row.dealership_id && row.dealership_id !== dealershipId) continue;
    const existing = byCode.get(row.code);
    // A user's own rule takes precedence over the built-in of the same code.
    if (!existing || (existing.user_id === null && row.user_id !== null)) {
      byCode.set(row.code, row);
    }
  }

  return [...byCode.values()];
}

/** Rules whose findings need model judgment. */
export function aiRules(rules: QaRule[]): QaRule[] {
  return rules.filter((r) => r.kind === "ai");
}

const MAX_MATCHES_PER_RULE = 8;

/**
 * Rules with a `pattern` are evaluated here.
 *
 * A few built-ins need a count threshold rather than a per-match report
 * (one exclamation mark is fine, six is not); those are handled explicitly
 * so the rule library can stay declarative.
 */
export function runRegexRules(rules: QaRule[], text: string): DetectedIssue[] {
  const issues: DetectedIssue[] = [];

  for (const rule of rules) {
    if (rule.kind !== "regex" || !rule.pattern) continue;

    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern, "gim");
    } catch {
      // A user-authored pattern that doesn't compile shouldn't break the audit.
      continue;
    }

    const matches = [...text.matchAll(regex)].slice(0, 200);
    if (matches.length === 0) continue;

    const threshold = COUNT_THRESHOLDS[rule.code];
    if (threshold !== undefined) {
      if (matches.length <= threshold) continue;
      issues.push({
        rule_id: rule.id,
        rule_code: rule.code,
        category: rule.category,
        severity: rule.severity,
        title: rule.title,
        detail:
          threshold === 0
            ? `${matches.length} occurrence${matches.length === 1 ? "" : "s"} found.`
            : `${matches.length} occurrences found (up to ${threshold} is acceptable).`,
        evidence: contextAround(text, matches[0].index ?? 0, matches[0][0].length),
        suggestion: rule.guidance ?? rule.description,
        location: { count: matches.length },
        auto_fixable: rule.fix_mode === "safe",
      });
      continue;
    }

    for (const match of matches.slice(0, MAX_MATCHES_PER_RULE)) {
      issues.push({
        rule_id: rule.id,
        rule_code: rule.code,
        category: rule.category,
        severity: rule.severity,
        title: rule.title,
        detail: rule.description,
        evidence: contextAround(text, match.index ?? 0, match[0].length),
        suggestion: rule.guidance ?? rule.description,
        location: { offset: match.index ?? 0, match: match[0] },
        auto_fixable: rule.fix_mode === "safe" && rule.replacement !== null,
      });
    }

    if (matches.length > MAX_MATCHES_PER_RULE) {
      issues.push({
        rule_id: rule.id,
        rule_code: rule.code,
        category: rule.category,
        severity: "info",
        title: `${rule.title} — ${matches.length - MAX_MATCHES_PER_RULE} more occurrences`,
        detail: `Only the first ${MAX_MATCHES_PER_RULE} are listed individually.`,
        evidence: null,
        suggestion: rule.guidance ?? rule.description,
        location: { count: matches.length },
        auto_fixable: false,
      });
    }
  }

  return issues;
}

/**
 * Rules that report a count rather than every match.
 *
 * Two reasons a rule lands here: it is only a problem in aggregate (one
 * exclamation mark is fine, six is not), or it matches so often that per-match
 * findings would bury everything else — every straight quote in an article is
 * a match, and listing eight of them helps nobody.
 */
const COUNT_THRESHOLDS: Record<string, number> = {
  STYLE_EXCLAMATION: 1,
  AI_EM_DASH_SPAM: 2,
  STYLE_STRAIGHT_QUOTES: 0,
  STYLE_DOUBLE_SPACE: 0,
  STYLE_TRAILING_WHITESPACE: 0,
};

/** Structural, SEO and readability checks over the parsed document. */
export function runStructuralRules(
  rules: QaRule[],
  article: ExtractedArticle,
): DetectedIssue[] {
  const byCode = new Map(rules.filter((r) => r.kind === "structural").map((r) => [r.code, r]));
  const issues: DetectedIssue[] = [];

  const emit = (
    code: string,
    title: string,
    detail: string,
    extra: Partial<DetectedIssue> = {},
  ) => {
    const rule = byCode.get(code);
    if (!rule) return;
    issues.push({
      rule_id: rule.id,
      rule_code: rule.code,
      category: rule.category,
      severity: rule.severity,
      title,
      detail,
      suggestion: rule.guidance ?? rule.description,
      auto_fixable: false,
      ...extra,
    });
  };

  // --- H1 ---
  const h1s = article.headings.filter((h) => h.level === 1);
  if (h1s.length === 0) {
    emit("STRUCT_NO_H1", "Article has no H1", "No level-1 heading was found in the article body.");
  } else if (h1s.length > 1) {
    emit(
      "STRUCT_NO_H1",
      `Article has ${h1s.length} H1 headings`,
      `Expected exactly one. Found: ${h1s.map((h) => `“${h.text}”`).join(", ")}.`,
      { evidence: h1s.map((h) => h.text).join(" | ") },
    );
  }

  // --- Heading order ---
  let previous = 0;
  for (const heading of article.headings) {
    if (previous > 0 && heading.level > previous + 1) {
      emit(
        "STRUCT_HEADING_SKIP",
        `Heading jumps from H${previous} to H${heading.level}`,
        `“${heading.text}” skips a level, which breaks the document outline.`,
        { evidence: heading.text, location: { from: previous, to: heading.level } },
      );
    }
    previous = heading.level;
  }

  // --- Paragraph length ---
  const paragraphs = article.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  paragraphs.forEach((paragraph, index) => {
    const words = countWords(paragraph);
    if (words > 120) {
      emit(
        "STRUCT_WALL_OF_TEXT",
        `Paragraph ${index + 1} is ${words} words`,
        "Paragraphs over roughly 120 words are hard to scan on mobile.",
        { evidence: paragraph.slice(0, 220), location: { paragraph: index + 1, words } },
      );
    }
  });

  // --- Title length ---
  const title = article.title ?? "";
  if (!title) {
    emit("SEO_TITLE_LENGTH", "Article has no title", "No <title> or og:title was found.");
  } else if (title.length < 30 || title.length > 60) {
    emit(
      "SEO_TITLE_LENGTH",
      `Title is ${title.length} characters`,
      `Aim for 30–60 characters. Current title: “${title}”.`,
      { evidence: title, location: { length: title.length } },
    );
  }

  // --- Meta description ---
  const description = article.metaDescription ?? "";
  if (!description) {
    emit(
      "SEO_NO_META_DESCRIPTION",
      "Missing meta description",
      "Search engines will generate their own snippet, which is rarely on-message.",
    );
  } else if (description.length < 120 || description.length > 160) {
    emit(
      "SEO_NO_META_DESCRIPTION",
      `Meta description is ${description.length} characters`,
      "Aim for 120–160 characters so it renders in full.",
      { evidence: description },
    );
  }

  // --- Image alt text ---
  for (const image of article.images) {
    if (image.alt === null || image.alt.trim() === "") {
      emit(
        "SEO_IMG_NO_ALT",
        "Image is missing alt text",
        `The image at ${image.src} has no descriptive alt attribute.`,
        { evidence: image.src, location: { src: image.src } },
      );
    }
  }

  // --- Thin content ---
  if (article.wordCount < 300) {
    emit(
      "SEO_THIN_CONTENT",
      `Article is only ${article.wordCount} words`,
      "Under 300 words rarely satisfies search intent or a shopper's question.",
      { location: { wordCount: article.wordCount } },
    );
  }

  // --- Uniform paragraph rhythm (AI tell, computed not judged) ---
  const uniformRule = rules.find((r) => r.code === "AI_UNIFORM_PARAGRAPHS");
  if (uniformRule && paragraphs.length >= 5) {
    const lengths = paragraphs.map(countWords).filter((n) => n > 15);
    if (lengths.length >= 5) {
      const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
      const sd = Math.sqrt(
        lengths.reduce((sum, n) => sum + (n - mean) ** 2, 0) / lengths.length,
      );
      if (mean > 0 && sd / mean < 0.15) {
        issues.push({
          rule_id: uniformRule.id,
          rule_code: uniformRule.code,
          category: uniformRule.category,
          severity: uniformRule.severity,
          title: "Paragraphs are mechanically uniform in length",
          detail:
            `${lengths.length} body paragraphs average ${Math.round(mean)} words with only ` +
            `${Math.round(sd)} words of variation — a generation artifact rather than natural rhythm.`,
          suggestion: "Vary paragraph length: break one up, merge two others.",
          location: { mean: Math.round(mean), stdev: Math.round(sd) },
          auto_fixable: false,
        });
      }
    }
  }

  return issues;
}

export function contextAround(text: string, offset: number, length: number): string {
  const start = Math.max(0, offset - 60);
  const end = Math.min(text.length, offset + length + 60);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

/**
 * 0–100 quality score.
 *
 * Two properties the obvious "subtract a weight per issue" version does not
 * have, and that make it useless in practice:
 *
 *  - **It never saturates.** Linear subtraction bottomed out at 0 on an
 *    article with sixteen mostly-cosmetic findings, scoring it identically to
 *    one riddled with compliance violations. Halving toward zero keeps every
 *    article distinguishable from every worse one.
 *  - **Severity outranks count.** Issue count enters logarithmically, so ten
 *    missing alt attributes never outweigh a single "guaranteed approval".
 */
const HALF_LIFE = 45;

export function computeScore(issues: { severity: Severity }[]): number {
  const counts = new Map<Severity, number>();
  for (const issue of issues) {
    counts.set(issue.severity, (counts.get(issue.severity) ?? 0) + 1);
  }

  let penalty = 0;
  for (const [severity, count] of counts) {
    // 1 occurrence counts as 1, 2 as ~1.7, 10 as ~3.3, 50 as ~4.9.
    penalty += SEVERITY_WEIGHT[severity] * (1 + Math.log(count));
  }

  return Math.max(0, Math.min(100, Math.round(100 * 0.5 ** (penalty / HALF_LIFE))));
}

/** Codes evaluated deterministically — the only ones the final re-audit re-runs. */
export function deterministicCodes(rules: QaRule[]): Set<string> {
  return new Set(
    rules.filter((r) => r.kind === "regex" || r.kind === "structural").map((r) => r.code),
  );
}

/**
 * Turn a finding into an `issues` row.
 *
 * `location` and `auto_fixable` are NOT NULL with defaults, but a batch insert
 * through PostgREST pads every row out to the same key set — so one finding
 * that omits `location` sends an explicit null for all of them and the whole
 * insert is rejected. Filling the defaults here is what keeps a single
 * default-shaped finding from failing the entire step.
 */
export function toIssueRow(
  issue: DetectedIssue,
  jobId: string,
  phase: "initial" | "final",
) {
  return {
    job_id: jobId,
    phase,
    rule_id: issue.rule_id ?? null,
    rule_code: issue.rule_code,
    category: issue.category,
    severity: issue.severity,
    title: issue.title,
    detail: issue.detail ?? null,
    evidence: issue.evidence ?? null,
    suggestion: issue.suggestion ?? null,
    location: issue.location ?? {},
    auto_fixable: issue.auto_fixable ?? false,
    status: "open",
  };
}
