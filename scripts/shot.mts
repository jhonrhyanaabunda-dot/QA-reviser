/**
 * Screenshot the running app.
 *
 * Drives headless Chrome over the DevTools Protocol, which is what makes it
 * possible to click a control before capturing so tabbed views can be
 * screenshotted. Local harness; not part of the deployment.
 *
 *   npx tsx scripts/shot.mts <out-dir> [path ...]
 *
 * A path may carry a "#click=<button text>" suffix to press a control before
 * capturing, so tabbed views can be screenshotted:
 *   npx tsx scripts/shot.mts /tmp/shots "/audits/abc#click=Revised article"
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const APP = "http://localhost:3000";

const outDir = process.argv[2] ?? "/tmp/shots";
const paths = process.argv.slice(3);
mkdirSync(outDir, { recursive: true });

// --- chrome ---------------------------------------------------------------
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--hide-scrollbars",
  "--user-data-dir=/tmp/qa-chrome-profile",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let target: { webSocketDebuggerUrl: string } | undefined;
for (let i = 0; i < 40 && !target; i += 1) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t: { type: string }) => t.type === "page");
  } catch {
    /* not up yet */
  }
}
if (!target) throw new Error("Chrome did not expose a debugging target");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map<number, (value: Record<string, unknown>) => void>();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg.result ?? {});
    pending.delete(msg.id);
  }
});

function send(method: string, params: Record<string, unknown> = {}) {
  const id = nextId++;
  return new Promise<Record<string, unknown>>((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1280, height: 900, deviceScaleFactor: 2, mobile: false,
});

for (const spec of paths) {
  const [path, click] = spec.split("#click=");
  await send("Page.navigate", { url: `${APP}${path}` });
  await sleep(2200);

  if (click) {
    await send("Runtime.evaluate", {
      expression: `
        (() => {
          const target = [...document.querySelectorAll("button")]
            .find((b) => b.textContent.trim().startsWith(${JSON.stringify(click)}));
          if (target) { target.click(); return true; }
          return false;
        })()
      `,
    });
    await sleep(1200);
  }
  const { data: png } = (await send("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: true,
  })) as { data: string };
  const label = click ? `_${click.replace(/[^\w]/g, "")}` : "";
  const name = (path.replace(/^\//, "").replace(/[^\w.-]/g, "_") || "home") + label + ".png";
  writeFileSync(`${outDir}/${name}`, Buffer.from(png, "base64"));
  console.log(`  ${outDir}/${name}`);
}

ws.close();
chrome.kill();
