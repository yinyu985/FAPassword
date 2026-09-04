import { fileURLToPath } from "url";
import { chromium } from "./e2e-playwright.mjs";
const EXT = process.env.FAPASSWORD_EXT || fileURLToPath(new URL("./.builds/unlocked", import.meta.url));
const ctx=await chromium.launchPersistentContext("/tmp/fapassword-cj-"+Date.now(),{headless:false,args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,"--headless=new","--no-first-run"]});
ctx.serviceWorkers()[0]||await ctx.waitForEvent("serviceworker",{timeout:10000}).catch(()=>null);
const page=await ctx.newPage();
await page.goto("http://127.0.0.1:8799/clickjack.html",{waitUntil:"domcontentloaded"}); await page.waitForTimeout(300);
await page.evaluate(() => {
  const hidden = document.createElement("input");
  hidden.type = "password";
  hidden.name = "display-none-password";
  hidden.style.display = "none";
  document.querySelector("form").appendChild(hidden);
});
const box=()=>page.locator('[data-fapassword="suggestions"]');
await page.click('input[name=username]'); await page.waitForTimeout(400);
const offered = await box().count()>0;
if(offered){ await box().locator("text=test@example.com").click(); await page.waitForTimeout(600); }
const pval=await page.inputValue('input[name=password]').catch(()=>"");
const hiddenValue=await page.inputValue('input[name="display-none-password"]').catch(()=>"");
// pass if hidden password not filled - visibility guard blocks exfil
const pass = pval==="" && hiddenValue==="";
console.log(`offered on username: ${offered}; offscreen filled: ${!!pval}; display:none filled: ${!!hiddenValue}`);
console.log(pass?"PASS #18 hidden password field not filled (clickjack defense)":"FAIL clickjack: hidden field got filled");
await ctx.close(); process.exit(pass?0:1);
