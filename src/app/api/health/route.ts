import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { appUrl, env } from "@/lib/env";
import { describeError } from "@/lib/errors";

/**
 * Configuration check, for diagnosing a deployment without running an audit.
 *
 * Reports whether each setting is present and whether the database actually
 * answers — never the values themselves, since this route is reachable by
 * anyone who can reach the app. The migration check is the useful one: a
 * project whose SQL was never run looks identical to a working one until the
 * first audit fails.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleGET() {
  const checks: Record<string, unknown> = {};
  let ok = true;

  const present = (name: string) => Boolean(process.env[name]);

  checks.env = {
    SUPABASE_URL: present("SUPABASE_URL") || present("NEXT_PUBLIC_SUPABASE_URL"),
    SUPABASE_SERVICE_ROLE_KEY: present("SUPABASE_SERVICE_ROLE_KEY"),
    INTERNAL_JOB_SECRET: present("INTERNAL_JOB_SECRET"),
    ANTHROPIC_API_KEY: present("ANTHROPIC_API_KEY"),
    FIRECRAWL_API_KEY: present("FIRECRAWL_API_KEY"),
    CRON_SECRET: present("CRON_SECRET"),
  };

  // The origin the pipeline will call back on. Wrong here means audits stall
  // after the first step with nothing in the logs.
  checks.selfUrl = appUrl();

  try {
    checks.supabaseUrl = env.supabaseUrl;
  } catch (error) {
    ok = false;
    checks.supabaseUrl = { error: describeError(error) };
  }

  if (!checks.env || !(checks.env as Record<string, boolean>).SUPABASE_SERVICE_ROLE_KEY) {
    ok = false;
  }

  try {
    const db = createAdminClient();

    const { count, error } = await db
      .from("qa_rules")
      .select("id", { count: "exact", head: true })
      .is("user_id", null);
    if (error) throw error;

    checks.database = "reachable";
    checks.builtInRules = count ?? 0;

    if ((count ?? 0) === 0) {
      ok = false;
      checks.migrations =
        "No built-in rules found. Run supabase/migrations/*.sql in order against this project.";
    } else {
      checks.migrations = "applied";
    }

    const { error: workspaceError } = await db
      .from("profiles")
      .select("id", { head: true })
      .eq("id", "00000000-0000-4000-8000-000000000001")
      .single();
    checks.workspace = workspaceError ? "missing — run 0004_single_workspace.sql" : "present";
    if (workspaceError) ok = false;
  } catch (error) {
    ok = false;
    checks.database = { error: describeError(error) };
  }

  return NextResponse.json({ ok, ...checks }, { status: ok ? 200 : 503 });
}

export const GET = apiHandler(handleGET);
