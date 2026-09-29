import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from './e2e-playwright.mjs';
const base=process.env.FAPASSWORD_BASE || 'http://127.0.0.1:8799';
const extension=fileURLToPath(new URL('./.builds/privacy',import.meta.url));
const context=await chromium.launchPersistentContext('unused',{headless:false,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--headless=new']});
try {
  const worker=context.serviceWorkers()[0];
  const page=await context.newPage();
  // The account is now the first row. Prove the attack coordinates hit a real option,
  // so a click on the non-interactive footer can never produce a false security pass.
  await page.goto(base+'/login-standard.html');await page.locator('[name=username]').click();
  const baseline=page.locator('[data-fapassword-host]');await baseline.waitFor();
  const baselinePoint=await baseline.evaluate(e=>{const r=e.getBoundingClientRect();return {x:r.left+40,y:r.top+18};});
  await page.mouse.click(baselinePoint.x,baselinePoint.y);
  await page.waitForFunction(()=>document.querySelector('[name=password]').value==='TestPass123');
  console.log('PASS closed-shadow mouse coordinates select a real account before redress');
  for(const mode of ['move-and-transparent','transform','filter','cover']) {
    await page.goto(base+'/login-standard.html');
    await page.locator('[name=username]').click();
    const host=page.locator('[data-fapassword-host]');await host.waitFor();
    assert.equal(await host.evaluate(e=>e.shadowRoot),null,'must retain the production closed Shadow DOM');
    const before=await worker.evaluate(()=>testNative.counters.passwords);
    const point=await host.evaluate((e,mode)=>{
      if(mode==='move-and-transparent'){e.style.setProperty('left','360px','important');e.style.setProperty('top','100px','important');e.style.setProperty('opacity','0','important');}
      if(mode==='transform')e.style.setProperty('transform','translate(250px, 0)','important');
      if(mode==='filter')e.style.setProperty('filter','opacity(0)','important');
      const r=e.getBoundingClientRect();
      if(mode==='cover'){const cover=document.createElement('div');cover.setAttribute('popover','manual');cover.style.cssText=`position:fixed;margin:0;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background:white`;document.documentElement.append(cover);cover.showPopover();}
      return {x:r.left+40,y:r.top+18};
    },mode);
    await page.mouse.click(point.x,point.y);await page.waitForTimeout(120);
    assert.equal(await worker.evaluate(()=>testNative.counters.passwords),before);
    assert.equal(await page.inputValue('[name=password]'),'');
    console.log('PASS closed Shadow DOM rejects real clicks on '+mode+' suggestion surface');
  }
  await page.goto(base+'/login-standard.html');await page.locator('[name=username]').click();await page.locator('[data-fapassword-host]').waitFor();
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('[name=password]').value==='TestPass123');
  console.log('PASS unmodified closed Shadow DOM remains keyboard-fillable');
} finally { await context.close(); }
