import "server-only";

import { z } from "zod";
import { structured } from "@/lib/ai";
import type { DetectedIssue, ExtractedArticle, QaRule, Severity } from "@/lib/types";
import type { StepContext, StepOutcome } from "../runner";
import { aiRules, contextAround, loadRules, runRegexRules, runStructuralRules } from "../rules";
import { articleContext, loadExtractedArticle } from "./shared";

/**
 * Step 7: apply the QA rule library.
 *
 * Deterministic rules (regex, structural, SEO) run locally — exact and free.
 * Only judgment rules go to the model, batched into a single call with the
 * article as a cached prefix so the later steps reuse the same cache entry.
 */

const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;

const findingSchema = z.object({
  rule_code: z.string(),
  title: z.string(),
  detail: z.string(),
  evidence: z.string(),
  suggestion: z.string(),
  severity: z.enum(SEVERITIES).optional(),
  replacement: z.string().nullable().optional(),
  confident: z.boolean().optional(),
});

const responseSchema = z.object({ findings: z.array(findingSchema) });

const RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rule_code", "title", "detail", "evidence", "suggestion"],
        properties: {
          rule_code: {
            type: "string",
            description: "The exact code of the rule this finding belongs to.",
          },
          title: { type: "string", description: "One line naming the specific problem." },
          detail: { type: "string", description: "Why this is a problem in this article." },
          evidence: {
            type: "string",
            description: "The exact text from the article that triggered this finding, verbatim.",
          },
          suggestion: { type: "string", description: "The concrete change to make." },
          severity: { type: "string", enum: [...SEVERITIES] },
          replacement: {
            type: ["string", "null"],
            description:
              "Only when the fix is a mechanical substitution for `evidence` that changes " +
              "no meaning. Otherwise null.",
          },
          confident: {
            type: "boolean",
            description: "False if this is a judgment call a human should confirm.",
          },
        },
      },
    },
  },
} as const;

const SYSTEM = `You are a senior editor auditing automotive dealership content.

You will be given an article and a list of QA rules. Report every place the
article violates one of those rules — nothing else. Do not invent rules, do not
report general writing advice, and do not report a rule that is not in the list.

Hard requirements:
- \`evidence\` must be copied verbatim from the article. Never paraphrase it.
  If you cannot quote the article exactly, do not report the finding.
- \`rule_code\` must be one of the codes given to you, spelled exactly.
- Set \`replacement\` only when the fix is a mechanical substitution for the
  evidence string that a careful editor would make without thinking — a
  misspelled model name, a capitalization error. Anything requiring rewriting,
  restructuring, or a factual decision gets \`replacement: null\`.
- Set \`confident: false\` when reasonable editors would disagree.
- Report at most 4 findings per rule; pick the clearest instances.
- An article with no violations should return an empty findings array. Do not
  manufacture findings to seem thorough.`;

export async function analyzeQaRulesStep({
  db,
  job,
  warn,
}: StepContext): Promise<StepOutcome> {
  const article = await loadExtractedArticle(db, job.id);
  if (!article) return { kind: "fail", error: "No extracted article to analyze." };

  const rules = await loadRules(db, job.user_id, job.dealership_id);

  // --- deterministic pass -------------------------------------------------
  const issues: DetectedIssue[] = [
    ...runRegexRules(rules, article.text),
    ...runStructuralRules(rules, article),
  ];

  // --- judgment pass ------------------------------------------------------
  // SPEC_UNVERIFIED and FACT_NAP_MISMATCH describe checks that need the
  // crawled dealership pages, which this step does not have. They are handled
  // by verify_facts; sending them here would produce findings from the
  // article alone, which is exactly the unsourced guessing they warn about.
  const deferred = new Set(["SPEC_UNVERIFIED", "FACT_NAP_MISMATCH"]);
  const judgment = aiRules(rules).filter((rule) => !deferred.has(rule.code));

  if (judgment.length > 0) {
    try {
      const dealershipName = await dealershipLabel(db, job.dealership_id);
      const result = await structured({
        cachedContext: articleContext(article),
        system: SYSTEM,
        prompt: buildPrompt(judgment, dealershipName),
        schema: RESPONSE_JSON_SCHEMA as unknown as Record<string, unknown>,
        validator: responseSchema,
        maxTokens: 8000,
      });

      issues.push(...mapFindings(result.findings, judgment, article));
    } catch (error) {
      // A model failure shouldn't discard the deterministic findings we already
      // have. Record it and let the audit continue with what it found.
      warn(`AI rule analysis did not complete: ${(error as Error).message}`);
    }
  }

  // --- extract the specification claims for the verification step ---------
  const claims = extractClaims(article.text);

  // Clear this step's own findings before writing, so a retry replaces them
  // rather than doubling them. Link and fact findings belong to other steps
  // and are left alone.
  const owned = rules
    .filter((rule) => rule.kind !== "link" && !deferred.has(rule.code))
    .map((rule) => rule.code);

  if (owned.length > 0) {
    await db
      .from("issues")
      .delete()
      .eq("job_id", job.id)
      .eq("phase", "initial")
      .in("rule_code", owned);
  }

  if (issues.length > 0) {
    const { error } = await db.from("issues").insert(
      issues.map((issue) => ({ ...issue, job_id: job.id, phase: "initial" as const })),
    );
    if (error) return { kind: "fail", error: `Could not store issues: ${error.message}` };
  }

  return {
    kind: "advance",
    message: "Final verification...",
    state: { claims },
  };
}

function buildPrompt(rules: QaRule[], dealershipName: string | null): string {
  const list = rules
    .map(
      (rule) =>
        `### ${rule.code} (severity: ${rule.severity}, category: ${rule.category})\n` +
        `${rule.title}. ${rule.description}\n` +
        (rule.guidance ? `How to apply: ${rule.guidance}` : ""),
    )
    .join("\n\n");

  return (
    (dealershipName ? `The dealership is: ${dealershipName}.\n\n` : "") +
    `Apply these QA rules to the article:\n\n${list}\n\n` +
    `Return every violation you find, as JSON.`
  );
}

async function dealershipLabel(
  db: StepContext["db"],
  dealershipId: string | null,
): Promise<string | null> {
  if (!dealershipId) return null;
  const { data } = await db
    .from("dealerships")
    .select("name, primary_domain")
    .eq("id", dealershipId)
    .single();
  return data ? `${data.name} (${data.primary_domain})` : null;
}

/**
 * Turn model findings into issue rows.
 *
 * Two guards matter here: a finding for an unknown rule code is dropped, and a
 * finding whose evidence isn't actually in the article is dropped. Together
 * they mean a hallucinated quote can never reach the auto-fix step.
 */
function mapFindings(
  findings: z.infer<typeof findingSchema>[],
  rules: QaRule[],
  article: ExtractedArticle,
): DetectedIssue[] {
  const byCode = new Map(rules.map((rule) => [rule.code, rule]));
  const issues: DetectedIssue[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    const rule = byCode.get(finding.rule_code);
    if (!rule) continue;

    const evidence = finding.evidence.trim();
    const offset = evidence ? article.text.indexOf(evidence) : -1;
    if (offset < 0) continue; // not verbatim — treat as unreliable

    const key = `${rule.code}::${evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const canAutoFix =
      rule.fix_mode === "safe" &&
      finding.confident !== false &&
      typeof finding.replacement === "string" &&
      finding.replacement.trim().length > 0 &&
      finding.replacement.trim() !== evidence;

    issues.push({
      rule_id: rule.id,
      rule_code: rule.code,
      category: rule.category,
      severity: pickSeverity(finding.severity, rule.severity),
      title: finding.title,
      detail: finding.detail,
      evidence: contextAround(article.text, offset, evidence.length),
      suggestion: finding.suggestion,
      location: {
        offset,
        exact: evidence,
        ...(canAutoFix ? { replacement: finding.replacement!.trim() } : {}),
        ...(finding.confident === false ? { needsReview: true } : {}),
      },
      auto_fixable: canAutoFix,
    });
  }

  return issues;
}

function pickSeverity(proposed: Severity | undefined, fallback: Severity): Severity {
  return proposed && SEVERITIES.includes(proposed) ? proposed : fallback;
}

/**
 * Pull out the factual assertions worth verifying: specifications, prices,
 * contact details and dated claims. Kept deterministic so the verification step
 * always gets the same candidate set for the same article.
 */
function extractClaims(text: string): string[] {
  const patterns: RegExp[] = [
    /[^.!?\n]*\b\d{1,4}\s*(?:hp|horsepower|lb-?ft|pound-feet)\b[^.!?\n]*[.!?]/gi,
    /[^.!?\n]*\b\d{1,3}\s*(?:mpg|miles per gallon|mpge)\b[^.!?\n]*[.!?]/gi,
    /[^.!?\n]*\b(?:tow(?:ing)?|payload|cargo)\b[^.!?\n]*\b[\d,]{3,}\s*(?:lbs?|pounds|cu\.?\s?ft)\b[^.!?\n]*[.!?]/gi,
    /[^.!?\n]*\$\s?[\d,]{3,}(?:\.\d{2})?[^.!?\n]*[.!?]/g,
    /[^.!?\n]*\b\d{1,2}(?:\.\d+)?\s*%\s*APR\b[^.!?\n]*[.!?]/gi,
    /[^.!?\n]*\b\d{1,3}\s*(?:miles|mi)\s+of\s+(?:electric\s+)?range\b[^.!?\n]*[.!?]/gi,
    /[^.!?\n]*\bseat(?:s|ing)\b[^.!?\n]*\b\d{1,2}\b[^.!?\n]*[.!?]/gi,
    /[^.!?\n]*\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}[^.!?\n]*[.!?]/g,
    /[^.!?\n]*\b\d{1,5}\s+[A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+)*\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Hwy|Highway|Pkwy|Parkway|Ln|Lane)\b[^.!?\n]*[.!?]/g,
    /[^.!?\n]*\b(?:open|hours|closed)\b[^.!?\n]*\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b[^.!?\n]*[.!?]/gi,
  ];

  const claims = new Set<string>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const claim = match[0].trim().replace(/\s+/g, " ");
      if (claim.length > 20 && claim.length < 400) claims.add(claim);
    }
  }

  return [...claims].slice(0, 24);
}
