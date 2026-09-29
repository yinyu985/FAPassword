import assert from "node:assert/strict";
import { chromium } from "./e2e-playwright.mjs";
import { fileURLToPath } from "node:url";
const extension = fileURLToPath(new URL("./.builds/unlocked", import.meta.url));
const base = process.env.FAPASSWORD_BASE || "http://127.0.0.1:8799";
const context = await chromium.launchPersistentContext("unused", {
  headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  const page = await context.newPage();
  await page.goto(`${base}/login-standard.html`);
  const other = new URL("/iframe-pages/iframe-login.html", base);
  other.hostname = other.hostname === "localhost" ? "127.0.0.1" : "localhost";
  await page.evaluate((url) => {
    const frame = document.createElement("iframe"); frame.id = "xf";
    frame.width = "600"; frame.height = "300"; frame.src = url; document.body.appendChild(frame);
  }, other.href);
  const username = page.frameLocator("#xf").locator('input[name="username"]');
  await username.waitFor({ state: "visible" });
  const frame = page.frames().find((value) => value.url() === other.href);
  assert.ok(frame, "the cross-origin frame must actually load");
  // Browser metadata proves the production content script registered in that document.
  const worker = context.serviceWorkers()[0];
  await username.click();
  await page.waitForTimeout(150);
  assert.ok(await worker.evaluate(url => testNative.frames.some(f => f.url === url && f.frameId > 0 && f.documentId), other.href), "content script must register in the loaded cross-origin document");
  const before = await worker.evaluate(() => testNative.counters.names);
  await username.press("Tab");
  await username.click();
  await page.waitForTimeout(250);
  assert.equal(await frame.locator('[data-fapassword-host]').count(), 0);
  assert.equal(await worker.evaluate(() => testNative.counters.names), before);
  console.log("PASS loaded cross-origin iframe has no account query or suggestion");
} finally { await context.close(); }
