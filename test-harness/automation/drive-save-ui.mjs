// Real popup/content/worker, isolated Chromium and simulated native transport only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from './e2e-playwright.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const built = root + '/test-harness/automation/.builds/unlocked';
for (const file of ['popup.js', 'background.bundle.js', 'field-policy.js']) {
  assert.deepEqual(await readFile(root + '/src/' + file), await readFile(built + '/src/' + file), `${file} mock build is stale`);
}
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<!doctype html><meta charset="utf-8"><form><input type="hidden" autocomplete="username" value="hidden-fixture"><input type="password" autocomplete="new-password" value="SyntheticFixture123"><button>Create account</button></form><script>document.querySelector("form").addEventListener("submit",event=>event.preventDefault())</script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let context;
let cases = 0;
const pass = name => { cases++; console.log('PASS ' + name); };
try {
  context = await chromium.launchPersistentContext('', { headless: true, args: [`--disable-extensions-except=${built}`, `--load-extension=${built}`] });
  context.setDefaultTimeout(10000);
  const worker = context.serviceWorkers()[0];
  const base = 'http://127.0.0.1:' + server.address().port;
  const page = await context.newPage();
  await page.goto(base + '/first');
  await page.locator('button').click();
  const ui = await context.newPage();
  await ui.goto(new URL('popup.html', worker.url()).href);
  const api = message => ui.evaluate(message => chrome.runtime.sendMessage(message), message);
  await ui.locator('#save-list input').first().waitFor({ state: 'visible' });
  const firstId = (await api({ type: 'getState' })).saves[0].id;
  const first = ui.locator(`[data-save-id="${firstId}"]`);
  const account = first.locator('input');
  await account.fill('   ');
  await first.locator('button').first().click();
  assert.equal(await ui.evaluate(() => document.activeElement === document.querySelector('#save-list input')), true);
  assert.equal(await worker.evaluate(() => testNative.counters.saves), 0);
  assert.equal((await api({ type: 'getState' })).saves[0].status, 'needsAccount');
  pass('a whitespace-only account is not submitted');
  await account.fill('synthetic-choice');
  await ui.evaluate(() => {
    window.saveUiInput = document.querySelector('#save-list input');
    window.saveUiInput.setSelectionRange(3, 8);
  });
  await worker.evaluate(() => testNative.invalidate());
  await ui.locator('#view-connecting:not([hidden])').waitFor({ state: 'visible' });
  assert.equal(await account.inputValue(), 'synthetic-choice');
  assert.equal(await ui.evaluate(() => document.activeElement === window.saveUiInput), true);
  await api({ type: 'retryConnection' });
  await ui.locator('#view-pin:not([hidden])').waitFor({ state: 'visible' });
  assert.deepEqual(await ui.evaluate(() => ({ value: window.saveUiInput.value,
    same: document.querySelector('#save-list input') === window.saveUiInput,
    focused: document.activeElement === window.saveUiInput,
    selection: [window.saveUiInput.selectionStart, window.saveUiInput.selectionEnd] })),
  { value: 'synthetic-choice', same: true, focused: true, selection: [3, 8] });
  pass('pending account, input identity, focus and selection survive native state changes');

  const page2 = await context.newPage();
  await page2.goto(base + '/second');
  await page2.locator('button').click();
  await ui.waitForFunction(() => document.querySelectorAll('#save-list li').length === 2);
  assert.equal(await account.inputValue(), 'synthetic-choice');
  assert.equal(await ui.evaluate(() => document.activeElement === window.saveUiInput && document.querySelector('#save-list input') === window.saveUiInput), true);
  pass('another candidate does not replace the existing account input');

  // Inject only extension-UI message failures; the real worker/session queue is unchanged.
  await ui.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.saveUiMode = 'connection';
    chrome.runtime.sendMessage = (message, ...args) => {
      const callback = args.at(-1);
      const deliver = async operation => {
        const result = await operation();
        await new Promise(resolve => setTimeout(resolve, 100));
        if (typeof callback === 'function') { callback(result); return; }
        return result;
      };
      if (message?.type === 'cancelSave' && window.saveUiMode !== 'pass') {
        return deliver(async () => {
          if (window.saveUiMode === 'connection') return { ok: false, errorKey: 'errorConnection' };
          if (window.saveUiMode === 'empty-error') return { ok: false, errorKey: 'saveStorageFailed', saves: [] };
          if (window.saveUiMode === 'recovery') return { ok: false, errorKey: 'saveStorageFailed', saves: [], saveRecoveryError: 'saveStorageFailed' };
          const state = await original({ type: 'getState' });
          return { ok: false, errorKey: 'saveStorageFailed', saves: state.saves.map(save => save.id === message.saveId
            ? { ...save, status: 'cancelPending', messageKey: 'saveCancelFailed' } : save) };
        });
      }
      if (message?.type === 'retryConnection' && window.saveUiMode === 'recovery') {
        return deliver(async () => ({ ...(await original({ type: 'getState' })), saveRecoveryError: null }));
      }
      return original(message, ...args);
    };
  });
  await first.locator('button').last().click();
  await ui.waitForFunction(id => [...document.querySelectorAll('[data-save-id]')].find(row => row.dataset.saveId === id)?.getAttribute('aria-busy') === 'true', firstId);
  assert.equal(await first.locator('button:enabled').count(), 0);
  await ui.waitForFunction(() => document.querySelector('#status-message').classList.contains('failed'));
  assert.equal(await ui.locator('#save-list li').count(), 2);
  assert.equal((await api({ type: 'getState' })).saves.length, 2);
  assert.equal(await account.inputValue(), 'synthetic-choice');
  await first.locator('button').last().waitFor({ state: 'visible' });
  pass('cancel is disabled while pending and a transport failure preserves both candidates and account');

  await ui.evaluate(() => { window.saveUiMode = 'empty-error'; });
  await first.locator('button').last().click();
  await ui.waitForFunction(() => document.querySelector('#status-message').textContent === chrome.i18n.getMessage('saveStorageFailed'));
  assert.equal(await ui.locator('#save-list li').count(), 2);
  assert.equal(await account.inputValue(), 'synthetic-choice');
  pass('a failed cancellation carrying an empty snapshot does not clear known candidates');

  await ui.evaluate(() => { window.saveUiMode = 'cancel-pending'; });
  await first.locator('button').last().click();
  await ui.waitForFunction(id => [...document.querySelectorAll('[data-save-id]')].find(row => row.dataset.saveId === id)?.querySelector('p').textContent.includes(chrome.i18n.getMessage('saveCancelFailed')), firstId);
  assert.equal(await first.locator('button').count(), 1);
  assert.equal(await first.locator('button').textContent(), await ui.evaluate(() => chrome.i18n.getMessage('cancelSave')));
  pass('cancelPending keeps an actionable cancel button and offers no save/retry control');

  await ui.evaluate(() => { window.saveUiMode = 'recovery'; });
  await first.locator('button').last().click();
  await ui.locator('#save-recovery-error').waitFor({ state: 'visible' });
  assert.equal(await ui.locator('#save-list li').count(), 2);
  assert.equal(await ui.locator('#pending-saves').isVisible(), true);
  assert.equal(await ui.locator('#save-recovery-error').textContent(), await ui.evaluate(() => chrome.i18n.getMessage('saveRecoveryFailed')));
  assert.equal(await ui.locator('#save-list button').filter({ hasText: await ui.evaluate(() => chrome.i18n.getMessage('unlock')) }).isDisabled(), true);
  pass('unknown recovery state is visible, preserves known rows and disables saving');

  await ui.locator('#save-recovery-error + button').click();
  await ui.locator('#save-recovery-error').waitFor({ state: 'hidden' });
  assert.equal(await account.inputValue(), 'synthetic-choice');
  assert.equal(await ui.locator('#save-list li').count(), 2);
  pass('recovery retry clears its error and restores the retained account draft');

  await ui.evaluate(() => { window.saveUiMode = 'pass'; });
  await first.locator('button').last().click();
  await first.waitFor({ state: 'detached' });
  assert.equal(await ui.locator('#save-list li').count(), 1);
  assert.equal((await api({ type: 'getState' })).saves.length, 1);
  assert.equal(await worker.evaluate(() => testNative.counters.saves), 0);
  pass('successful cancellation removes only its candidate without a native save');
  // A real transient write failure is retried in the worker before its delayed
  // error response arrives at the popup. The newer successful state must win.
  const lastId = (await api({ type: 'getState' })).saves[0].id;
  await worker.evaluate(() => {
    const original = chrome.storage.session.set.bind(chrome.storage.session);
    let failed = false;
    chrome.storage.session.set = async value => {
      if (!failed && value.pendingCredentialSavesV1?.some(save => save.status === 'cancelPending')) {
        failed = true; throw new Error('test transient cancellation write failure');
      }
      return original(value);
    };
  });
  await ui.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.lateCancelReturned = false;
    chrome.runtime.sendMessage = (message, ...args) => {
      if (message?.type !== 'cancelSave') return original(message, ...args);
      const callback = args.at(-1);
      return original(message).then(async response => {
        await new Promise(resolve => setTimeout(resolve, 2300));
        window.lateCancelReturned = true;
        if (typeof callback === 'function') { callback(response); return; }
        return response;
      });
    };
  });
  await ui.locator(`[data-save-id="${lastId}"] button`).last().click();
  await ui.locator(`[data-save-id="${lastId}"]`).waitFor({ state: 'detached' });
  await ui.waitForFunction(() => window.lateCancelReturned);
  await ui.waitForTimeout(100);
  assert.equal(await ui.locator('#save-list li').count(), 0);
  assert.equal((await api({ type: 'getState' })).saves.length, 0);
  assert.equal(await worker.evaluate(() => testNative.counters.saves), 0);
  assert.notEqual(await ui.locator('#status-message').textContent(), await ui.evaluate(() => chrome.i18n.getMessage('saveCancelFailed')));
  pass('a late failed cancel response cannot resurrect a request after a successful background retry');
  console.log(`==== ${cases}/${cases} save UI regressions passed; simulated native only ====`);
} finally {
  if (context) await context.close();
  await new Promise(resolve => server.close(resolve));
}
