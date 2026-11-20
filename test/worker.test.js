import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { ApplePasswords, State } from '../src/protocol.js';
import { SessionCache } from '../src/session-cache.js';

// Exercise the actual message handler. Replace only its browser/native boundaries.
test('credential actions', async t => {
  globalThis.crypto ??= webcrypto; // Node 18 does not always expose global Web Crypto.
  let client, handle;
  const sent = [];
  const idleEvent = { addListener() {} };
  const id = 'fixture-extension';
  const sender = { id, frameId: 0, documentId: 'fixture-document', url: 'https://router.example/',
    tab: { id: 1, url: 'https://router.example/' } };
  globalThis.chrome = {
    runtime: { id, getURL: path => `chrome-extension://${id}/${path}`, onConnect: idleEvent,
      onStartup: idleEvent, onInstalled: idleEvent, onMessage: { addListener(fn) { handle = fn; } } },
    tabs: { onRemoved: idleEvent, async sendMessage(tab, message, options) {
      sent.push({ tab, message, options });
      return { filled: true, stage: message.stage };
    } },
    storage: { local: { get: async () => ({}) } },
  };
  t.mock.method(ApplePasswords.prototype, 'connect', function () {
    client = this;
    this.port = { postMessage() {}, disconnect() {} };
    this.session = { sharedKey: 'fixture' };
    this._setState(State.Unlocked);
  });
  const read = t.mock.method(ApplePasswords.prototype, 'getPasswordForLoginName', async () =>
    ({ username: 'alice', password: 'fixture-password' }));
  const cache = t.mock.method(SessionCache.prototype, 'get');
  t.after(() => { client?.disconnect(); delete globalThis.chrome; });
  await import('../src/background.js');
  const call = message => new Promise(resolve => handle({ documentKey: 'fixture-key', ...message }, sender, resolve));
  const fill = stage => call({ type: 'inlineFill', loginName: { username: 'alice' }, requestId: 'request-1', stage });

  await t.test('username stage sends only the selected name without a cache or vault read', async () => {
    assert.equal((await fill('username')).filled, true);
    assert.equal(cache.mock.callCount(), 0);
    assert.equal(read.mock.callCount(), 0);
    assert.deepEqual(sent.at(-1), { tab: 1, message: { type: 'fill', stage: 'username', requestId: 'request-1',
      expectedOrigin: sender.url.slice(0, -1), username: 'alice', documentKey: 'fixture-key' },
      options: { documentId: sender.documentId, frameId: 0 } });
  });

  await t.test('password stage obtains the password and sends it to the selected document', async () => {
    assert.equal((await fill('password')).filled, true);
    assert.equal(read.mock.callCount(), 1);
    assert.equal(sent.at(-1).message.password, 'fixture-password');
    assert.equal(sent.at(-1).options.documentId, sender.documentId);
  });

  await t.test('refill is offered only for the document that was filled', async () => {
    const ui = { id, url: chrome.runtime.getURL('src/popup.html') };
    const list = () => new Promise(resolve => handle({ type: 'getLogins' }, ui, resolve));
    chrome.tabs.query = async () => [sender.tab];
    chrome.tabs.sendMessage = async (_tab, msg) => {
      if (msg.type !== 'describeFrame') return { filled: true };
      await call({ type: 'frameReady' });
      return { ok: true, documentKey: 'fixture-key' };
    };
    t.mock.method(ApplePasswords.prototype, 'getLoginNamesForURL', async () => []);
    await fill('username');
    assert.equal((await list()).refill.host, 'router.example');
    sender.documentId = 'same-site-new-document';
    assert.equal((await list()).refill, null);
    await fill('username');
    sender.tab.url = sender.url = 'https://other.example/';
    sender.documentId = 'other-document';
    assert.equal((await list()).refill, null);
  });

  await t.test('default settings reject automatic saves, including password-only logins', async () => {
    const result = await call({ type: 'resolveSave', submissionId: 'router-login', username: '', password: 'fixture' });
    assert.deepEqual(result, { ok: false, errorKey: 'saveAutomaticOff' });
  });
});

// Exercise worker startup, popup retry and session writes, not just the store adapter.
for (const [name, settings] of [['enabled', { automaticSave: true }], ['disabled', { automaticSave: false }], ['default', {}]]) {
  test(`an unreadable save preference preserves the queue until retry (${name})`, async t => {
    const key = 'pendingCredentialSavesV1';
    const target = { tabId: 1, frameId: 0, frameUrl: 'https://site.example/', documentId: 'doc', documentKey: 'key' };
    const initial = ['queued', 'saving', 'review'].map((status, i) => ({
      id: `save-${i}`, submissionId: `submit-${i}`, status, manual: i === 2, target,
      username: 'alice', password: 'fixture', expiresAt: Date.now() + 180000,
    }));
    let rows = structuredClone(initial), writes = 0, failRead = true, handle;
    const event = { addListener() {} };
    const id = 'fixture-extension';
    const ui = { id, url: `chrome-extension://${id}/src/popup.html` };
    globalThis.chrome = {
      runtime: { id, getURL: path => `chrome-extension://${id}/${path}`, onInstalled: event,
        onStartup: event, onConnect: event, onMessage: { addListener(fn) { handle = fn; } } },
      tabs: { onRemoved: event },
      storage: { local: { async get() { if (failRead) throw new Error('read failed'); return settings; } },
        session: { async setAccessLevel() {}, async get() { return { [key]: structuredClone(rows) }; },
          async set(data) { writes++; rows = structuredClone(data[key]); } } },
    };
    t.mock.method(ApplePasswords.prototype, 'connect', function () {
      this.port = {}; this.session = { sharedKey: 'fixture' }; this._setState(State.Unlocked);
    });
    const send = t.mock.method(ApplePasswords.prototype, 'saveLogin', async () => {});
    const call = message => new Promise(resolve => handle(message, ui, resolve));
    t.after(async () => {
      failRead = false;
      for (const { id } of initial) await call({ type: 'cancelSave', saveId: id }); // release worker timers
      delete globalThis.chrome;
    });
    await import(`../src/background.js?recovery=${name}`);
    const blocked = await call({ type: 'getState' });
    assert.equal(writes, 0);
    assert.deepEqual(rows, initial);
    assert.equal(blocked.saveRecoveryError, 'saveStorageFailed');
    assert.equal(send.mock.callCount(), 0);

    failRead = false;
    const retry = await call({ type: 'retryConnection' });
    assert.equal(retry.saveRecoveryError, null);
    const expected = settings.automaticSave ? [['save-0', 'review'], ['save-1', 'uncertain'], ['save-2', 'review']] : [['save-2', 'review']];
    assert.deepEqual(retry.saves.map(s => [s.id, s.status]), expected);
    assert.deepEqual(rows.map(s => [s.id, s.status]), expected);
    assert.equal(send.mock.callCount(), 0);
  });
}
