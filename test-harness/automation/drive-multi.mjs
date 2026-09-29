import { fileURLToPath } from "url";
import { chromium } from "./e2e-playwright.mjs";
const EXT = process.env.FAPASSWORD_EXT || fileURLToPath(new URL("./.builds/multi", import.meta.url));
const ctx=await chromium.launchPersistentContext("unused",{headless:false,args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,"--headless=new","--no-first-run"]});
try {

ctx.serviceWorkers()[0]||await ctx.waitForEvent("serviceworker",{timeout:10000});
const page=await ctx.newPage(); await page.goto(`${process.env.FAPASSWORD_BASE || "http://127.0.0.1:8799"}/login-standard.html`,{waitUntil:"domcontentloaded"}); await page.waitForTimeout(300);
const box=()=>page.locator('[data-fapassword="suggestions"]');
await page.click('input[name="username"]'); await page.waitForTimeout(400);
const t=(await box().count())?(await box().innerText()).replace(/\s+/g," "):"";
const both = /alice@example\.com/.test(t) && /bob@work\.com/.test(t);
console.log(both?"PASS multi-account chooser shows both":"FAIL", `-> "${t}"`);
await ctx.close(); process.exitCode = (both?0:1);

} finally { await ctx.close(); }
