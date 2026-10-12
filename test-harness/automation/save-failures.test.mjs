// Real background/protocol/store, isolated mock Chrome and native transport.
// Fresh module instances model loss of a worker's local state, not vault writes.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cases = ['read-recovery', 'merge-overflow', 'recovery-duplicate', 'recovery-local-cancel', 'cancel-transient', 'cancel-unavailable',
  'cancel-auto-retry', 'cancel-cleanup-failure', 'cancel-concurrent', 'cancel-inflight', 'blocked-review'];
const mode = process.argv[2];
if (!mode) {
  for (const name of cases) {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), name], { stdio: 'inherit' });
      child.on('error', reject); child.on('close', resolve);
    });
    assert.equal(code, 0, `save failure scenario ${name}`);
  }
} else {
  assert.ok(cases.includes(mode));
  globalThis.crypto ||= webcrypto;
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
  const id = 'save-failure-test';
  const tab = { id: 1, url: 'https://example.test/login' };
  const target = { tabId: 1, frameId: 0, documentId: 'fixture-document', documentKey: 'fixture-key',
    frameUrl: tab.url, origin: 'https://example.test', topOrigin: 'https://example.test' };
  const fixture = (index, status = 'queued') => ({ id: `stored-${index}`, status, target,
    username: `stored-account-${index}`, password: 'Test-only-pending-fixture', saveKind: 'new',
    submissionId: `stored-intent-${index}`, expiresAt: Date.now() + 180000, attempts: 0 });
  const data = { pendingCredentialSavesV1: ['read-recovery', 'recovery-local-cancel'].includes(mode) ? [fixture(0)] :
    mode === 'recovery-duplicate' ? [fixture(0, 'saving')] :
    mode === 'merge-overflow' ? Array.from({ length: 10 }, (_, index) => fixture(index)) : [] };
  const writes = [];
  let readCount = 0, failReads = ['read-recovery', 'merge-overflow', 'recovery-duplicate', 'recovery-local-cancel'].includes(mode);
  let failWrites = false, failedCancelWritesLeft = 0, failEmptyWrites = false;
  let readGate = null, writeGate = null, releaseRead, releaseWrite;
  const storage = {
    async setAccessLevel(value) { assert.equal(value.accessLevel, 'TRUSTED_CONTEXTS'); },
    async get(key) {
      readCount++;
      if (failReads) throw new Error('test session read unavailable');
      if (readGate) await readGate;
      return structuredClone({ [key]: data[key] });
    },
    async set(value) {
      const snapshot = structuredClone(value);
      writes.push(snapshot.pendingCredentialSavesV1);
      const failCancel = failedCancelWritesLeft > 0 && snapshot.pendingCredentialSavesV1.some(save => save.status === 'cancelPending');
      if (failCancel) failedCancelWritesLeft--;
      if (failWrites || failCancel || (failEmptyWrites && !snapshot.pendingCredentialSavesV1.length)) {
        throw new Error('test session write unavailable');
      }
      if (writeGate) await writeGate;
      Object.assign(data, snapshot);
    },
  };
  globalThis.chrome = { runtime: { id, getURL: path => `chrome-extension://${id}/${path}`,
    onMessage: event(), onConnect: event(), onInstalled: event(), onStartup: event() },
    storage: { session: storage }, tabs: { onRemoved: event(), query: async () => [tab],
      sendMessage: async () => ({ ok: true }) } };
  const timers = new Set();
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => {
    const timer = realSetTimeout(() => { timers.delete(timer); callback(...args); }, ms);
    timers.add(timer); return timer;
  };
  globalThis.clearTimeout = timer => { timers.delete(timer); realClearTimeout(timer); };
  const sleep = ms => new Promise(resolve => realSetTimeout(resolve, ms));
  const waitFor = async check => {
    const end = Date.now() + 5000;
    while (Date.now() < end) { if (await check()) return; await sleep(5); }
    throw new Error(`Save fault wait timed out: ${mode}`);
  };
  await import('./mock-native.js');
  const ui = { id, url: chrome.runtime.getURL('src/popup.html') };
  const content = { id, tab, url: tab.url, frameId: 0, documentId: target.documentId };
  const workers = [];
  const loadWorker = async () => {
    await import(`../../src/background.js?save-failure-worker=${workers.length}`);
    const listener = chrome.runtime.onMessage.listeners.at(-1);
    const call = (message, sender = ui) => new Promise(resolve => listener(message, sender, resolve));
    workers.push(call); return call;
  };
  const unlock = async call => {
    assert.equal((await call({ type: 'requestChallenge' })).ok, true);
    assert.equal((await call({ type: 'verifyPin', pin: testNative.pin })).ok, true);
  };
  const state = async call => (await call({ type: 'getState' })).saves;
  const submit = (call, index, extra = {}) => call({ type: 'resolveSave', documentKey: target.documentKey,
    username: `new-account-${index}`, password: 'Test-only-new-fixture', saveKind: 'new',
    submissionId: `new-intent-${index}`, ...extra }, content);
  let call = await loadWorker();
  try {
    if (mode === 'read-recovery' || mode === 'merge-overflow') {
      const failed = await call({ type: 'getState' });
      assert.equal(failed.saveRecoveryError, 'saveStorageFailed');
      assert.equal(failed.errorKey, 'saveStorageFailed');
      assert.deepEqual(failed.saves, []);
      const unknownCancel = await call({ type: 'cancelSave', saveId: 'stored-0' });
      assert.equal(unknownCancel.ok, false, 'an unread candidate cannot be acknowledged as cancelled');
      assert.equal(unknownCancel.errorKey, 'saveStorageFailed');
      const newCount = mode === 'merge-overflow' ? 10 : 1;
      for (let index = 0; index < newCount; index++) {
        const pending = await submit(call, index);
        assert.equal(pending.ok, false);
        assert.equal(pending.errorKey, 'saveStorageFailed');
      }
      assert.equal(data.pendingCredentialSavesV1.length, mode === 'merge-overflow' ? 10 : 1,
        'unread old credentials cannot be overwritten');
      failReads = false;
      readGate = new Promise(resolve => { releaseRead = resolve; });
      const beforeRead = readCount;
      const queries = [call({ type: 'getState' }), call({ type: 'retryConnection' }), call({ type: 'getState' })];
      await waitFor(() => readCount > beforeRead);
      assert.equal(readCount, beforeRead + 1, 'concurrent recovery uses one read');
      releaseRead(); readGate = null;
      const recovered = await Promise.all(queries);
      assert.ok(recovered.every(result => result.saveRecoveryError === null));
      assert.equal(readCount, beforeRead + 1);
      const merged = recovered[0].saves;
      assert.equal(merged.length, mode === 'merge-overflow' ? 20 : 2);
      assert.equal(merged.find(save => save.id === 'stored-0').status, 'review');
      assert.equal(merged.find(save => save.id === 'stored-0').messageKey, 'saveRecoveredReview');
      assert.equal(data.pendingCredentialSavesV1.length, merged.length);
      if (mode === 'merge-overflow') {
        call = await loadWorker();
        assert.equal((await state(call)).length, 20, 'recovery never truncates accepted merged intents');
        await unlock(call); await sleep(25);
        assert.equal(testNative.counters.saves, 0, 'all recovered requests require confirmation');
      } else {
        await unlock(call);
        await waitFor(() => testNative.counters.saves === 1);
        assert.equal(testNative.saves[0].username, 'new-account-0');
        assert.equal(testNative.saves[0].password, 'Test-only-new-fixture');
        assert.equal((await call({ type: 'retrySave', saveId: 'stored-0' })).ok, true);
        await waitFor(() => testNative.counters.saves === 2);
        assert.equal(testNative.saves[1].username, 'stored-account-0');
      }
      console.log(`PASS ${mode}: visible read failure, single-flight retry, safe merge and explicit restored confirmation`);
    } else if (mode === 'recovery-duplicate' || mode === 'recovery-local-cancel') {
      const local = await submit(call, 0, { username: 'stored-account-0', password: 'Test-only-pending-fixture',
        submissionId: 'stored-intent-0' });
      assert.equal(local.ok, false);
      assert.equal(data.pendingCredentialSavesV1.length, 1);
      if (mode === 'recovery-local-cancel') {
        const cancel = await call({ type: 'cancelSave', saveId: local.saveId });
        assert.equal(cancel.ok, false);
        assert.equal(cancel.errorKey, 'saveCancelFailed');
        assert.equal(cancel.saves[0].status, 'cancelPending');
      }
      failReads = false;
      await call({ type: 'retryConnection' });
      if (mode === 'recovery-local-cancel') {
        await waitFor(async () => !(await state(call)).length);
        assert.deepEqual(data.pendingCredentialSavesV1, []);
      } else {
        const recovered = await state(call);
        assert.equal(recovered.length, 1);
        assert.equal(recovered[0].id, 'stored-0');
        assert.equal(recovered[0].status, 'uncertain', 'possibly sent stored intent dominates duplicate local capture');
      }
      await unlock(call); await sleep(25);
      assert.equal(testNative.counters.saves, 0);
      console.log(`PASS ${mode}: merging cannot replay a possibly sent or locally cancelled operation`);
    } else if (mode === 'cancel-transient' || mode === 'cancel-unavailable') {
      const queued = await submit(call, 0);
      assert.equal(queued.ok, true);
      if (mode === 'cancel-transient') failedCancelWritesLeft = 1;
      else failWrites = true;
      const cancelled = await call({ type: 'cancelSave', saveId: queued.saveId });
      assert.equal(cancelled.ok, false);
      assert.equal(cancelled.errorKey, 'saveCancelFailed');
      assert.equal(cancelled.saves[0].status, 'cancelPending');
      assert.equal(cancelled.saves[0].messageKey, 'saveCancelFailed');
      assert.equal((await state(call))[0].status, 'cancelPending');
      assert.equal((await call({ type: 'retrySave', saveId: queued.saveId })).ok, false);
      assert.equal(data.pendingCredentialSavesV1[0].status, 'queued');
      // Simulate termination before a successful cancellation write. Even the
      // old queued snapshot must not auto-send when a fresh worker unlocks.
      const recreated = await loadWorker();
      assert.equal((await state(recreated))[0].status, 'review');
      await unlock(recreated); await sleep(25);
      assert.equal(testNative.counters.saves, 0);
      failWrites = false;
      const retried = await call({ type: 'cancelSave', saveId: queued.saveId });
      assert.equal(retried.ok, true);
      assert.deepEqual(await state(call), []);
      const tombstoneWrite = writes.findIndex(snapshot => snapshot.some(save => save.status === 'cancelPending'));
      assert.ok(tombstoneWrite >= 0);
      assert.ok(writes[tombstoneWrite].every(save => !save.password), 'cancel tombstone cannot retain a secret');
      call = await loadWorker();
      assert.deepEqual(await state(call), []);
      await unlock(call); await sleep(25);
      assert.equal(testNative.counters.saves, 0);
      console.log(`PASS ${mode}: failed cancellation stays visible; old queued recovery cannot auto-send; retry commits a secret-free tombstone`);
    } else if (mode === 'cancel-auto-retry') {
      const queued = await submit(call, 0);
      failedCancelWritesLeft = 1;
      const cancelled = await call({ type: 'cancelSave', saveId: queued.saveId });
      assert.equal(cancelled.ok, false);
      assert.equal(cancelled.errorKey, 'saveCancelFailed');
      assert.equal(cancelled.saves[0].status, 'cancelPending');
      await unlock(call);
      await waitFor(async () => !(await state(call)).length);
      assert.equal(testNative.counters.saves, 0);
      assert.deepEqual(data.pendingCredentialSavesV1, []);
      console.log('PASS cancel-auto-retry: transient tombstone failure retries without another user action or credential post');
    } else if (mode === 'cancel-cleanup-failure') {
      const queued = await submit(call, 0);
      failEmptyWrites = true;
      assert.equal((await call({ type: 'cancelSave', saveId: queued.saveId })).ok, true);
      assert.deepEqual(await state(call), []);
      assert.equal(data.pendingCredentialSavesV1[0].status, 'cancelPending');
      assert.equal(data.pendingCredentialSavesV1[0].password, '');
      call = await loadWorker();
      await waitFor(async () => !(await state(call)).length);
      await unlock(call); await sleep(25);
      assert.equal(testNative.counters.saves, 0);
      console.log('PASS cancel-cleanup-failure: committed tombstone is durable even when removal fails');
    } else if (mode === 'cancel-concurrent') {
      const queued = await submit(call, 0);
      await sleep(10); // Let the independent locked-state notification settle.
      const before = writes.length;
      writeGate = new Promise(resolve => { releaseWrite = resolve; });
      const cancels = [call({ type: 'cancelSave', saveId: queued.saveId }), call({ type: 'cancelSave', saveId: queued.saveId })];
      await waitFor(() => writes.length > before);
      assert.equal(writes.length, before + 1);
      releaseWrite(); writeGate = null;
      assert.ok((await Promise.all(cancels)).every(result => result.ok));
      assert.equal(writes.length, before + 2, 'one shared tombstone write, then removal');
      assert.deepEqual(await state(call), []);
      console.log('PASS cancel-concurrent: duplicate cancel requests share one durable operation');
    } else if (mode === 'cancel-inflight') {
      await unlock(call);
      let releaseNames;
      testNative.namesGate = new Promise(resolve => { releaseNames = resolve; });
      const names = call({ type: 'getLogins' });
      await waitFor(() => testNative.counters.names === 1);
      const queued = await submit(call, 0);
      await waitFor(async () => (await state(call)).some(save => save.id === queued.saveId && save.status === 'saving'));
      assert.equal((await call({ type: 'cancelSave', saveId: queued.saveId })).ok, true);
      releaseNames(); testNative.namesGate = null;
      await names; await sleep(25);
      assert.equal(testNative.counters.saves, 0);
      assert.deepEqual(await state(call), []);
      console.log('PASS cancel-inflight: cancellation while waiting behind a native query prevents post');
    } else {
      const blocked = await submit(call, 0, { review: true, draftId: 'blocked-draft', errorKey: 'errorPasswordConfirmation' });
      assert.equal(blocked.ok, true);
      assert.equal((await state(call))[0].status, 'blocked');
      await unlock(call); await sleep(25);
      assert.equal(testNative.counters.saves, 0);
      assert.equal((await call({ type: 'retrySave', saveId: blocked.saveId })).ok, false);
      const invalid = await submit(call, 1, { review: true, errorKey: 'arbitrary-page-text' });
      assert.equal(invalid.ok, false);
      assert.equal((await state(call)).length, 1);
      assert.equal((await call({ type: 'updateSaveDraft', documentKey: target.documentKey, draftId: 'blocked-draft',
        credential: { username: 'corrected-account', password: 'Test-only-corrected-fixture' } }, content)).ok, true);
      assert.equal((await state(call))[0].status, 'review');
      assert.equal((await call({ type: 'retrySave', saveId: blocked.saveId })).ok, true);
      await waitFor(() => testNative.counters.saves === 1);
      assert.equal(testNative.saves[0].username, 'corrected-account');
      assert.equal(testNative.saves[0].password, 'Test-only-corrected-fixture');
      const needsAccount = await submit(call, 2, { username: '', review: true });
      assert.equal((await call({ type: 'retrySave', saveId: needsAccount.saveId, username: '   ' })).ok, false);
      assert.equal((await call({ type: 'retrySave', saveId: needsAccount.saveId, username: ' account-with-spaces ' })).ok, true);
      await waitFor(() => testNative.counters.saves === 2);
      assert.equal(testNative.saves[1].username, ' account-with-spaces ');
      console.log('PASS blocked-review: retained generated credentials require corrected field evidence before confirmation');
    }
  } finally {
    failReads = false; failWrites = false; failEmptyWrites = false;
    if (releaseRead) releaseRead(); if (releaseWrite) releaseWrite();
    for (const timer of timers) realClearTimeout(timer);
    for (const port of testNative.ports) port.disconnect();
    globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;
  }
}
