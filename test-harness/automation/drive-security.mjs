import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from './e2e-playwright.mjs';
const base = process.env.FAPASSWORD_BASE || 'http://127.0.0.1:8799';
const extension = fileURLToPath(new URL('./.builds/unlocked', import.meta.url));
const context = await chromium.launchPersistentContext('unused', {headless:false,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--headless=new'], viewport:{width:800,height:800}});
const worker = context.serviceWorkers()[0];
context.setDefaultTimeout(6000);
const results=[];
let page;
const ui=await context.newPage();
await ui.goto(new URL('popup.html',worker.url()).href);
const api = message => ui.evaluate(message => chrome.runtime.sendMessage(message),message);
const count = name => worker.evaluate(name => testNative.counters[name],name);
const wait = async predicate => { for(let i=0;i<100;i++){ if(await predicate()) return; await new Promise(r=>setTimeout(r,40)); } throw new Error('condition timed out'); };
const markup = '<form><input id="u" autocomplete="username"><input id="p" type="password" autocomplete="current-password"><button>登录</button></form>';
async function open(html=markup) {
  if(page) await page.close();
  page=await context.newPage(); await page.goto(base+'/security-regression.html');
  await page.evaluate(html=>{document.body.innerHTML=html;document.addEventListener('submit',e=>e.preventDefault());},html);
  await page.bringToFront(); await api({type:'refreshLogins'});
}
async function ticket() { const response=await api({type:'getLogins'}); assert.equal(response.ok,true,JSON.stringify(response)); return response; }
async function toolbar(username='test@example.com', targetId) { return api({type:'fillOnPage',targetId:targetId||(await ticket()).targetId,loginName:{username}}); }
async function offer(selector='#u') { await page.locator(selector).click(); await page.locator('[role=option]').first().waitFor(); }
async function inline(name='test@example.com') { await page.getByRole('option',{name,exact:true}).click(); }
async function test(name, fn) { if(process.env.FAPASSWORD_TEST_FILTER && !name.includes(process.env.FAPASSWORD_TEST_FILTER)) return; try { await fn();results.push(true);console.log('PASS '+name); } catch(error){results.push(false);console.error('FAIL '+name+' -> '+error.stack); if(page) console.error('DETAIL',await page.locator('[role=status]').allTextContents(),await worker.evaluate(()=>({counters:testNative.counters,error:testNative.error})));   } }
async function unlock() {
  await worker.evaluate(()=>{testNative.statuses={};testNative.delays={names:0,passwords:0,saves:0};});
  if ((await api({type:'retryConnection'})).state === 'unlocked') return;
  await api({type:'requestChallenge',ifNeeded:true});
  assert.equal((await api({type:'verifyPin',pin:'123456'})).ok,true);
}
try {
  for(const [name,style] of [['transparent ancestor','opacity:0'],['clipped ancestor','clip-path:inset(100%)'],['covered field','position:relative']]) {
    await test(name+' never receives a password',async()=>{
      await open('<form><input id="u" autocomplete="username"><div id="wrap" style="'+style+'"><input id="p" type="password" autocomplete="current-password">'+(name==='covered field'?'<div style="position:absolute;inset:0;background:white"></div>':'')+'</div></form>');
      await page.locator('#u').click(); const response=await toolbar();
      assert.equal(await page.inputValue('#p'),''); assert.equal(response.fields?.password,false);
    });
  }
  for(const property of ['disabled','readonly','otp','fieldset','inert']) await test(property+' password is excluded from display and fill',async()=>{
    await open('<form><input id="u" autocomplete="username"><fieldset '+(property==='fieldset'?'disabled':'')+'><input id="p" type="password" '+(property==='otp'?'autocomplete="one-time-code"':property==='disabled'?'disabled':property==='readonly'?'readonly':property==='inert'?'inert':'')+'></fieldset></form>');
    const response=await toolbar(); assert.equal(await page.inputValue('#p'),''); assert.equal(response.fields?.password,false);
    if(property==='readonly') assert.equal(response.filled,false);
  });
  await test('synchronous username input mutation blocks the password write',async()=>{
    await open(); await page.evaluate(()=>u.addEventListener('input',()=>{p.type='text';p.style.opacity='0';}));
    const result=await toolbar(); assert.equal(result.filled,false); assert.deepEqual(result.fields,{username:true,password:false}); assert.equal(await page.inputValue('#p'),'');
  });
  await test('replacement of a field after authentication begins cannot receive a password',async()=>{
    await open(); await worker.evaluate(()=>testNative.delays.passwords=350); const target=await ticket();
    const before=await count('passwords'), pending=toolbar('test@example.com',target.targetId);
    await wait(async()=>await count('passwords')>before); await page.evaluate(()=>p.outerHTML=p.outerHTML);
    const result=await pending; assert.equal(result.filled,false); assert.equal(await page.inputValue('#p'),'');
    await worker.evaluate(()=>testNative.delays.passwords=0);
  });
  await test('shown-as-text password fields fill and emit composed events',async()=>{
    await open(markup.replace('type="password"','type="text"')); const result=await toolbar();
    assert.equal(result.filled,true);assert.equal(await page.inputValue('#p'),'TestPass123');
  });
  await test('two-step username fill reports its actual stage and fields',async()=>{
    await open('<form><input id="u" autocomplete="username"><button>Next</button></form>');
    const result=await toolbar();assert.equal(result.filled,true);assert.equal(result.stage,'username');assert.deepEqual(result.fields,{username:true,password:false});
  });
  await test('toolbar follows the most recently acted-on form',async()=>{
    await open(markup+markup.replaceAll('id="u"','id="u2"').replaceAll('id="p"','id="p2"'));
    await page.locator('#u2').click();const result=await toolbar();assert.equal(result.filled,true);
    assert.equal(await page.inputValue('#p'),'');assert.equal(await page.inputValue('#p2'),'TestPass123');
  });
  await test('ambiguous untouched forms require an explicit field selection',async()=>{
    await open(markup+markup.replaceAll('id="u"','id="u2"').replaceAll('id="p"','id="p2"'));
    assert.equal((await toolbar()).errorKey,'errorChooseField');assert.equal(await count('passwords')>=0,true);
  });
  await test('new password generator leaves current-password empty',async()=>{
    await open('<form><input id="u" autocomplete="username"><input id="old" type="password" autocomplete="current-password"><input id="new" type="password" autocomplete="new-password"><input id="confirm" type="password" autocomplete="new-password"><button>Update</button></form>');
    await offer('#new');await page.locator('[data-op-generate]').first().click();
    assert.equal(await page.inputValue('#old'),'');const generated=await page.inputValue('#new');assert.ok(generated.length>=20);assert.equal(await page.inputValue('#confirm'),generated);
  });
  await test('signup controls in another form do not turn login into new-password',async()=>{
    await open(markup+'<form><input type="password"><button>Register</button></form>');
    await offer('#p');assert.equal(await page.locator('[data-op-generate]').count(),0);
  });
  await test('Shadow DOM keyboard navigation uses actual option focus and composed input events',async()=>{
    await open('<div id="component"></div>');await page.evaluate(html=>{
      component.attachShadow({mode:'open'}).innerHTML=html;window.composedInputs=0;
      document.addEventListener('input',()=>window.composedInputs++);
    },markup);
    await offer('#u');await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('[role=option]').first().evaluate(e=>e.getRootNode().activeElement===e),true);
    await page.keyboard.press('Enter');await wait(async()=>await page.locator('#p').inputValue()==='TestPass123');
    assert.equal(await page.evaluate(()=>window.composedInputs),2);
  });
  await test('suggestions fit right edge and constrain tall account lists',async()=>{
    await worker.evaluate(()=>testNative.entries=Array.from({length:30},(_,i)=>({USR:'account'+i,PWD:'test'})));
    await open();await page.evaluate(()=>{u.style.position='fixed';u.style.left='740px';u.style.width='50px';u.style.top='600px';});await offer();
    const box=await page.locator('[data-fapassword-host]').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=800&&box.y>=0&&box.y+box.height<=800,JSON.stringify(box));
    assert.equal(await page.locator('[role=listbox]').evaluate(e=>e.scrollHeight>e.clientHeight),true);
    await worker.evaluate(()=>testNative.entries=null);
  });
  await test('exact case, whitespace and zero-width usernames remain distinct end-to-end',async()=>{
    const names=['Alice','alice',' alice','alice ','ali\u200bce'];await worker.evaluate(names=>testNative.entries=names.map((USR,i)=>({USR,PWD:'secret'+i})),names);
    await open();const target=await ticket();assert.deepEqual(target.logins.map(l=>l.username),names);
    for(let i=0;i<names.length;i++){const result=await toolbar(names[i],target.targetId);assert.equal(result.filled,true);assert.equal(await page.inputValue('#u'),names[i]);assert.equal(await page.inputValue('#p'),'secret'+i);}
    await worker.evaluate(()=>testNative.entries=null);
  });
  await test('concurrent production account requests share a single native query',async()=>{
    await open();await worker.evaluate(()=>testNative.delays.names=200);const before=await count('names');
    const responses=await Promise.all(Array.from({length:8},()=>api({type:'getLogins'})));
    assert.ok(responses.every(r=>r.ok));assert.equal(await count('names')-before,1);await worker.evaluate(()=>testNative.delays.names=0);
  });
  await test('refresh invalidates names and passwords without implicitly filling',async()=>{
    await open();await toolbar();await worker.evaluate(()=>testNative.entries=[{USR:'new-account',PWD:'new-password'}]);
    const before=await count('passwords');await api({type:'refreshLogins'});const result=await ticket();
    assert.deepEqual(result.logins.map(l=>l.username),['new-account']);assert.equal(await count('passwords'),before);assert.equal(await page.inputValue('#p'),'TestPass123');
    await worker.evaluate(()=>testNative.entries=null);
  });
  await test('a stale document ticket is rejected after same-origin navigation',async()=>{
    await open();const target=await ticket();await page.goto(base+'/security-regression.html?next');
    assert.equal((await toolbar('test@example.com',target.targetId)).ok,false);
  });
  await test('navigation during native password authentication cannot fill the next document',async()=>{
    await open();await worker.evaluate(()=>testNative.delays.passwords=400);const target=await ticket();
    const before=await count('passwords'),pending=toolbar('test@example.com',target.targetId);
    await wait(async()=>await count('passwords')>before);await page.goto(base+'/security-regression.html?newdoc');await page.evaluate(html=>document.body.innerHTML=html,markup);
    assert.notEqual((await pending).filled,true);assert.equal(await page.inputValue('#p'),'');
  });
  await unlock();
  await test('native InvalidSession invalidates the UI state and requires reauthorization',async()=>{
    await open();await worker.evaluate(()=>testNative.statuses.names=9);const result=await api({type:'getLogins'});
    assert.equal(result.ok,false);assert.notEqual(result.state,'unlocked');await unlock();
  });
  await test('space in a formless login field does not submit a password; Enter does',async()=>{
    await open('<section><input id="u" autocomplete="username"><input id="p" type="password"><button type="button">登录</button></section>');
    await page.locator('#u').fill('existing');await page.locator('#p').fill('changed-password');await page.keyboard.press('Escape');
    const before=await count('saves');await page.keyboard.press('Space');await page.waitForTimeout(150);assert.equal(await count('saves'),before);
    if(process.env.FAPASSWORD_TEST_FILTER) {
      const cdp=await context.newCDPSession(page);const contexts=[];cdp.on('Runtime.executionContextCreated',e=>contexts.push(e.context));await cdp.send('Runtime.enable');
      for(const c of contexts) { const x=await cdp.send('Runtime.evaluate',{contextId:c.id,expression:'typeof surfaceValid === \"function\" ? JSON.stringify({valid:surfaceValid(), exposed:isExposed(suggestionEl), field:isFillable(anchorField), focused:document.hasFocus(), style:suggestionEl?.getAttribute(\"style\")===surfaceStyle, rect:surfaceRect, actual:suggestionEl?.getBoundingClientRect(), anchor:anchorField?.getBoundingClientRect()}) : null',returnByValue:true});if(x.result.value)console.log('SURFACE',x.result.value); }
      cdp.on('Runtime.consoleAPICalled', e=>console.log('TRACE',e.args.map(a=>a.value)));
      for(const c of contexts) await cdp.send('Runtime.evaluate',{contextId:c.id,expression:'if(typeof activate === \"function\"){ const originalActivate=activate; activate=(...a)=>{console.log(\"activate\",navIndex,surfaceValid());return originalActivate(...a)}; const originalPrepare=prepareFill; prepareFill=(...a)=>{try{return originalPrepare(...a)}catch(e){console.log(\"prepare error\",e.message);throw e}}; const originalFill=fillLogin; fillLogin=(...a)=>{console.log(\"fill login\");return originalFill(...a)};document.addEventListener(\"keydown\",e=>console.log(\"key after\",e.key,navIndex),true); }'});
      // keep diagnostics attached until this page closes

    }
    await page.keyboard.press('Enter');await wait(async()=>await count('saves')===before+1);
  });
  await test('Chinese semantic submit saves changed existing accounts and invalidates password cache',async()=>{
    await open();await toolbar();await page.locator('#p').fill('ChangedOne');const before=await count('saves');await page.locator('button').click();
    await wait(async()=>await count('saves')===before+1);await wait(async()=>(await api({type:'getState'})).saves.some(s=>s.status==='submitted'));
    await worker.evaluate(()=>testNative.entries=[{USR:'test@example.com',PWD:'ChangedOne'}]);
    const reads=await count('passwords');await toolbar();assert.equal(await count('passwords'),reads+1);assert.equal(await page.inputValue('#p'),'ChangedOne');
    await worker.evaluate(()=>testNative.entries=null);
  });
  await test('two password versions in 15 seconds both reach the native save flow',async()=>{
    await open();await page.locator('#u').fill('versioned');await page.locator('#p').fill('VersionA');const before=await count('saves');
    await page.locator('button').click();await wait(async()=>await count('saves')===before+1);
    await page.locator('#p').fill('VersionB');await page.locator('button').click();await wait(async()=>await count('saves')===before+2);
  });
  await test('same password with a different username is not suppressed as unchanged',async()=>{
    await open();await toolbar();await page.locator('#u').fill('another-user');const before=await count('saves');await page.locator('button').click();await wait(async()=>await count('saves')===before+1);
  });
  await test('save snapshot excludes hidden fields and unrelated forms',async()=>{
    await open(markup.replace('</form>','<input type="password" style="display:none" value="poison"></form>')+'<form><input autocomplete="username" value="other"><input type="password" value="other-password"></form>');
    await page.locator('#u').fill('visible-user');await page.locator('#p').fill('visible-secret');const before=await count('saves');await page.locator('button').first().click();await wait(async()=>await count('saves')===before+1);
    assert.deepEqual(await worker.evaluate(()=>testNative.saves.at(-1)),{username:'visible-user',password:'visible-secret',host:new URL(base).hostname});
  });
  await test('mismatched new and confirmation passwords do not save',async()=>{
    await open('<form><input id="u" autocomplete="username" value="confirm-user"><input type="password" autocomplete="new-password" value="one"><input type="password" autocomplete="new-password" value="two"><button>Save</button></form>');
    const before=await count('saves');await page.locator('button').click();await page.waitForTimeout(200);assert.equal(await count('saves'),before);
  });
  await test('native Shadow DOM submit events are captured in their own root',async()=>{
    await open('<div id="component"></div>');await page.evaluate(html=>{
      const root=component.attachShadow({mode:'open'});root.innerHTML=html;root.addEventListener('submit',e=>e.preventDefault());
    },markup);
    await page.locator('#u').fill('shadow-submit');await page.locator('#p').fill('shadow-secret');
    const before=await count('saves');await page.locator('button').click();await wait(async()=>await count('saves')===before+1);
  });
  await test('save is handed off before a real form navigation',async()=>{
    await open();await page.evaluate(()=>{const form=document.querySelector('form');const copy=form.cloneNode(true);copy.action='/security-regression.html';form.replaceWith(copy);});
    // Remove the test page's navigation-prevention listener by using a fresh document.
    await page.goto(base+'/security-regression.html?navigation');await page.evaluate(html=>document.body.innerHTML=html,markup.replace('<form>','<form action="/security-regression.html">'));
    await page.locator('#u').fill('navigation-save');await page.locator('#p').fill('navigation-secret');const before=await count('saves');
    await Promise.all([page.waitForURL(url=>!url.search.includes('navigation')),page.locator('button').click()]);
    await wait(async()=>await count('saves')===before+1);
  });
  await test('locked submission exposes pending state and can be cancelled',async()=>{
    await worker.evaluate(()=>testNative.invalidate());await open();await page.locator('#u').fill('queued');await page.locator('#p').fill('queued-secret');await page.locator('button').click();
    let entry;await wait(async()=>{entry=(await api({type:'getState'})).saves.find(s=>s.username==='queued');return entry?.status==='queued';});
    assert.equal(entry.messageKey,'saveWaitingUnlock');await api({type:'cancelSave',saveId:entry.id});const before=await count('saves');await unlock();assert.equal(await count('saves'),before);
  });
  await test('expired queued submissions are not sent after unlock',async()=>{
    await worker.evaluate(()=>testNative.invalidate());await open();
    const before=await count('saves');
    await page.locator('#u').fill('ttl-second');await page.locator('#p').fill('another-secret');await page.locator('button').click();
    await wait(async()=>(await api({type:'getState'})).saves.some(s=>s.username==='ttl-second'));
    await worker.evaluate(()=>{globalThis.realNow=Date.now;Date.now=()=>realNow()+180001;});
    await unlock();assert.equal(await count('saves'),before);
    assert.equal((await api({type:'getState'})).saves.find(s=>s.username==='ttl-second').status,'expired');
    await worker.evaluate(()=>{Date.now=realNow;});
  });
  await test('missing save reply remains sent and does not block fresh queries',async()=>{
    await open();await worker.evaluate(()=>testNative.dropSaveAck=true);
    await page.locator('#u').fill('uncertain');await page.locator('#p').fill('uncertain-secret');const before=await count('saves');await page.locator('button').click();
    await wait(async()=>(await api({type:'getState'})).saves.find(s=>s.username==='uncertain')?.status==='submitted');
    await api({type:'refreshLogins'});assert.equal((await api({type:'getLogins'})).ok,true);
    await page.waitForTimeout(2100);assert.equal(await count('saves'),before+1);await worker.evaluate(()=>testNative.dropSaveAck=false);
    const entry=(await api({type:'getState'})).saves.find(s=>s.username==='uncertain');await api({type:'cancelSave',saveId:entry.id});await unlock();
  });
  await test('toolbar and explicit refill retain the selected cross-origin login frame',async()=>{
    await open('<iframe id="login-frame" style="width:650px;height:300px"></iframe>');
    await page.route('https://accounts.google.com/fapassword-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body>'+markup+'</body></html>'}));
    await page.evaluate(()=>document.getElementById('login-frame').src='https://accounts.google.com/fapassword-fixture');
    const frame=page.frameLocator('#login-frame');await frame.locator('#u').click();await frame.locator('[role=option]').first().waitFor();
    const target=await ticket();assert.equal(target.host,'accounts.google.com');assert.equal((await toolbar('test@example.com',target.targetId)).filled,true);
    await frame.locator('#p').fill('manual-edit');const before=await count('passwords');await api({type:'refreshLogins'});assert.equal(await count('passwords'),before);
    assert.equal((await api({type:'refillOnPage'})).filled,true);assert.equal(await frame.locator('#p').inputValue(),'TestPass123');
  });
  await test('popup clears stale errors, names accounts accessibly and reports refresh failures',async()=>{
    await open();const before=await worker.evaluate(()=>testNative.messageCounts.getLogins||0);await ui.reload();await wait(async()=>await ui.locator('#logins button').count()===1);
    assert.equal(await worker.evaluate(()=>testNative.messageCounts.getLogins)-before,1);
    assert.match(await ui.locator('#logins button').getAttribute('aria-label'),/test@example.com/);
    assert.equal(await ui.locator('#dot').getAttribute('aria-label'),await ui.evaluate(()=>chrome.i18n.getMessage('stateUnlocked')));
    await worker.evaluate(()=>testNative.statuses.names=1);await ui.evaluate(()=>document.getElementById('refresh').click());
    await wait(async()=>await ui.locator('#refresh').isEnabled());
    assert.equal(await ui.locator('#logins button').count(),1);
    assert.equal(await ui.locator('#status-message').evaluate(el=>el.classList.contains('failed')),true);
    await worker.evaluate(()=>{testNative.statuses.names=undefined;testNative.entries=[];});
    await ui.evaluate(()=>document.getElementById('refresh').click());await wait(async()=>await ui.locator('#refresh').isEnabled());
    assert.equal(await ui.locator('#status-message').textContent(),await ui.evaluate(()=>chrome.i18n.getMessage('noLogins')));
    await worker.evaluate(()=>testNative.entries=null);
  });
  await test('policy UI requires a scoped helper and respects a forced enabled manager',async()=>{
    await open();
    await worker.evaluate(()=>testNative.policyResponse={ok:true,hidden:false,managed:true,value:true,browserName:'Current browser',scopeVersion:2});
    await ui.reload();await wait(async()=>await ui.locator('#policy-scope').textContent()!=='');
    assert.equal(await ui.locator('#policy-toggle').isDisabled(),true);assert.equal(await ui.locator('#policy-toggle').isChecked(),false);
    assert.ok((await ui.locator('#policy-scope').textContent()).includes('Current browser'));
    await worker.evaluate(()=>testNative.policyResponse={ok:true,hidden:true});await ui.reload();
    await wait(async()=>await ui.locator('#policy-note').textContent()!=='');assert.equal(await ui.locator('#policy-toggle').isDisabled(),true);
    await worker.evaluate(()=>testNative.policyResponse=null);await ui.reload();await wait(async()=>await ui.locator('#policy-toggle').isEnabled());
  });
  await test('PIN is erased on unlock and a new challenge disables verification',async()=>{
    await worker.evaluate(()=>testNative.invalidate());await api({type:'retryConnection'});await worker.evaluate(()=>testNative.delays.challenges=350);await ui.evaluate(()=>document.getElementById('newcode').click());
    assert.equal(await ui.locator('#pin').isDisabled(),true);assert.equal(await ui.locator('#verify').isDisabled(),true);assert.equal(await ui.locator('#newcode').isDisabled(),true);
    await worker.evaluate(()=>testNative.delays.challenges=0);
    // DOM assertions also cover status text and account-specific names below.
    await wait(async()=>await ui.locator('#pin').isEnabled());await ui.locator('#pin').fill('123456');await wait(async()=>await ui.locator('#view-unlocked').isVisible());assert.equal(await ui.inputValue('#pin'),'');
  });
} finally { await context.close(); }
console.log(`==== ${results.filter(Boolean).length}/${results.length} security regressions PASS ====`);
process.exitCode=results.every(Boolean)?0:1;
