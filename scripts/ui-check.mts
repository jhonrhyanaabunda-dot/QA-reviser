/**
 * Signs in against the local stack, mints the cookie @supabase/ssr expects,
 * and fetches the real pages so the authenticated UI is exercised rather than
 * assumed. Local harness only.
 */
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const APP = "http://localhost:3000";

const email = `ui+${Date.now()}@example.com`;
const password = "test-password-123";

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });

const created = await fetch(`${URL_}/auth/v1/admin/users`, {
  method: "POST",
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, email_confirm: true }),
});
const user = await created.json();

const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
const { data: signIn, error } = await anon.auth.signInWithPassword({ email, password });
if (error || !signIn.session) throw new Error(`sign-in failed: ${error?.message}`);

// @supabase/ssr stores the session as base64-<b64(json)> under sb-<ref>-auth-token.
const ref = new URL(URL_).hostname.split(".")[0];
const value = `base64-${Buffer.from(JSON.stringify(signIn.session)).toString("base64")}`;
const cookie = `sb-${ref}-auth-token=${value}`;

// Give this user something to look at.
const { data: dealership } = await admin
  .from("dealerships")
  .insert({ user_id: user.id, name: "Riverside Toyota", primary_domain: "example.com" })
  .select("id").single();
await admin.from("dealership_domains").insert({ dealership_id: dealership!.id, domain: "example.com" });

const { data: job } = await admin
  .from("audit_jobs")
  .insert({
    user_id: user.id, dealership_id: dealership!.id,
    source_url: "https://www.fueleconomy.gov/feg/bymodel/2024_Toyota_RAV4.shtml",
    status: "complete", step: "complete", progress: 100, status_message: "Audit complete",
  }).select("id").single();

await admin.from("issues").insert([
  { job_id: job!.id, rule_code: "GUARANTEE_LANGUAGE", category: "compliance", severity: "critical",
    title: "Absolute guarantee language", detail: "“guaranteed approval” creates advertising exposure.",
    evidence: "We offer guaranteed approval for every customer.", suggestion: "Replace with “subject to credit approval”.",
    location: {}, auto_fixable: false, phase: "initial" },
  { job_id: job!.id, rule_code: "SEO_IMG_NO_ALT", category: "seo", severity: "medium",
    title: "Image is missing alt text", detail: "No descriptive alt attribute.",
    location: {}, auto_fixable: false, phase: "initial" },
]);
await admin.from("audit_results").insert({
  job_id: job!.id, score: 61, final_score: 74,
  summary: "One compliance problem dominates: the article promises guaranteed approval, which needs to come out before publication.",
  totals: { issues: 2, links: { total: 19, broken: 1 }, facts: { contradicted: 0 }, fixes: { applied: 1 } },
});

const pages: [string, string[]][] = [
  // The dealership <select> is populated client-side from /api/dealerships,
  // so it is checked through that endpoint below rather than in the SSR HTML.
  ["/", ["New audit", "Start audit", "Article URL"]],
  ["/audits", ["Audits", "fueleconomy.gov"]],
  [`/audits/${job!.id}`, ["fueleconomy.gov", "Audit complete"]],
  ["/dealerships", ["Dealerships", "Add a dealership"]],
  ["/rules", ["QA rules", "New rule"]],
];

let failures = 0;
for (const [path, expect] of pages) {
  const res = await fetch(`${APP}${path}`, { headers: { cookie } });
  const html = await res.text();
  const missing = expect.filter((needle) => !html.includes(needle));
  const ok = res.status === 200 && missing.length === 0;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${res.status}  ${String(html.length).padStart(7)}B  ${path}` +
      (missing.length ? `   missing: ${missing.join(", ")}` : ""),
  );
}

const dealerships = await (await fetch(`${APP}/api/dealerships`, { headers: { cookie } })).json();
const hasDealership = (dealerships.dealerships ?? []).some(
  (d: { name: string }) => d.name === "Riverside Toyota",
);
console.log(`\n  dealerships API: ${hasDealership ? "PASS" : "FAIL"} — ${(dealerships.dealerships ?? []).length} returned`);
if (!hasDealership) failures += 1;

// The report itself is fetched client-side; check the API it calls.
const api = await fetch(`${APP}/api/audits/${job!.id}`, { headers: { cookie } });
const report = await api.json();
console.log(`\n  report API: ${api.status}  issues=${report.issues?.length}  score=${report.result?.score}/${report.result?.final_score}`);

// RLS: a second user must not be able to read the first user's audit.
const other = `ui2+${Date.now()}@example.com`;
await fetch(`${URL_}/auth/v1/admin/users`, {
  method: "POST",
  headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
  body: JSON.stringify({ email: other, password, email_confirm: true }),
});
const { data: signIn2 } = await anon.auth.signInWithPassword({ email: other, password });
const cookie2 = `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(signIn2.session)).toString("base64")}`;
const leak = await fetch(`${APP}/api/audits/${job!.id}`, { headers: { cookie: cookie2 } });
const leakBody = await leak.json();
const isolated = leak.status === 404 || leakBody.error;
console.log(`  RLS isolation: ${isolated ? "PASS" : "FAIL"} — other user got ${leak.status} ${JSON.stringify(leakBody).slice(0, 80)}`);

process.exit(failures === 0 && isolated ? 0 : 1);
