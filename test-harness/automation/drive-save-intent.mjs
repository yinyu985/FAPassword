import { fileURLToPath } from "node:url";
import { chromium } from "./e2e-playwright.mjs";

const extension = fileURLToPath(new URL("./.builds/unlocked", import.meta.url));
const base = process.env.FAPASSWORD_BASE || "http://127.0.0.1:8799";
const context = await chromium.launchPersistentContext(`/tmp/fapassword-save-${Date.now()}`, {
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-first-run"],
});
const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
const page = await context.newPage();
await page.goto(`${base}/login-standard.html`, { waitUntil: "domcontentloaded" });
await page.locator('input[name="username"]').fill("user@example.com");
await page.locator('input[name="password"]').fill("not-a-real-password");

await page.evaluate(() => document.querySelector("form").requestSubmit());
await page.waitForTimeout(300);
const scripted = await worker.evaluate(() => globalThis.saveRequests || 0);

page.on("dialog", (dialog) => dialog.dismiss());
await page.locator('button[type="submit"], input[type="submit"]').first().click();
await page.waitForTimeout(300);
const userDriven = await worker.evaluate(() => globalThis.saveRequests || 0);

await context.close();
const pass = scripted === 0 && userDriven === 1;
console.log(
  pass ? "PASS scripted requestSubmit is ignored; a real user submit is accepted" : "FAIL save intent gate",
  { scripted, userDriven },
);
process.exit(pass ? 0 : 1);
