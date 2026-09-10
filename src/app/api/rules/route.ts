import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabase, getUser } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  code: z.string().min(2).max(64).regex(/^[A-Z0-9_]+$/, "Use UPPER_SNAKE_CASE."),
  title: z.string().min(3).max(200),
  description: z.string().min(3).max(2000),
  category: z.string().min(2).max(60).default("style"),
  kind: z.enum(["regex", "ai", "link", "structural"]).default("ai"),
  severity: z.enum(["info", "low", "medium", "high", "critical"]).default("medium"),
  pattern: z.string().max(1000).nullable().optional(),
  replacement: z.string().max(1000).nullable().optional(),
  guidance: z.string().max(2000).nullable().optional(),
  fixMode: z.enum(["none", "safe", "suggest"]).default("suggest"),
  dealershipId: z.string().uuid().nullable().optional(),
});

const updateSchema = z.object({
  id: z.string().uuid(),
  isActive: z.boolean().optional(),
  severity: z.enum(["info", "low", "medium", "high", "critical"]).optional(),
  guidance: z.string().max(2000).nullable().optional(),
  fixMode: z.enum(["none", "safe", "suggest"]).optional(),
});

/**
 * GET /api/rules — the effective rule library plus each rule's feedback record.
 *
 * The accept/reject counts are the signal for whether a rule is pulling its
 * weight; a rule rejected far more often than accepted is miscalibrated.
 */
export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const supabase = await createServerSupabase();

  const [{ data: rules, error }, { data: feedback }] = await Promise.all([
    supabase.from("qa_rules").select("*").order("sort_order", { ascending: true }),
    supabase.from("qa_feedback").select("rule_id, verdict"),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const stats = new Map<string, { accept: number; reject: number; modify: number }>();
  for (const row of feedback ?? []) {
    if (!row.rule_id) continue;
    const entry = stats.get(row.rule_id) ?? { accept: 0, reject: 0, modify: 0 };
    entry[row.verdict] += 1;
    stats.set(row.rule_id, entry);
  }

  return NextResponse.json({
    rules: (rules ?? []).map((rule) => ({
      ...rule,
      feedback: stats.get(rule.id) ?? { accept: 0, reject: 0, modify: 0 },
    })),
  });
}

export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let payload: z.infer<typeof createSchema>;
  try {
    payload = createSchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }

  if (payload.kind === "regex") {
    if (!payload.pattern) {
      return NextResponse.json(
        { error: "A regex rule needs a pattern." },
        { status: 400 },
      );
    }
    try {
      new RegExp(payload.pattern);
    } catch (error) {
      return NextResponse.json(
        { error: `That pattern is not valid regex: ${(error as Error).message}` },
        { status: 400 },
      );
    }
  }

  if (payload.fixMode === "safe" && payload.kind === "regex" && payload.replacement === undefined) {
    return NextResponse.json(
      { error: "A regex rule set to auto-fix needs a replacement string." },
      { status: 400 },
    );
  }

  const supabase = await createServerSupabase();

  const { data, error } = await supabase
    .from("qa_rules")
    .insert({
      user_id: user.id,
      dealership_id: payload.dealershipId ?? null,
      code: payload.code,
      title: payload.title,
      description: payload.description,
      category: payload.category,
      kind: payload.kind,
      severity: payload.severity,
      pattern: payload.pattern ?? null,
      replacement: payload.replacement ?? null,
      guidance: payload.guidance ?? null,
      fix_mode: payload.fixMode,
      is_active: true,
      is_builtin: false,
      sort_order: 500,
    })
    .select("*")
    .single();

  if (error) {
    const conflict = error.code === "23505";
    return NextResponse.json(
      {
        error: conflict
          ? `You already have a rule with the code ${payload.code}.`
          : error.message,
      },
      { status: conflict ? 409 : 500 },
    );
  }

  return NextResponse.json({ rule: data }, { status: 201 });
}

/**
 * PATCH /api/rules — tune a rule.
 *
 * Built-in rules are global rows nobody owns, so toggling one off for yourself
 * clones it into a user-owned override rather than mutating the shared row.
 */
export async function PATCH(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let payload: z.infer<typeof updateSchema>;
  try {
    payload = updateSchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }

  const supabase = await createServerSupabase();

  const { data: rule } = await supabase
    .from("qa_rules")
    .select("*")
    .eq("id", payload.id)
    .maybeSingle();

  if (!rule) return NextResponse.json({ error: "Rule not found." }, { status: 404 });

  const patch = {
    ...(payload.isActive !== undefined ? { is_active: payload.isActive } : {}),
    ...(payload.severity !== undefined ? { severity: payload.severity } : {}),
    ...(payload.guidance !== undefined ? { guidance: payload.guidance } : {}),
    ...(payload.fixMode !== undefined ? { fix_mode: payload.fixMode } : {}),
  };

  if (rule.user_id === null) {
    const { data, error } = await supabase
      .from("qa_rules")
      .insert({
        user_id: user.id,
        dealership_id: rule.dealership_id,
        code: rule.code,
        title: rule.title,
        description: rule.description,
        category: rule.category,
        kind: rule.kind,
        severity: rule.severity,
        pattern: rule.pattern,
        replacement: rule.replacement,
        guidance: rule.guidance,
        fix_mode: rule.fix_mode,
        is_active: rule.is_active,
        is_builtin: false,
        sort_order: rule.sort_order,
        ...patch,
      })
      .select("*")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ rule: data, overrode: true });
  }

  const { data, error } = await supabase
    .from("qa_rules")
    .update(patch)
    .eq("id", payload.id)
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rule: data });
}

export async function DELETE(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  const supabase = await createServerSupabase();
  // RLS restricts deletes to the user's own rules, so built-ins are safe.
  const { error } = await supabase.from("qa_rules").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ deleted: id });
}
