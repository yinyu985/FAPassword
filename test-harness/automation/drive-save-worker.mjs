// Force a real Chromium worker restart; native transport remains simulated.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from './e2e-playwright.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const extension = root + '/test-harness/automation/.builds/locked';
assert.deepEqual(await readFile(extension + '/src/background.bundle.js'), await readFile(root + '/src/background.bundle.js'));
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<!doctype html><form><input name=username autocomplete=username value=worker-account><input name=password type=password autocomplete=new-password value=WorkerRecoveryFixture123><button>Create account</button></form><script>document.querySelector("form").addEventListener("submit",event=>event.preventDefault())</script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async predicate => {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await predicate()) return; await sleep(20); }
  throw new Error('Worker recovery condition timed out');
};
let context;
try {
  context = await chromium.launchPersistentContext('', { headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  context.setDefaultTimeout(10000);
  let worker = context.serviceWorkers()[0];
  const ui = await context.newPage();
  await ui.goto(new URL('popup.html', worker.url()).href);
  const api = message => ui.evaluate(message => chrome.runtime.sendMessage(message), message);
  const page = await context.newPage();
  const base = 'http://127.0.0.1:' + server.address().port;
  await page.goto(base + '/registration');
  await page.locator('button').click();
  let initial;
  await wait(async () => { initial = (await api({ type: 'getState' })).saves.find(save => save.username === 'worker-account'); return initial?.status === 'queued'; });
  assert.equal(await worker.evaluate(() => testNative.counters.saves), 0);
  const cdp = await context.newCDPSession(ui);
  const versions = new Map();
  const stoppedVersions = new Set();
  cdp.on('ServiceWorker.workerVersionUpdated', event => {
    for (const version of event.versions) {
      versions.set(version.versionId, version);
      if (version.runningStatus === 'stopped') stoppedVersions.add(version.versionId);
    }
  });
  await cdp.send('ServiceWorker.enable');
  async function restart() {
    const target = (await cdp.send('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url === worker.url());
    assert.ok(target, 'Actual service-worker target must be found');
    await worker.evaluate(() => { testNative.oldWorkerMarker = true; });
    await wait(() => [...versions.values()].some(version => version.scriptURL === worker.url() && version.runningStatus === 'running'));
    const version = [...versions.values()].find(version => version.scriptURL === worker.url() && version.runningStatus === 'running');
    stoppedVersions.delete(version.versionId);
    await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    await wait(() => stoppedVersions.has(version.versionId));
    // A dormant worker is restarted by an extension message, not by waiting.
    const state = api({ type: 'getState' });
    const response = await state;
    await sleep(100);
    worker = context.serviceWorkers().find(candidate => candidate !== worker) || worker;
    assert.equal(await worker.evaluate(() => testNative.oldWorkerMarker), undefined, 'Worker JavaScript state must actually have been lost');
    const replacement = (await cdp.send('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url === worker.url());
    // Chromium can keep the DevTools target/Playwright wrapper across a worker
    // restart. The stopped transition plus loss of JavaScript state prove it.
    assert.ok(replacement, 'The restarted worker must be running again');
    return response;
  }
  let recovered = await restart();
  assert.equal(recovered.saves.find(save => save.id === initial.id).status, 'review');
  assert.equal(recovered.saves.find(save => save.id === initial.id).messageKey, 'saveRecoveredReview');
  await api({ type: 'requestChallenge' });
  assert.equal((await api({ type: 'verifyPin', pin: '123456' })).ok, true);
  await sleep(150);
  assert.equal(await worker.evaluate(() => testNative.counters.saves), 0, 'Unlock cannot auto-replay a recovered queued request');
  assert.equal((await api({ type: 'retrySave', saveId: initial.id })).ok, true);
  await wait(async () => await worker.evaluate(() => testNative.saves.length) === 1);
  assert.deepEqual(await worker.evaluate(() => testNative.saves[0]), { username: 'worker-account', password: 'WorkerRecoveryFixture123', host: new URL(base).host, qid: 'CmdNewAccount4URL', action: 4 });
  console.log('PASS actual worker termination preserves session candidate; unlock never replays it; explicit confirmation sends correct credentials');

  for (const save of (await api({ type: 'getState' })).saves) await api({ type: 'cancelSave', saveId: save.id });
  await api({ type: 'refreshLogins' });
  const namesBefore = await worker.evaluate(() => testNative.counters.names);
  await worker.evaluate(() => { testNative.namesGate = new Promise(() => {}); });
  const query = api({ type: 'getLogins' }).catch(() => null);
  await wait(async () => await worker.evaluate(() => testNative.counters.names) > namesBefore);
  await page.locator('input[name=password]').fill('WorkerInflightFixture456');
  await page.locator('button').click();
  let inflight;
  await wait(async () => { inflight = (await api({ type: 'getState' })).saves.find(save => save.username === 'worker-account'); return inflight?.status === 'saving'; });
  const stored = await ui.evaluate(() => chrome.storage.session.get('pendingCredentialSavesV1'));
  assert.equal(stored.pendingCredentialSavesV1.find(save => save.id === inflight.id).status, 'saving');
  recovered = await restart();
  assert.equal(recovered.saves.find(save => save.id === inflight.id).status, 'uncertain');
  await api({ type: 'requestChallenge' });
  assert.equal((await api({ type: 'verifyPin', pin: '123456' })).ok, true);
  await sleep(150);
  assert.equal(await worker.evaluate(() => testNative.counters.saves), 0, 'An interrupted in-flight save cannot auto-replay');
  void query;
  console.log('PASS actual worker termination during queued native authentication restores uncertainty without a duplicate save');
  console.log('==== 2/2 real Chromium worker recovery regressions PASS; simulated native only ====');
} finally {
  if (context) await context.close();
  await new Promise(resolve => server.close(resolve));
}
