import { fileURLToPath } from "node:url";
import { chromium } from "./e2e-playwright.mjs";

const extension = fileURLToPath(new URL("./.builds/privacy", import.meta.url));
const base = process.env.FAPASSWORD_BASE || "http://127.0.0.1:8799";
const context = await chromium.launchPersistentContext(`/tmp/fapassword-privacy-${Date.now()}`, {
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-first-run"],
});
const page = await context.newPage();
await page.goto(`${base}/login-standard.html`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => document.querySelector('input[name="username"]').focus());
await page.waitForTimeout(300);
const programmaticOffer = await page.locator("[data-fapassword-host]").count();
await page.evaluate(() => document.activeElement.blur());
await page.locator('input[name="username"]').click();
await page.waitForTimeout(500);
const result = await page.evaluate(() => {
  const host = document.querySelector("[data-fapassword-host]");
  return {
    hostExists: !!host,
    shadowIsClosed: !!host && host.shadowRoot === null,
    exposedText: host?.textContent || "",
  };
});
await context.close();
const pass = programmaticOffer === 0 && result.hostExists && result.shadowIsClosed && result.exposedText === "";
console.log(pass ? "PASS page cannot read account names from the closed suggestion root" : "FAIL", result);
process.exit(pass ? 0 : 1);
