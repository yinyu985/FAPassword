import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from './e2e-playwright.mjs';
const base=process.env.FAPASSWORD_BASE || 'http://127.0.0.1:8799';
const extension=fileURLToPath(new URL('./.builds/multi',import.meta.url));
const shots=fileURLToPath(new URL('./shots/',import.meta.url));await mkdir(shots,{recursive:true});
const context=await chromium.launchPersistentContext('unused',{headless:false,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--headless=new']});
try {
  const worker=context.serviceWorkers()[0];
  const page=await context.newPage();await page.goto(base+'/login-standard.html');
  const popup=await context.newPage();await popup.goto(new URL('popup.html',worker.url()).href);await page.bringToFront();await popup.reload();
  await popup.locator('#logins button').first().waitFor();
  // Keep animation-frame stability checks running while capturing the popup.
  await popup.bringToFront();
  // SPEC.md fixes the popup width at 350 CSS pixels, including at 200% zoom.
  await popup.setViewportSize({width:350,height:720});
  const evidence={};
  for(const theme of ['light','dark']) {
    await popup.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});
    await popup.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await popup.evaluate(()=>document.querySelector('details').open=true);
    evidence[theme]=await popup.evaluate(()=>{
      const css=getComputedStyle(document.documentElement),pairs=[['fg','bg'],['muted','surface'],['faint','surface-strong'],['accent','bg'],['accent-strong','accent-soft'],['danger','danger-soft'],['warning','warning-soft'],['control-on-fg','control-on']];
      const luminance = hex => {const rgb=hex.trim().slice(1).match(/../g).map(c=>parseInt(c,16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
      return Object.fromEntries(pairs.map(([fg,bg])=>{const a=luminance(css.getPropertyValue('--'+fg)),b=luminance(css.getPropertyValue('--'+bg));return [fg+'/'+bg,(Math.max(a,b)+.05)/(Math.min(a,b)+.05)];}));
    });
    for(const [pair,ratio] of Object.entries(evidence[theme])) assert.ok(ratio>=4.5,`${theme} ${pair}: ${ratio}`);
    const textContrast=await popup.evaluate(()=>{
      const parse=c=>(c.match(/[\d.]+/g)||[]).map(Number),lum=rgb=>rgb.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),results=[];
      while(walker.nextNode()) {
        const text=walker.currentNode.textContent.trim(),el=walker.currentNode.parentElement;
        if(!text||!el.getClientRects().length||el.closest('[hidden],:disabled'))continue;
        const fg=parse(getComputedStyle(el).color);let bg,disabled=false;
        for(let node=el;node;node=node.parentElement){const style=getComputedStyle(node);if(Number(style.opacity)<1)disabled=true;const candidate=parse(style.backgroundColor);if(!bg&&candidate.length>=3&&(candidate[3]??1)===1)bg=candidate;}
        if(disabled||!bg)continue;
        const a=lum(fg),b=lum(bg);results.push({text,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)});
      }
      return results;
    });
    for(const item of textContrast) assert.ok(item.ratio>=4.5,`${theme} rendered text ${item.text}: ${item.ratio}`);

    assert.equal(await popup.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await popup.locator("body").screenshot({path:shots+`popup-${theme}.png`,animations:"disabled"});
    console.log(`PASS ${theme} theme text pairs meet 4.5:1, no horizontal overflow`);
  }
  await popup.evaluate(()=>document.documentElement.style.zoom='2');await popup.setViewportSize({width:700,height:900});
  assert.equal(await popup.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await popup.locator('body').screenshot({path:shots+'popup-200-percent.png',animations:'disabled'});
  await writeFile(shots+'contrast.json',JSON.stringify(evidence,null,2)+'\n');
  console.log('PASS popup remains readable at 200 percent zoom; visual evidence captured');
} finally {await context.close();}
