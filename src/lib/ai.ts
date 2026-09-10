import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { env } from "./env";

/**
 * Thin wrapper around the Anthropic Messages API for structured extraction.
 *
 * Two things this handles that matter in a serverless pipeline:
 *
 *  1. Structured output. The primary path uses the API's JSON-schema output
 *     format; if that is rejected (older account, model without the beta) we
 *     fall back to a prompt-enforced JSON response and salvage the object. The
 *     result is validated with Zod either way, so a malformed response fails
 *     loudly at the call site rather than corrupting an audit.
 *
 *  2. Time budget. Every call is bounded well inside the function's own
 *     maxDuration so a slow model response surfaces as a retryable step error
 *     instead of the platform killing the invocation mid-write.
 */

const REQUEST_TIMEOUT_MS = 40_000;
const STRUCTURED_OUTPUT_BETA = "structured-outputs-2025-11-13";

let cached: Anthropic | null = null;

function client(): Anthropic {
  if (!cached) {
    cached = new Anthropic({
      apiKey: env.anthropicApiKey,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 1,
    });
  }
  return cached;
}

export class AiError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "AiError";
  }
}

export interface StructuredOptions<T> {
  /** Step-specific instructions. */
  system: string;
  /** The request itself. */
  prompt: string;
  /** JSON Schema the model must satisfy. Must be an object schema. */
  schema: Record<string, unknown>;
  /** Zod schema validating the parsed result. */
  validator: z.ZodType<T>;
  /**
   * Large shared context (usually the article) placed *before* the
   * step instructions so successive steps hit the same cached prefix.
   */
  cachedContext?: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
}

export async function structured<T>(options: StructuredOptions<T>): Promise<T> {
  const {
    system,
    prompt,
    schema,
    validator,
    cachedContext,
    maxTokens = 8000,
    effort = env.aiEffort,
  } = options;

  const systemBlocks: Anthropic.Beta.BetaTextBlockParam[] = [];
  if (cachedContext) {
    systemBlocks.push({
      type: "text",
      text: cachedContext,
      cache_control: { type: "ephemeral" },
    });
  }
  systemBlocks.push({ type: "text", text: system });

  const base = {
    model: env.aiModel,
    max_tokens: maxTokens,
    system: systemBlocks,
    output_config: { effort },
    messages: [{ role: "user" as const, content: prompt }],
  };

  let text: string;

  try {
    const response = await client().beta.messages.create({
      ...base,
      betas: [STRUCTURED_OUTPUT_BETA],
      output_format: { type: "json_schema", schema },
    });
    assertNotRefused(response.stop_reason);
    text = collectText(response.content);
  } catch (error) {
    if (!isStructuredOutputUnsupported(error)) {
      throw wrap(error);
    }
    // Fall back to prompt-enforced JSON.
    try {
      const response = await client().beta.messages.create({
        ...base,
        system: [
          ...systemBlocks,
          {
            type: "text",
            text:
              "Respond with a single JSON object and nothing else — no prose, no " +
              "code fence. It must validate against this JSON Schema:\n" +
              JSON.stringify(schema),
          },
        ],
      });
      assertNotRefused(response.stop_reason);
      text = collectText(response.content);
    } catch (fallbackError) {
      throw wrap(fallbackError);
    }
  }

  const parsed = parseJsonObject(text);
  const result = validator.safeParse(parsed);
  if (!result.success) {
    throw new AiError(
      `Model response did not match the expected shape: ${result.error.message.slice(0, 400)}`,
    );
  }
  return result.data;
}

function assertNotRefused(stopReason: string | null): void {
  if (stopReason === "refusal") {
    throw new AiError("The model declined to process this content.");
  }
}

function collectText(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function isStructuredOutputUnsupported(error: unknown): boolean {
  if (!(error instanceof Anthropic.BadRequestError)) return false;
  const message = String(error.message).toLowerCase();
  return (
    message.includes("output_format") ||
    message.includes("output_config") ||
    message.includes("json_schema") ||
    message.includes("beta")
  );
}

function wrap(error: unknown): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof Anthropic.RateLimitError) {
    return new AiError("Rate limited by the Anthropic API — this step will be retried.", error);
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new AiError("ANTHROPIC_API_KEY is missing or invalid.", error);
  }
  if (error instanceof Anthropic.APIError) {
    return new AiError(`Anthropic API error ${error.status}: ${error.message}`, error);
  }
  return new AiError(`AI request failed: ${(error as Error).message}`, error);
}

/** Salvage a JSON object from a response that may carry stray prose or a fence. */
function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // fall through
    }
  }

  throw new AiError(`Could not parse JSON from the model response: ${trimmed.slice(0, 200)}`);
}

/**
 * Free-form completion, used only where the deliverable is prose (the report
 * summary). Everything analytical goes through `structured` instead.
 */
export async function prose(options: {
  system: string;
  prompt: string;
  cachedContext?: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
}): Promise<string> {
  const systemBlocks: Anthropic.Beta.BetaTextBlockParam[] = [];
  if (options.cachedContext) {
    systemBlocks.push({
      type: "text",
      text: options.cachedContext,
      cache_control: { type: "ephemeral" },
    });
  }
  systemBlocks.push({ type: "text", text: options.system });

  try {
    const response = await client().beta.messages.create({
      model: env.aiModel,
      max_tokens: options.maxTokens ?? 2000,
      system: systemBlocks,
      output_config: { effort: options.effort ?? env.aiEffort },
      messages: [{ role: "user", content: options.prompt }],
    });
    assertNotRefused(response.stop_reason);
    return collectText(response.content).trim();
  } catch (error) {
    throw wrap(error);
  }
}
