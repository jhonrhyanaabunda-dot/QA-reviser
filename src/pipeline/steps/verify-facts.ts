import "server-only";

import { z } from "zod";
import { structured } from "@/lib/ai";
import type { DetectedIssue } from "@/lib/types";
import type { StepContext, StepOutcome } from "../runner";
import { loadRules } from "../rules";
import { articleContext, dealershipContext, loadExtractedArticle } from "./shared";

/**
 * Step 8: verify the article's factual claims.
 *
 * Claims are checked against the dealership's own crawled pages — the only
 * source of truth this system actually has. Anything the crawl cannot confirm
 * is reported as `unverified`, never as `supported`. That distinction is the
 * whole point: the tool must not launder a guess into a verified fact.
 */

const VERDICTS = ["supported", "contradicted", "unverified"] as const;

const checkSchema = z.object({
  claim: z.string(),
  verdict: z.enum(VERDICTS),
  confidence: z.number().min(0).max(1),
  source_url: z.string().nullable(),
  evidence: z.string().nullable(),
  notes: z.string(),
});

const responseSchema = z.object({ checks: z.array(checkSchema) });

const RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["checks"],
  properties: {
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "verdict", "confidence", "source_url", "evidence", "notes"],
        properties: {
          claim: { type: "string", description: "The claim, copied from the list given to you." },
          verdict: {
            type: "string",
            enum: [...VERDICTS],
            description:
              "supported = a dealership page states this; contradicted = a dealership page " +
              "states something different; unverified = the crawled pages do not settle it.",
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          source_url: {
            type: ["string", "null"],
            description: "URL of the dealership page that settles it, or null.",
          },
          evidence: {
            type: ["string", "null"],
            description: "Verbatim quote from that page, or null.",
          },
          notes: { type: "string", description: "One sentence explaining the verdict." },
        },
      },
    },
  },
} as const;

const SYSTEM = `You verify factual claims in dealership articles against that
dealership's own website.

The dealership pages provided are your ONLY evidence. You have no other source.

- \`supported\`: a provided page states this fact. Quote it in \`evidence\` and
  give its \`source_url\`.
- \`contradicted\`: a provided page states something incompatible. Quote the
  conflicting text and give its URL. This is the highest-value verdict — an
  address, phone number, price, or set of hours that disagrees with the
  dealership's own site is a real error.
- \`unverified\`: the provided pages do not settle it. This is the correct
  verdict for manufacturer specifications, third-party rankings, and anything
  else the crawl did not cover.

Never mark a claim \`supported\` from your own knowledge. If the evidence is not
in the provided pages, the verdict is \`unverified\`. Return one entry for every
claim you are given, in the order given.`;

export async function verifyFactsStep({
  db,
  job,
  state,
  warn,
}: StepContext): Promise<StepOutcome> {
  const claims = state.claims ?? [];

  if (job.options.skipFactCheck || claims.length === 0) {
    return { kind: "advance", message: "Applying QA rules..." };
  }

  const article = await loadExtractedArticle(db, job.id);
  if (!article) return { kind: "fail", error: "No extracted article to verify." };

  // A retry replaces its previous output rather than appending to it.
  await db.from("fact_checks").delete().eq("job_id", job.id);
  await db
    .from("issues")
    .delete()
    .eq("job_id", job.id)
    .eq("phase", "initial")
    .in("rule_code", ["FACT_NAP_MISMATCH", "FACT_CONTRADICTED"]);

  const pages = await dealershipContext(db, job.id);
  if (!pages) {
    // Nothing to check against. Record the claims as unverified so the report
    // still shows what a human needs to confirm by hand.
    await db.from("fact_checks").insert(
      claims.map((claim) => ({
        job_id: job.id,
        claim,
        verdict: "unverified" as const,
        confidence: 0,
        notes: "No dealership pages were crawled, so this claim could not be checked.",
      })),
    );
    warn("No dealership pages were available, so claims were recorded as unverified.");
    return { kind: "advance", message: "Applying QA rules..." };
  }

  let checks: z.infer<typeof checkSchema>[];
  try {
    const result = await structured({
      cachedContext: articleContext(article),
      system: SYSTEM,
      prompt:
        `${pages}\n\n` +
        `Verify each of these claims from the article against the pages above:\n\n` +
        claims.map((claim, index) => `${index + 1}. ${claim}`).join("\n"),
      schema: RESPONSE_JSON_SCHEMA as unknown as Record<string, unknown>,
      validator: responseSchema,
      maxTokens: 8000,
    });
    checks = result.checks;
  } catch (error) {
    warn(`Fact verification did not complete: ${(error as Error).message}`);
    return { kind: "advance", message: "Applying QA rules..." };
  }

  const { error: writeError } = await db.from("fact_checks").insert(
    checks.map((check) => ({
      job_id: job.id,
      claim: check.claim,
      verdict: check.verdict,
      confidence: Math.round(check.confidence * 100) / 100,
      source_url: check.source_url,
      evidence: check.evidence,
      notes: check.notes,
    })),
  );
  if (writeError) warn(`Could not store fact checks: ${writeError.message}`);

  // Contradictions become issues; unverified claims stay in the report only.
  const rules = await loadRules(db, job.user_id, job.dealership_id);
  const napRule = rules.find((rule) => rule.code === "FACT_NAP_MISMATCH");

  const issues: DetectedIssue[] = checks
    .filter((check) => check.verdict === "contradicted" && check.confidence >= 0.6)
    .map<DetectedIssue>((check) => ({
      rule_id: napRule?.id ?? null,
      rule_code: napRule?.code ?? "FACT_CONTRADICTED",
      category: "accuracy",
      severity: check.confidence >= 0.85 ? "critical" : "high",
      title: "Claim contradicts the dealership website",
      detail: check.notes,
      evidence: check.evidence ?? check.claim,
      suggestion:
        check.source_url
          ? `Correct the article to match ${check.source_url}, or update the website if the article is right.`
          : "Reconcile the article with the dealership's published information.",
      location: { claim: check.claim, source: check.source_url, confidence: check.confidence },
      auto_fixable: false,
    }));

  if (issues.length > 0) {
    const { error } = await db.from("issues").insert(
      issues.map((issue) => ({ ...issue, job_id: job.id, phase: "initial" as const })),
    );
    if (error) warn(`Could not store fact-check issues: ${error.message}`);
  }

  return { kind: "advance", message: "Applying QA rules..." };
}
