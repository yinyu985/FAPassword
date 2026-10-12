import { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
globalThis.crypto ||= webcrypto;
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);}});
const id='save-review';const tab={id:1,url:'https://example.test/login'};
globalThis.chrome={runtime:{id,getURL:path=>`chrome-extension://${id}/${path}`,onMessage:event(),onConnect:event(),onInstalled:event(),onStartup:event()},tabs:{onRemoved:event(),query:async()=>[tab],sendMessage:async()=>({ok:true,filled:true})}};
await import('./mock-native.js');
await import('../../src/background.js');
const listener=chrome.runtime.onMessage.listeners.at(-1);
const ui={id,url:chrome.runtime.getURL('src/popup.html')};
let frame={id,tab,url:tab.url,frameId:0,documentId:'review-0'};
const call=(message,sender=ui)=>new Promise(resolve=>listener(message,sender,resolve));
const realSetTimeout=globalThis.setTimeout;
const sleep=ms=>new Promise(resolve=>realSetTimeout(resolve,ms));
async function waitFor(fn,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await sleep(10);}throw new Error('Review wait timed out');}
const state=async()=> (await call({type:'getState'})).saves||[];
const saved=async saveId=>(await state()).find(s=>s.id===saveId);
const submit=(username,password,extra={})=>call({type:'resolveSave',documentKey:'key',username,password,submissionId:crypto.randomUUID(),...extra},frame);
const unlock=async()=>{await call({type:'requestChallenge'});const result=await call({type:'verifyPin',pin:testNative.pin});if(!result.ok)throw new Error('mock unlock failed');};
async function cleanup(){for(const save of await state())await call({type:'cancelSave',saveId:save.id});}
async function newDocument(index){frame={...frame,documentId:'review-'+index};await call({type:'frameReady',documentKey:'key'},frame);}
try{
  await unlock();
  const before=testNative.counters.saves;
  const first=await submit('resubmit-fixture','Fixture123');await waitFor(async()=> (await saved(first.saveId))?.status==='submitted');
  const second=await submit('resubmit-fixture','Fixture123');await waitFor(async()=> (await saved(second.saveId))?.status==='submitted');
  assert.equal(testNative.counters.saves-before,2);
  console.log('PASS distinct user intents with identical credentials are not swallowed');
  await cleanup();await newDocument(1);

  testNative.entries=[{USR:'revert-fixture',PWD:'OriginalFixture123'}];
  const fill=await call({type:'inlineFill',documentKey:'key',loginName:{username:'revert-fixture'},requestId:'revert-fill'},frame);
  if(!fill.filled)throw new Error('original-password autofill fixture failed');
  const revertBefore=testNative.counters.saves;
  const changed=await submit('revert-fixture','ChangedFixture123',{saveKind:'change'});await waitFor(async()=> (await saved(changed.saveId))?.status==='submitted');
  const reverted=await submit('revert-fixture','OriginalFixture123',{saveKind:'change'});await waitFor(async()=> (await saved(reverted.saveId))?.status==='submitted');
  assert.equal(testNative.counters.saves-revertBefore,2);
  console.log('PASS an old autofill digest cannot suppress a later password-version change');
  await cleanup();await newDocument(2);

  const timerCalls=[];
  globalThis.setTimeout=(fn,ms,...args)=>{if([8000,2000,4000].includes(ms)){timerCalls.push(ms);ms/=100;}return realSetTimeout(fn,ms,...args);};
  try{
    testNative.entries=[{USR:'slow-query-fixture',PWD:'OldFixture123'}];testNative.delays.passwords=1200;
    const query=call({type:'inlineFill',documentKey:'key',loginName:{username:'slow-query-fixture'},requestId:'slow-fill'},frame);
    await waitFor(()=>testNative.counters.passwords>=2);
    const nativeBefore=testNative.counters.saves;
    const queued=await submit('queued-behind-query','NewFixture123');
    await waitFor(async()=> (await saved(queued.saveId))?.status==='saving');
    await query;
    await waitFor(async()=> (await saved(queued.saveId))?.status==='submitted');
    assert.equal(testNative.counters.saves-nativeBefore,1);
    assert.equal(timerCalls.filter(ms=>ms===8000).length,0);
    console.log('PASS save waits behind a slow native query until its own TTL; no short-deadline retry exhaustion');
  }finally{globalThis.setTimeout=realSetTimeout;testNative.delays.passwords=0;}
  await cleanup();await newDocument(3);

  testNative.throwSavePost=true;
  const uncertain=await submit('uncertain-oldest','Fixture123');await waitFor(async()=> (await saved(uncertain.saveId))?.status==='uncertain');
  testNative.throwSavePost=false;await unlock();
  for(let index=0;index<9;index++){
    const completed=await submit('completed-'+index,'Fixture123');await waitFor(async()=> (await saved(completed.saveId))?.status==='submitted');
  }
  const next=await submit('next-fixture','Fixture123');await waitFor(async()=> (await saved(next.saveId))?.status==='submitted');
  assert.ok(await saved(uncertain.saveId));
  assert.equal((await state()).length,10);
  console.log('PASS terminal entries are evicted before unresolved native requests');
  await cleanup();
  for(let i=0;i<10;i++) assert.equal((await submit('review-'+i,'Fixture123',{review:true})).ok,true);
  const rejected=await submit('overflow','Fixture123');
  assert.equal(rejected.ok,false); assert.equal(rejected.errorKey,'saveQueueFull');
  assert.equal((await state()).filter(s=>s.status==='review').length,10);
  console.log('PASS a full active queue rejects new work explicitly without discarding any pending password');
}finally{globalThis.setTimeout=realSetTimeout;testNative.throwSavePost=false;await cleanup();for(const port of testNative.ports)port.disconnect();}

