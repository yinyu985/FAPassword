// Check the real background/protocol's port-bearing host and frame routing.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
globalThis.crypto ||= webcrypto;
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const id = 'native-routing-test';
const tab = { id: 9, url: 'https://example.test:8766/login' };
const frameUrl = 'https://login.example.test:8443/registration';
globalThis.chrome = { runtime: { id, getURL: path => `chrome-extension://${id}/${path}`,
  onMessage: event(), onConnect: event(), onInstalled: event(), onStartup: event() },
  tabs: { onRemoved: event(), query: async () => [tab], sendMessage: async () => ({ ok: true, documentKey: 'frame-key' }) } };
await import('./mock-native.js');
await import('../../src/background.js');
const listener = chrome.runtime.onMessage.listeners.at(-1);
const ui = { id, url: chrome.runtime.getURL('src/popup.html') };
const frame = { id, tab, url: frameUrl, frameId: 7, documentId: 'login-frame-document' };
const call = (message, sender = ui) => new Promise(resolve => listener(message, sender, resolve));
try {
  assert.equal((await call({ type: 'requestChallenge' })).ok, true);
  assert.equal((await call({ type: 'verifyPin', pin: testNative.pin })).ok, true);
  assert.equal((await call({ type: 'recordFocus', documentKey: 'frame-key' }, frame)).ok, true);
  const names = await call({ type: 'getLogins' });
  assert.equal(names.ok, true);
  assert.equal(names.logins[0].username, 'test@example.com');
  assert.deepEqual(testNative.queryTargets.at(-1), { command: 4, tabId: 9, frameId: 7, host: 'login.example.test:8443' });
  console.log('PASS toolbar account queries preserve the acted-on iframe and port-bearing host');
  const queued = await call({ type: 'resolveSave', documentKey: 'frame-key', submissionId: 'frame-save',
    username: 'frame-account', password: 'NativeRoutingFixture123', saveKind: 'new' }, frame);
  assert.equal(queued.ok, true);
  const deadline = Date.now() + 5000;
  while (!testNative.saves.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(testNative.saveTargets[0], { tabId: 9, frameId: 7 });
  assert.deepEqual(testNative.saves[0], { username: 'frame-account', password: 'NativeRoutingFixture123',
    host: 'login.example.test:8443', qid: 'CmdNewAccount4URL', action: 4 });
  console.log('PASS encrypted save payload preserves exact account, password, iframe, port and QID');
} finally {
  for (const save of (await call({ type: 'getState' })).saves) await call({ type: 'cancelSave', saveId: save.id });
  for (const port of testNative.ports) port.disconnect();
}
