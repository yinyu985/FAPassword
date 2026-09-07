// Production background + SRP/AES protocol, simulated native transport only.
// This proves request delivery, NOT persistence in Apple's real vault.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
globalThis.crypto ||= webcrypto;
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const id = 'save-test';
const tab = { id: 1, url: 'https://example.test:8766/login' };
globalThis.chrome = {
  runtime: { id, getURL: path => `chrome-extension://${id}/${path}`,
    onMessage: event(), onConnect: event(), onInstalled: event(), onStartup: event() },
  tabs: { onRemoved: event(), query: async () => [tab], sendMessage: async () => ({ ok: true }) },
};
await import('./mock-native.js');
await import('../../src/background.js');
const listener = chrome.runtime.onMessage.listeners.at(-1);
const ui = { id, url: chrome.runtime.getURL('src/popup.html') };
const frame = { id, tab, url: tab.url, frameId: 0, documentId: 'save-document' };
const call = (message, sender = ui) => new Promise(resolve => listener(message, sender, resolve));
const submit = (username, password, extra = {}) => call({ type: 'resolveSave', documentKey: 'doc-key',
  username, password, submissionId: crypto.randomUUID(), ...extra }, frame);
async function waitFor(fn, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('save state timed out');
}
const savedState = async saveId => (await call({ type: 'getState' })).saves.find(s => s.id === saveId);
const unlock = async () => {
  assert.equal((await call({ type: 'requestChallenge' })).ok, true);
  assert.equal((await call({ type: 'verifyPin', pin: testNative.pin })).ok, true);
};
try {
  await unlock();
  // Existing name, new manually supplied password, no generator/new-password context.
  testNative.entries = [{ USR: 'existing-user', PWD: 'OldFixture123' }];
  const first = await submit('existing-user', 'CorrectFixture456', { generatedId: null });
  assert.equal(first.ok, true);
  await waitFor(async () => (await savedState(first.saveId))?.status === 'submitted');
  assert.deepEqual(testNative.saves.at(-1), {
    username: 'existing-user', password: 'CorrectFixture456', host: 'example.test:8766',
  });
  assert.equal(testNative.counters.passwords, 0);
  assert.equal(testNative.entries[0].PWD, 'OldFixture123');
  console.log('PASS changed existing account and port reach encrypted native save; handoff does not prove vault mutation');

  const second = await submit('existing-user', 'AnotherFixture789');
  await waitFor(async () => (await savedState(second.saveId))?.status === 'submitted');
  assert.equal(testNative.counters.saves, 2);
  const duplicate = await submit('existing-user', 'AnotherFixture789');
  await waitFor(async () => (await savedState(duplicate.saveId))?.status === 'skipped');
  assert.equal(testNative.counters.saves, 2);
  console.log('PASS different password versions are sent; identical recent submissions are skipped');

  const noAccount = await submit('', 'UnidentifiedFixture123');
  await waitFor(async () => (await savedState(noAccount.saveId))?.messageKey === 'saveNoAccount');
  assert.equal(testNative.counters.saves, 2);
  console.log('PASS ordinary login without a username cannot initiate an account update');

  testNative.invalidate();
  const queued = await submit('queued-user', 'QueuedFixture123');
  await waitFor(async () => (await savedState(queued.saveId))?.messageKey === 'saveWaitingUnlock');
  assert.equal(testNative.counters.saves, 2);
  await unlock();
  await waitFor(async () => (await savedState(queued.saveId))?.status === 'submitted');
  assert.equal(testNative.counters.saves, 3);
  console.log('PASS locked submissions wait for unlock before native delivery');

  // Apple's save is one-way. An absent or late cmd-6 reply cannot block a real
  // names query, disconnect the stream, or count as proof of vault persistence.
  testNative.dropSaveAck = true;
  const sent = await submit('no-ack-user', 'NoAckFixture123');
  await waitFor(async () => (await savedState(sent.saveId))?.status === 'submitted');
  assert.equal((await call({ type: 'getLogins' })).ok, true);
  assert.equal((await call({ type: 'getState' })).state, 'unlocked');
  assert.equal(testNative.counters.saves, 4);
  testNative.delays.names = 100;
  await call({ type: 'refreshLogins' });
  const names = call({ type: 'getLogins' });
  setTimeout(() => testNative.ports.at(-1).emit({ cmd: 6 }), 20);
  assert.equal((await names).ok, true);
  console.log('PASS missing/late save replies do not block or corrupt subsequent queries');

  await call({ type: 'refreshLogins' });
  testNative.delays.names = 500;
  const blockingQuery = call({ type: 'getLogins' });
  const expired = await submit('expired-user', 'ExpiredFixture123');
  await waitFor(async () => (await savedState(expired.saveId))?.status === 'saving');
  const realNow = Date.now;
  Date.now = () => realNow() + 180001;
  try {
    await blockingQuery;
    await waitFor(async () => (await savedState(expired.saveId))?.status === 'expired');
    assert.equal(testNative.counters.saves, 4);
  } finally { Date.now = realNow; testNative.delays.names = 0; }
  console.log('PASS expiration while waiting behind a native query prevents save delivery');

  testNative.throwSavePost = true;
  const uncertain = await submit('uncertain-user', 'UncertainFixture123');
  await waitFor(async () => (await savedState(uncertain.saveId))?.status === 'uncertain');
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal(testNative.counters.saves, 4);
  console.log('PASS ambiguous native post failure reports uncertain and is not automatically retried');
} finally {
  const state = await call({ type: 'getState' });
  for (const save of state.saves || []) await call({ type: 'cancelSave', saveId: save.id });
  for (const port of testNative.ports) port.disconnect();
}
