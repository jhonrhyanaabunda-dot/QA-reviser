import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabase, getUser } from "@/lib/supabase/server";
import { parseUserUrl, registrableHost } from "@/lib/url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const domainSchema = z.object({
  addDomain: z.string().min(4).max(255).optional(),
  removeDomainId: z.string().uuid().optional(),
  name: z.string().min(2).max(200).optional(),
});

/** PATCH /api/dealerships/:id — rename, or add/remove an approved domain. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { id } = await params;

  let payload: z.infer<typeof domainSchema>;
  try {
    payload = domainSchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }

  const supabase = await createServerSupabase();

  if (payload.name) {
    const { error } = await supabase
      .from("dealerships")
      .update({ name: payload.name.trim() })
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (payload.addDomain) {
    const url = parseUserUrl(payload.addDomain);
    const domain = url ? registrableHost(url.toString()) : null;
    if (!domain) {
      return NextResponse.json({ error: "Not a valid domain." }, { status: 400 });
    }
    const { error } = await supabase
      .from("dealership_domains")
      .insert({ dealership_id: id, domain, is_approved: true, max_pages: 25 });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (payload.removeDomainId) {
    const { error } = await supabase
      .from("dealership_domains")
      .delete()
      .eq("id", payload.removeDomainId)
      .eq("dealership_id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data } = await supabase
    .from("dealerships")
    .select("*, dealership_domains(id, domain, label, is_approved, max_pages)")
    .eq("id", id)
    .maybeSingle();

  return NextResponse.json({ dealership: data });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { id } = await params;
  const supabase = await createServerSupabase();
  const { error } = await supabase.from("dealerships").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: id });
}
