import { fileURLToPath } from "url";
import { chromium } from "./e2e-playwright.mjs";
const EXT = process.env.FAPASSWORD_EXT || fileURLToPath(new URL("./.builds/unlocked", import.meta.url));
const ctx=await chromium.launchPersistentContext("unused",{headless:false,args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`,"--headless=new","--no-first-run"]});
try {

ctx.serviceWorkers()[0]||await ctx.waitForEvent("serviceworker",{timeout:10000});
const page=await ctx.newPage(); await page.goto(`${process.env.FAPASSWORD_BASE || "http://127.0.0.1:8799"}/testbench.html`,{waitUntil:"domcontentloaded"}); await page.waitForTimeout(300);
const box=()=>page.locator('[data-fapassword="suggestions"]');
const r=[]; const ok=(n,c)=>{r.push(c);console.log((c?"PASS ":"FAIL ")+n);};
for(const [id,want] of [["#u1",true],["#u2",true],["#s1",false],["#tag1",false],["#c1",false],["#n1",false]]){
  await page.locator(id).evaluate(el => el.scrollIntoView({block:"center"}));
  await page.locator(id).click(); await page.waitForTimeout(350);
  const shown=await box().count()>0;
  ok(`${id} dropdown=${shown} (want ${want})`, shown===want);
  await page.click("h1"); await page.waitForTimeout(150);
}
await ctx.close(); const f=r.filter(x=>!x).length; console.log(`\n${r.length-f}/${r.length} PASS`); process.exitCode = (f?1:0);

} finally { await ctx.close(); }
