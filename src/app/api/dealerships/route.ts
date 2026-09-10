import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/supabase/server";
import { WORKSPACE_USER_ID } from "@/lib/workspace";
import { parseUserUrl, registrableHost } from "@/lib/url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().min(2).max(200),
  primaryDomain: z.string().min(4).max(255),
  city: z.string().max(120).optional(),
  state: z.string().max(60).optional(),
  /** Extra domains the crawler is allowed to visit (inventory subdomains, etc.). */
  additionalDomains: z.array(z.string().min(4).max(255)).max(10).optional(),
});

export async function GET() {

  const supabase = db();
  const { data, error } = await supabase
    .from("dealerships")
    .select("*, dealership_domains(id, domain, label, is_approved, max_pages)")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ dealerships: data ?? [] });
}

export async function POST(request: Request) {

  let payload: z.infer<typeof schema>;
  try {
    payload = schema.parse(await request.json());
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }

  const primary = toDomain(payload.primaryDomain);
  if (!primary) {
    return NextResponse.json({ error: "Primary domain is not a valid domain." }, { status: 400 });
  }

  const supabase = db();

  const { data: dealership, error } = await supabase
    .from("dealerships")
    .insert({
      user_id: WORKSPACE_USER_ID,
      name: payload.name.trim(),
      primary_domain: primary,
      city: payload.city?.trim() || null,
      state: payload.state?.trim() || null,
      notes: null,
    })
    .select("*")
    .single();

  if (error || !dealership) {
    return NextResponse.json(
      { error: error?.message ?? "Could not create dealership." },
      { status: 500 },
    );
  }

  const domains = [primary, ...(payload.additionalDomains ?? [])]
    .map(toDomain)
    .filter((d): d is string => Boolean(d));

  const unique = [...new Set(domains)];

  const { error: domainError } = await supabase.from("dealership_domains").insert(
    unique.map((domain, index) => ({
      dealership_id: dealership.id,
      domain,
      label: index === 0 ? "primary" : null,
      is_approved: true,
      max_pages: 25,
    })),
  );

  if (domainError) {
    return NextResponse.json(
      { error: `Dealership created but domains failed: ${domainError.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ dealership, domains: unique }, { status: 201 });
}

/** Accept "example.com", "https://example.com/path" or "www.example.com". */
function toDomain(value: string): string | null {
  const url = parseUserUrl(value);
  if (!url) return null;
  return registrableHost(url.toString());
}
