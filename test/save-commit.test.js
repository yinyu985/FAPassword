import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { ApplePasswords, State } from '../src/protocol.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
let generation = 0;
async function fixture(t, initial = []) {
  globalThis.crypto ??= webcrypto;
  const key = 'pendingCredentialSavesV1', id = 'fixture', tab = { id: 1, url: 'https://site.example/' };
  const frame = { id, tab, url: tab.url, documentId: 'doc', frameId: 0 };
  const ui = { id, url: `chrome-extension://${id}/src/popup.html` };
  const event = { addListener() {} };
  let client, handle, stored = initial.map(s => ({ username: 'fixture', password: 'fixture', manual: true,
    submissionId: s.id, target: { documentId: 'doc', documentKey: 'key', frameUrl: tab.url }, ...s }));
  const api = { beforeWrite: async () => {}, writes: [], calls: 0, username: 'sample' };
  const call = (type, data = {}, sender = ui) => new Promise(resolve => handle({ type, ...data }, sender, resolve));
  const boot = async () => { await import(`../src/background.js?commit=${++generation}`); await call('getState'); await turn(); };
  globalThis.chrome = {
    runtime: { id, getURL: path => `chrome-extension://${id}/${path}`, onInstalled: event, onStartup: event,
      onConnect: event, onMessage: { addListener(fn) { handle = fn; } } },
    tabs: { onRemoved: event, async query() { return [tab]; }, async sendMessage(_tab, msg) {
      if (msg.type === 'describeFrame') { await call('frameReady', { documentKey: 'key' }, frame); return { ok: true, documentKey: 'key' }; }
      if (msg.type === 'readPagePassword') return { ok: true, credential: { username: api.username, password: 'fixture' } };
      return { ok: true };
    } },
    storage: { local: { async get() { return { automaticSave: true }; } }, session: { async setAccessLevel() {}, async get() { return { [key]: structuredClone(stored) }; },
      async set(data) { const states = data[key].map(s => s.status); api.writes.push(states); await api.beforeWrite(states); stored = structuredClone(data[key]); } } },
  };
  t.mock.method(ApplePasswords.prototype, 'connect', function () {
    client = this; this.port = {}; this.session = { sharedKey: 'fixture' }; this._setState(State.Unlocked);
  });
  t.mock.method(ApplePasswords.prototype, 'saveLogin', async () => { api.calls++; });
  await boot(); api.writes.length = 0;
  t.after(async () => {
    api.beforeWrite = async () => {};
    for (const s of (await call('getState')).saves) await call('cancelSave', { saveId: s.id });
    delete globalThis.chrome;
  });
  return Object.assign(api, { call, boot, rows: () => structuredClone(stored), stored: () => stored.map(s => s.status),
    draft: (submissionId = 'create', password = 'first-fixture') => call('resolveSave', { documentKey: 'key', draftId: 'draft', submissionId, review: true, username: 'one', password }, frame),
    edit: (value, documentKey = 'key') => call('updateSaveDraft', { documentKey, draftId: 'draft', credential: { username: value, password: `fixture-${value}` } }, frame),
    relock() { client._setState(State.NeedsPin); client._setState(State.Unlocked); } });
}

test('manual review is written once; a failed admission stays absent after worker restart', async t => {
  const f = await fixture(t);
  f.beforeWrite = async () => { throw Error('storage unavailable'); };
  assert.equal((await f.call('reviewPagePassword')).errorKey, 'saveStorageFailed');
  assert.deepEqual((await f.call('getState')).saves, []);
  assert.deepEqual(f.stored(), []);
  assert.deepEqual(f.writes, [['review']]);
  f.beforeWrite = async () => {}; await f.boot();
  assert.deepEqual((await f.call('getState')).saves, []);
  f.writes.length = 0;
  assert.equal((await f.call('reviewPagePassword')).ok, true);
  assert.deepEqual(f.writes, [['review']]);
  assert.equal(f.calls, 0);
});

test('failed confirmation stays in review across unlock; explicit retry sends once', async t => {
  const f = await fixture(t);
  const { saveId } = await f.call('reviewPagePassword');
  f.beforeWrite = async states => { if (states.includes('queued')) throw Error('storage unavailable'); };
  const failed = await f.call('retrySave', { saveId });
  assert.equal(failed.errorKey, 'saveStorageFailed');
  f.beforeWrite = async () => {}; f.relock(); await turn();
  assert.deepEqual(f.stored(), ['review']);
  assert.equal((await f.call('getState')).saves[0].status, 'review');
  assert.equal(f.calls, 0);
  assert.equal((await f.call('retrySave', { saveId })).ok, true);
  for (let i = 0; i < 50 && !f.stored().includes('submitted'); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.deepEqual(f.stored(), ['submitted']); assert.equal(f.calls, 1);
});

test('a concurrent admission cannot persist a rejected candidate', async t => {
  const f = await fixture(t);
  let started, release;
  const writing = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.beforeWrite = async () => { f.beforeWrite = async () => {}; started(); await gate; throw Error('write failed'); };
  const first = f.call('reviewPagePassword'); await writing;
  f.username = 'second';
  const second = f.call('reviewPagePassword'); await turn(); release();
  assert.equal((await first).ok, false);
  const accepted = await second;
  assert.equal(accepted.ok, true);
  assert.deepEqual(f.stored(), ['review']);
  assert.deepEqual(accepted.saves.map(s => s.username), ['second']);
  assert.equal(f.calls, 0);
});

test('cancel during an uncommitted confirmation wins even if the queued write succeeds', async t => {
  const f = await fixture(t);
  const { saveId } = await f.call('reviewPagePassword');
  let started, release;
  const writing = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.beforeWrite = async states => { if (states.includes('queued')) { started(); await gate; } };
  const confirm = f.call('retrySave', { saveId });
  await writing;
  f.relock(); await turn();
  const before = (await f.call('getState')).saves[0].status;
  const cancel = f.call('cancelSave', { saveId }); await turn(); release();
  assert.equal((await cancel).ok, true);
  assert.equal((await confirm).ok, false);
  assert.equal(before, 'review'); assert.deepEqual(f.stored(), []); assert.equal(f.calls, 0);
});

function pauseWrite(f) {
  let started, release;
  const writing = new Promise(r => { started = r; });
  const gate = new Promise(r => { release = r; });
  f.beforeWrite = async () => { f.beforeWrite = async () => {}; started(); await gate; };
  return { writing, release };
}

test('edits during draft admission wait for storage and apply in order', async t => {
  const f = await fixture(t), gate = pauseWrite(f);
  const create = f.draft(); await gate.writing;
  let acknowledged = false;
  const first = f.edit('two').then(r => { acknowledged = true; return r; });
  const second = f.edit('three'); await turn();
  const premature = acknowledged; gate.release();
  assert.deepEqual((await Promise.all([create, first, second])).map(r => r.ok), [true, true, true]);
  assert.equal(premature, false);
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].password === 'fixture-three', true);
  assert.equal((await f.call('getState')).saves[0].username, 'three');
  assert.equal((await f.edit('other', 'different-document-key')).ok, false);
  assert.equal(f.calls, 0);
});

test('a draft edit interrupts stale confirmation, and a failed edit is not confirmable', async t => {
  const f = await fixture(t), { saveId } = await f.draft();
  const gate = pauseWrite(f), confirm = f.call('retrySave', { saveId }); await gate.writing;
  const edit = f.edit('two'); await turn(); gate.release();
  assert.equal((await confirm).ok, false); assert.equal((await edit).ok, true);
  assert.equal(f.rows()[0].username, 'two'); assert.equal(f.rows()[0].status, 'review');
  f.beforeWrite = async () => { f.beforeWrite = async () => {}; throw Error('write failed'); };
  assert.equal((await f.edit('three')).errorKey, 'saveStorageFailed');
  assert.equal(f.rows()[0].status, 'blocked');
  assert.equal((await f.call('retrySave', { saveId })).ok, false);
  assert.equal((await f.edit('four')).ok, true); assert.equal(f.rows()[0].username, 'four');
  assert.equal(f.calls, 0);
});

test('failed regeneration retains the committed draft; successful regeneration invalidates its old button', async t => {
  const f = await fixture(t), old = await f.draft();
  const gate = pauseWrite(f), replacement = f.draft('second', 'fixture-2'); await gate.writing;
  assert.equal((await f.call('getState')).saves[0].id, old.saveId);
  assert.equal((await f.call('retrySave', { saveId: old.saveId })).ok, false);
  gate.release(); const current = await replacement;
  assert.equal(current.ok, true); assert.notEqual(current.saveId, old.saveId);
  assert.equal((await f.call('retrySave', { saveId: old.saveId })).ok, false);
  f.beforeWrite = async () => { f.beforeWrite = async () => {}; throw Error('storage failed'); };
  assert.equal((await f.draft('third', 'fixture-3')).errorKey, 'saveReplacementFailed');
  assert.deepEqual((await f.call('getState')).saves.map(e => e.id), [current.saveId]);
  assert.equal(f.rows()[0].password === 'fixture-2', true); assert.equal(f.calls, 0);
});

test('expiry clears the secret but preserves delivery uncertainty on recovery and while running', async t => {
  const now = Date.now(), ttl = 40000, timers = [];
  t.mock.method(Date, 'now', () => now);
  const realTimer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms === ttl) { timers.push(fn); return; }
    return realTimer(fn, ms, ...args);
  });
  const states = ['queued', 'saving', 'uncertain'];
  const initial = states.flatMap(status => [-1, ttl].map(ms => ({ id: `${status}-${ms}`, status, expiresAt: now + ms })));
  const f = await fixture(t, initial);
  assert.deepEqual(f.stored(), ['expired', 'review', 'expired', 'uncertain', 'expired', 'uncertain']);
  assert.equal(timers.length, 3); for (const fn of timers) fn(); await turn();
  for (const s of f.rows()) {
    assert.equal(s.status, 'expired'); assert.equal(s.password, '');
    assert.equal(s.messageKey, s.id.startsWith('queued') ? 'saveExpired' : 'saveExpiredUncertain');
  }
  await f.boot();
  assert.deepEqual((await f.call('getState')).saves.map(s => s.messageKey), f.rows().map(s => s.messageKey));
  assert.equal(f.calls, 0);
});
