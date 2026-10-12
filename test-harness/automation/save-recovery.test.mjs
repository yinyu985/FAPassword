// Recover the real background from a simulated browser-memory session snapshot.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
globalThis.crypto ||= webcrypto;
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const id = 'recovery-test';
const tab = { id: 1, url: 'https://example.test/login' };
const target = { tabId: 1, frameId: 0, documentId: 'old-document', documentKey: 'old-key',
  frameUrl: tab.url, origin: 'https://example.test', topOrigin: 'https://example.test' };
const entry = (id, status, expiresAt = Date.now() + 180000) => ({ id, status, target,
  username: id, password: 'RecoveryFixture123', saveKind: 'new', submissionId: id, expiresAt, attempts: 0 });
const data = { pendingCredentialSavesV1: [entry('queued', 'queued'), entry('inflight', 'saving'),
  entry('generated', 'review'), entry('expired', 'queued', Date.now() - 1), entry('account', 'needsAccount')] };
const storage = { async setAccessLevel(value) { assert.equal(value.accessLevel, 'TRUSTED_CONTEXTS'); },
  async get(key) { return structuredClone({ [key]: data[key] }); },
  async set(value) { Object.assign(data, structuredClone(value)); } };
globalThis.chrome = { runtime: { id, getURL: path => `chrome-extension://${id}/${path}`,
  onMessage: event(), onConnect: event(), onInstalled: event(), onStartup: event() },
  storage: { session: storage }, tabs: { onRemoved: event(), query: async () => [tab], sendMessage: async () => ({ ok: true }) } };
await import('./mock-native.js');
await import('../../src/background.js');
const listener = chrome.runtime.onMessage.listeners.at(-1);
const ui = { id, url: chrome.runtime.getURL('src/popup.html') };
const call = message => new Promise(resolve => listener(message, ui, resolve));
try {
  const states = (await call({ type: 'getState' })).saves;
  assert.equal(states.find(s => s.id === 'inflight').status, 'uncertain');
  assert.equal(states.find(s => s.id === 'queued').status, 'review');
  assert.equal(states.find(s => s.id === 'queued').messageKey, 'saveRecoveredReview');
  assert.equal(states.find(s => s.id === 'generated').status, 'review');
  assert.equal(states.find(s => s.id === 'expired').status, 'expired');
  assert.equal(data.pendingCredentialSavesV1.find(s => s.id === 'expired').password, '');
  await call({ type: 'requestChallenge' });
  assert.equal((await call({ type: 'verifyPin', pin: testNative.pin })).ok, true);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(testNative.counters.saves, 0, 'a recovered snapshot needs explicit reconfirmation');
  assert.equal((await call({ type: 'retrySave', saveId: 'queued' })).ok, true);
  for (let i = 0; i < 200 && testNative.counters.saves === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(testNative.counters.saves, 1);
  assert.equal(testNative.saves[0].username, 'queued');
  assert.equal(testNative.saves[0].password, 'RecoveryFixture123');
  console.log('PASS recovered queued saves require confirmation; in-flight requests become uncertain, review/account candidates never auto-send, expired secrets are cleared');
} finally {
  for (const save of (await call({ type: 'getState' })).saves) await call({ type: 'cancelSave', saveId: save.id });
  assert.deepEqual(data.pendingCredentialSavesV1, []);
  for (const port of testNative.ports) port.disconnect();
}
