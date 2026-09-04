import { fileURLToPath } from "url";
import { chromium } from "./e2e-playwright.mjs";
import { join } from "path";
const SHOTS = fileURLToPath(new URL("./shots", import.meta.url));
const BASE = process.env.FAPASSWORD_BASE || "http://127.0.0.1:8799";

async function withExt(extPath, label, fn) {
  const ctx = await chromium.launchPersistentContext("/tmp/fapassword-prof-" + label + "-" + Date.now(), {
    headless: false,
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, "--headless=new", "--no-first-run"],
  });
  ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null));
  try { return await fn(ctx); } finally { await ctx.close(); }
}
const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail }); console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " -> " + detail}`); }
const box = (page) => page.locator('[data-fapassword="suggestions"]');
const txt = async (page) => (await box(page).count()) ? (await box(page).innerText()).replace(/\s+/g, " ").trim() : "";

const UNLOCKED = fileURLToPath(new URL("./.builds/unlocked", import.meta.url));
const LOCKED = fileURLToPath(new URL("./.builds/locked", import.meta.url));

await withExt(UNLOCKED, "unlocked", async (ctx) => {
  // single mock login auto-fills on click (mock returns 1)
  for (const pg of ["login-standard", "login-twostep", "signup", "forum"]) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/${pg}.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    await page.click('input[name="username"]').catch(() => {});
    await page.waitForTimeout(500);
    const t1 = await txt(page);
    check(`unlocked/${pg}: offer on focus`, /test@example.com/i.test(t1), `got "${t1}"`);
    await page.screenshot({ path: join(SHOTS, `v4-${pg}-offer.png`) });
    await box(page).locator("text=test@example.com").click().catch(() => {});
    await page.waitForTimeout(500);
    const val = await page.inputValue('input[name="username"]').catch(() => "");
    check(`unlocked/${pg}: fills after click`, val === "test@example.com", `value="${val}"`);
    await page.click("body");
    await page.click('input[name="username"]').catch(() => {});
    await page.waitForTimeout(300);
    check(`unlocked/${pg}: no offer when filled`, (await box(page).count()) === 0, "dropdown reappeared on filled field");
    await page.close();
  }
  for (const [pg, sel] of [["otp-multibox", 'input[name="code1"]'], ["otp-singlefield", 'input[name="otp"]']]) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/${pg}.html`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    await page.click(sel).catch(() => {});
    await page.waitForTimeout(400);
    check(`unlocked/${pg}: no dropdown on OTP`, (await box(page).count()) === 0, "dropdown appeared on OTP");
    await page.close();
  }
  const page = await ctx.newPage();
  await page.goto(`${BASE}/forum.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.click('input[name="newsletter_email"]').catch(() => {});
  await page.waitForTimeout(400);
  check(`unlocked/forum-newsletter: no dropdown`, (await box(page).count()) === 0, "false positive on newsletter");
  await page.close();
});

await withExt(LOCKED, "locked", async (ctx) => {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login-standard.html`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.click('input[name="username"]').catch(() => {});
  await page.waitForTimeout(400);
  const lockedText = await txt(page);
  check("locked: directs PIN entry to extension UI", /open fapassword to unlock/i.test(lockedText), lockedText);
  await box(page).locator("text=Open FAPassword to unlock").click().catch(() => {});
  await page.waitForTimeout(100);
  const requestedText = await txt(page);
  check("locked: unlock click requests a code or opens popup", /code ready/i.test(requestedText), requestedText);
  await page.screenshot({ path: join(SHOTS, "locked-open-popup.png") });
  await page.close();
});

const failed = results.filter(r => !r.pass);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
