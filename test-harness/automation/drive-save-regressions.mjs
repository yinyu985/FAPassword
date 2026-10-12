import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from './e2e-playwright.mjs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const source = await readFile(root+'/src/content.js','utf8');
const built = await readFile(root+'/test-harness/automation/.builds/unlocked/src/content.js','utf8');
const expected = source.replace('attachShadow({ mode: "closed" })','attachShadow({ mode: "open" })')
  .replace('box.setAttribute("role", "listbox");','box.setAttribute("role", "listbox"); box.setAttribute("data-fapassword", "suggestions");');
if(built !== expected) throw new Error('Review mock build does not match current content code');
if(!Buffer.from(await readFile(root+'/src/background.bundle.js')).equals(await readFile(root+'/test-harness/automation/.builds/unlocked/src/background.bundle.js'))) throw new Error('Review background is stale');
const server=createServer((request,response)=>{
  response.writeHead(200,{'Content-Type':'text/html'});
  response.end('<!doctype html><meta charset="utf-8"><style>body{margin:32px} input,button,[role=button]{display:block;width:240px;height:32px;margin:8px}</style>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
let context;
const reports=[];
try {
  context=await chromium.launchPersistentContext('',{headless:true,args:[`--disable-extensions-except=${root}/test-harness/automation/.builds/unlocked`,`--load-extension=${root}/test-harness/automation/.builds/unlocked`]});
  context.setDefaultTimeout(5000);
  const worker=context.serviceWorkers()[0];
  const ui=await context.newPage();await ui.goto(new URL('popup.html',worker.url()).href);
  const api=message=>ui.evaluate(message=>chrome.runtime.sendMessage(message),message);
  const counts=()=>worker.evaluate(()=>({snapshots:testNative.messageCounts.resolveSave||0,native:testNative.counters.saves}));
  const page=await context.newPage();
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let index=0;
  const standard=(button='<button>Login</button>',username='')=>'<form><input id="u" autocomplete="username" value="'+username+'"><input id="p" type="password" autocomplete="current-password" value="Fixture123">'+button+'</form>';
  async function test(name,expectedNative,html,action,setup,extra={}) {
    if(process.env.FAPASSWORD_REVIEW_FILTER&&!name.includes(process.env.FAPASSWORD_REVIEW_FILTER))return;
    const username='review-'+(++index);
    await page.goto(base+'/case-'+index);await page.evaluate(({html,username})=>{
      document.body.innerHTML=html.replaceAll('REVIEW_USER',username);
      window.review={submits:0,actions:0,composing:null};
      document.addEventListener('submit',event=>{event.preventDefault();window.review.submits++;});
    },{html,username});
    await page.bringToFront();
    if(setup)await setup(page,api,worker);
    const before=await counts();
    await action(page,api,worker);
    await sleep(250);
    const after=await counts();
    const state=await api({type:'getState'});
    const result={name,expectedNative,actualNative:after.native-before.native,snapshots:after.snapshots-before.snapshots,
      form:await page.evaluate(()=>window.review),saveStates:(state.saves||[]).filter(s=>s.username===username||s.username==='').map(s=>({status:s.status,messageKey:s.messageKey})),
      inlineNotices:await page.locator('[role=status]').count(),fallbackNotices:await page.locator('[data-fapassword-notice]').count(),...extra};
    if(extra.compareFinalPassword){
      const finalPassword=await page.evaluate(()=>window.reviewSubmittedPassword);
      const nativePassword=await worker.evaluate(()=>testNative.saves.at(-1)?.password);
      result.passwordMatchesFinalSubmittedValue=finalPassword===nativePassword;
    }
    result.matchesExpected=result.actualNative===expectedNative && result.passwordMatchesFinalSubmittedValue !== false;
    if(extra.expectedInlineError) result.matchesExpected &&= result.inlineNotices > 0 || result.fallbackNotices > 0;
    if(name.startsWith('FALLBACK') && expectedNative===0) result.matchesExpected &&= (state.saves||[]).some(s=>s.status==='needsAccount');
    reports.push(result);console.log(JSON.stringify(result));
    for(const save of state.saves||[]) await api({type:'cancelSave',saveId:save.id});
  }
  const click=page=>page.locator('button').first().click();
  await test('CONTROL native login submit',1,standard(undefined,'REVIEW_USER'),click);
  await test('CONTROL typing only does not save',0,standard(undefined,'REVIEW_USER'),page=>page.locator('#p').fill('ManuallyTyped123'));
  await test('CONTROL OTP is excluded',0,'<form><input autocomplete="username" value="REVIEW_USER"><input type="password" autocomplete="one-time-code" value="123456"><button>Verify</button></form>',click);
  await test('CONTROL invalid required field blocks save',0,standard(undefined,'REVIEW_USER').replace('</form>','<input required></form>'),click);
  await test('CONTROL different confirmation blocks save',0,'<form><input autocomplete="username" value="REVIEW_USER"><input type="password" autocomplete="new-password" value="First123"><input type="password" autocomplete="new-password" value="Second123"><button>Create account</button></form>',click);
  await test('FALSE POSITIVE cancelled registration',0,standard('<button type="button">取消注册</button>','REVIEW_USER'),click,page=>page.evaluate(()=>document.querySelector('button').addEventListener('click',()=>window.review.actions++)));
  await test('FALSE POSITIVE Continue only changes wizard step',0,standard('<button type="button">Continue</button>','REVIEW_USER'),click,page=>page.evaluate(()=>document.querySelector('button').addEventListener('click',()=>window.review.actions++)));
  await test('FALSE POSITIVE custom JS validation rejects registration',0,standard('<button type="button">Create account</button>','REVIEW_USER'),click,page=>page.evaluate(()=>document.querySelector('button').addEventListener('click',event=>{event.preventDefault();window.review.actions++;})));
  await test('FALSE POSITIVE password hint saved as password',0,'<form><input autocomplete="username" value="REVIEW_USER"><input name="passwordHint" type="text" value="a hint, not a password"><button>Save profile</button></form>',click);
  await test('FALSE POSITIVE Enter with no implicit submit',0,standard('','REVIEW_USER'),async page=>{await page.locator('#p').focus();await page.keyboard.press('Enter');});
  await test('FALSE POSITIVE Enter in an unchanged formless field',0,standard('<button type="button">Login</button>','REVIEW_USER').replaceAll('form>','section>'),async page=>{await page.locator('#p').focus();await page.keyboard.press('Enter');});
  await test('MISSED readonly username',1,standard(undefined,'REVIEW_USER').replace('id="u"','id="u" readonly'),click);
  await test('FALLBACK untrusted hidden username requires account confirmation',0,standard(undefined,'REVIEW_USER').replace('id="u"','id="u" type="hidden"'),click);
  await test('MISSED phone username',1,'<form><input id="u" type="tel" name="phone" value="13800000000"><input id="p" type="password" value="Fixture123"><button>Login</button></form>',click);
  await test('MISSED explicit current-password overridden by passcode hint',1,standard(undefined,'REVIEW_USER').replace('id="p"','id="p" name="passcode"'),click);
  await test('MISSED Chinese account label without autocomplete',1,'<form><label>账号<input id="u" name="account" value="REVIEW_USER"></label><input type="password" value="Fixture123"><button>登录</button></form>',click);
  await test('MISSED separate username step after trusted autofill',1,'<form><input id="u" autocomplete="username"><button>Next</button></form>',click,async(page,api)=>{
    const result=await api({type:'getLogins'});const fill=await api({type:'fillOnPage',targetId:result.targetId,loginName:{username:'test@example.com'}});
    if(!fill.filled)throw new Error('two-step fixture autofill failed');
    await page.evaluate(()=>document.querySelector('form').innerHTML='<input id="p" type="password" value="Fixture123"><button>Login</button>');
  });
  await test('MISSED trusted manual username survives a replaced next-step form',1,'<form><input id="u" autocomplete="username"><button type="button">Next</button></form>',async page=>{
    await page.locator('#u').fill('manual-stage-account');await page.locator('button').click();await page.locator('button').click();
  },page=>page.evaluate(()=>document.querySelector('button').addEventListener('click',()=>{
    document.querySelector('form').outerHTML='<form><input id="p" type="password" value="Fixture123"><button>Login</button></form>';
  })));
  await test('FALLBACK two identity fields require account confirmation',0,'<form><input autocomplete="username" value="REVIEW_USER"><input type="email" name="email" value="test@example.test"><input type="password" autocomplete="new-password" value="Fixture123"><button>Create account</button></form>',click);
  await test('MISSED generated-password context lost after autocomplete removal',1,'<form><input autocomplete="username" value="REVIEW_USER"><input id="p" type="password" autocomplete="new-password"><input id="c" type="password" autocomplete="new-password"><div role="button" tabindex="0" aria-label="Create account">Create account</div></form>',page=>page.locator('[role=button]').click(),async page=>{
    await page.locator('#p').click();await page.locator('[data-op-generate]').first().waitFor();await page.locator('[data-op-generate]').first().click();
    await page.evaluate(()=>{
      document.querySelector('#p').removeAttribute('autocomplete');document.querySelector('#c').removeAttribute('autocomplete');
      document.querySelector('[role=button]').addEventListener('click',()=>document.querySelector('form').remove());
    });
  });
  await test('BOUNDARY unlabeled JS control is not guessed',0,standard('<button type="button" id="finish-action">完成</button>','REVIEW_USER'),click,page=>page.evaluate(()=>document.querySelector('button').addEventListener('click',()=>window.review.actions++)));
  await test('FALLBACK generated password can be confirmed through the popup',1,'<form><input autocomplete="username" value="REVIEW_USER"><input id="p" type="password" autocomplete="new-password"><button type="button">完成</button></form>',async(page,api,worker)=>{
    await page.locator('#p').click();await page.locator('[data-op-generate]').first().click();
    const generated=await page.inputValue('#p');
    await page.locator('button').click();await sleep(100);
    const state=await api({type:'getState'});assert.equal(state.saves.at(-1).status,'review');
    const cdp=await context.newCDPSession(page);const worlds=[];cdp.on('Runtime.executionContextCreated',e=>worlds.push(e.context));await cdp.send('Runtime.enable');
    let tested=false;
    for(const world of worlds){const probe=await cdp.send('Runtime.evaluate',{contextId:world.id,expression:'typeof documentKey === "string"',returnByValue:true});if(probe.result.value){
      const access=await cdp.send('Runtime.evaluate',{contextId:world.id,expression:'(async()=>{try{await chrome.storage.session.get("pendingCredentialSavesV1");return true;}catch{return false;}})()',awaitPromise:true,returnByValue:true});
      assert.equal(access.result.value,false,'content must not read browser-memory pending passwords');tested=true;
    }}assert.equal(tested,true);
    await ui.bringToFront();const item=ui.locator('#save-list li').last();await item.locator('button').first().click();await sleep(100);
    assert.equal(await worker.evaluate(()=>testNative.saves.at(-1).password),generated);
  });
  await test('FALLBACK missing account can be supplied through the popup',1,standard(undefined,''),async(page,api)=>{
    await click(page);await sleep(100);await ui.bringToFront();
    const item=ui.locator('#save-list li').last();await item.locator('input').fill('explicit-account');await item.locator('button').first().click();
  });
  await test('FALLBACK editing a generated password blocks mismatched confirmation and updates the candidate',1,'<form><input autocomplete="username" value="REVIEW_USER"><input id="p" type="password" autocomplete="new-password"><input id="c" type="password" autocomplete="new-password"><button type="button">完成</button></form>',async(page,api,worker)=>{
    await page.locator('#p').click();await page.locator('[data-op-generate]').first().click();
    await page.locator('#p').fill('EditedFixture123');await sleep(100);
    assert.equal((await api({type:'getState'})).saves.at(-1).status,'blocked');
    await page.locator('#c').fill('EditedFixture123');await sleep(100);
    assert.equal((await api({type:'getState'})).saves.at(-1).status,'review');
    await ui.bringToFront();await ui.locator('#save-list li').last().locator('button').first().click();await sleep(100);
    assert.equal(await worker.evaluate(()=>testNative.saves.at(-1).password),'EditedFixture123');
  });
  await test('MISSED ARIA button Space registration',1,standard('<div role="button" tabindex="0">Create account</div>','REVIEW_USER'),async page=>{await page.locator('[role=button]').focus();await page.keyboard.press('Space');},page=>page.evaluate(()=>document.querySelector('[role=button]').addEventListener('keydown',event=>{if(event.key===' '){event.preventDefault();window.review.actions++;document.querySelector('form').remove();}})));
  await test('MISSED window capture clears fields first',1,standard(undefined,'REVIEW_USER'),click,page=>page.evaluate(()=>window.addEventListener('click',event=>{if(event.target.tagName==='BUTTON'){document.querySelectorAll('input').forEach(input=>input.value='');window.review.actions++;}},true)));
  await test('FALSE POSITIVE pointerdown only disables fields without submitting',0,standard('<button type="button">Create account</button>','REVIEW_USER'),click,page=>page.evaluate(()=>document.querySelector('button').addEventListener('pointerdown',()=>{document.querySelectorAll('input').forEach(input=>input.disabled=true);window.review.actions++;})));
  await test('MISSED pointerdown completes a credential-form transition before click',1,standard('<button type="button">Create account</button>','REVIEW_USER'),click,page=>page.evaluate(()=>document.querySelector('button').addEventListener('pointerdown',()=>{document.querySelectorAll('input').forEach(input=>input.disabled=true);window.review.actions++;document.querySelector('form').remove();})));
  await test('BOUNDARY closed shadow is not inspected',0,'<div id="component"></div>',async page=>{
    const rect=await page.evaluate(()=>{const r=window.reviewRoot.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});await page.mouse.click(rect.x,rect.y);
  },page=>page.evaluate(html=>{window.reviewRoot=document.querySelector('#component').attachShadow({mode:'closed'});window.reviewRoot.innerHTML=html;window.reviewRoot.addEventListener('submit',event=>{event.preventDefault();window.review.submits++;});},standard(undefined,'shadow-fixture')));
  await test('MISSED username identical to password',1,standard(undefined,'REVIEW_USER').replace('value="Fixture123"','value="REVIEW_USER"'),click);
  await test('FALSE POSITIVE unclassified confirmation in change form',0,'<form><input autocomplete="username" value="REVIEW_USER"><input type="password" autocomplete="current-password" value="Old123"><input type="password" autocomplete="new-password" value="New123"><input type="password" id="c" name="credentialCheck" value="Mismatch123"><button>Update password</button></form>',click);
  await test('FALSE POSITIVE composing Enter commits IME only',0,standard(undefined,'REVIEW_USER'),async page=>{
    await page.locator('#u').focus();
    const cdp=await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition',{text:'候选',selectionStart:2,selectionEnd:2});
    await page.keyboard.press('Enter');
  },page=>page.evaluate(()=>{
    window.addEventListener('keydown',event=>{if(event.key==='Enter')window.review.composing=event.isComposing;},true);
    document.querySelector('#u').addEventListener('keydown',event=>{if(event.isComposing)event.preventDefault();});
  }));
  await test('WRONG CREDENTIAL click handler transforms actual submitted password',1,standard(undefined,'REVIEW_USER').replace('id="p"','id="p" name="password"'),click,page=>page.evaluate(()=>{
    document.querySelector('button').addEventListener('click',()=>{document.querySelector('#p').value='NormalizedFixture123';window.review.actions++;});
    document.querySelector('form').addEventListener('submit',()=>{window.reviewSubmittedPassword=new FormData(document.querySelector('form')).get('password');});
  }),{compareFinalPassword:true});
  await test('SILENT ERROR empty new password chooses empty candidate',0,'<form><input autocomplete="username" value="REVIEW_USER"><input type="password" autocomplete="current-password" value="Old123"><input type="password" autocomplete="new-password"><button>Update password</button></form>',click);
  await test('SILENT ERROR rejected background handoff',0,standard(undefined,'REVIEW_USER'),click,async page=>{
    const cdp=await context.newCDPSession(page);const contexts=[];cdp.on('Runtime.executionContextCreated',event=>contexts.push(event.context));await cdp.send('Runtime.enable');
    let injected=false;
    for(const world of contexts){const probe=await cdp.send('Runtime.evaluate',{contextId:world.id,expression:'typeof documentKey === "string" && typeof finishSaveIntent === "function"',returnByValue:true});if(probe.result.value){
      const result=await cdp.send('Runtime.evaluate',{contextId:world.id,expression:'chrome.runtime.sendMessage = message => message.type === "resolveSave" ? Promise.resolve({ok:false,errorKey:"errorConnection"}) : Promise.resolve({ok:true}); true',returnByValue:true});injected=result.result.value;
    }}
    if(!injected)throw new Error('fault injection did not locate actual content world');
  },{expectedInlineError:true});
  console.log(JSON.stringify({summary:{cases:reports.length,unexpected:reports.filter(r=>!r.matchesExpected).length,silentFaults:reports.filter(r=>r.name.startsWith('SILENT')&&r.inlineNotices===0&&r.fallbackNotices===0&&r.saveStates.length===0).length,wrongCredentialCases:reports.filter(r=>r.passwordMatchesFinalSubmittedValue===false).length},native:'SIMULATED, no live vault access'}));
  assert.equal(reports.filter(r=>!r.matchesExpected).length,0,'Save regressions failed');
  console.log(`==== ${reports.length}/${reports.length} save regressions PASS ====`);
}finally{if(context)await context.close();await new Promise(resolve=>server.close(resolve));}
