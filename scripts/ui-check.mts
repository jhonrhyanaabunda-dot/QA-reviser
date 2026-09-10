/**
 * Fetches every page of the running app and checks it renders.
 *
 * There is no login, so this is a plain HTTP sweep. It also asserts the
 * stylesheet resolves: an earlier version checked only for text and happily
 * passed while the site was serving completely unstyled HTML.
 *
 * Local harness; not part of the deployment.
 */
const APP = process.env.APP_URL ?? "http://localhost:3000";

const pages: [string, string[]][] = [
  ["/", ["New audit", "Start audit", "Article URL"]],
  ["/audits", ["Audits"]],
  ["/dealerships", ["Dealerships", "Add a dealership"]],
  ["/rules", ["QA rules", "New rule"]],
];

let failures = 0;

for (const [path, expect] of pages) {
  const res = await fetch(`${APP}${path}`);
  const html = await res.text();
  const missing = expect.filter((needle) => !html.includes(needle));
  const ok = res.status === 200 && missing.length === 0;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${res.status}  ${String(html.length).padStart(7)}B  ${path}` +
      (missing.length ? `   missing: ${missing.join(", ")}` : ""),
  );
}

// The stylesheet has 404'd twice from a stale dev cache while every text
// assertion still passed, so it is checked explicitly.
const home = await (await fetch(`${APP}/`)).text();
const href = home.match(/\/_next\/static\/css\/[^"?]+/)?.[0];
if (!href) {
  console.log("  FAIL  no stylesheet link in the page");
  failures += 1;
} else {
  const css = await fetch(`${APP}${href}`);
  const body = await css.text();
  const styled = css.status === 200 && body.includes(".panel");
  if (!styled) failures += 1;
  console.log(`  ${styled ? "PASS" : "FAIL"}  ${css.status}  ${String(body.length).padStart(7)}B  ${href}`);
}

const api = await fetch(`${APP}/api/rules`);
const rules = await api.json();
console.log(`\n  rules API: ${api.status}  ${rules.rules?.length ?? 0} rules loaded`);
if (api.status !== 200) failures += 1;

process.exit(failures === 0 ? 0 : 1);
