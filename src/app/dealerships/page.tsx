import { redirect } from "next/navigation";
import { DealershipsManager } from "@/components/dealerships-manager";
import { getUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function DealershipsPage() {
  const user = await getUser();
  if (!user) redirect("/login");
  return <DealershipsManager />;
}
