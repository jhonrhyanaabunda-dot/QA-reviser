import { redirect } from "next/navigation";
import { RulesManager } from "@/components/rules-manager";
import { getUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function RulesPage() {
  const user = await getUser();
  if (!user) redirect("/login");
  return <RulesManager />;
}
