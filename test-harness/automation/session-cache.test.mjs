import assert from 'node:assert/strict';
import { SessionCache, credentialKey } from '../../src/session-cache.js';
const cache = new SessionCache(120000);
try {
  const names = ['Alice', 'alice', ' alice', 'alice ', 'ali\u200bce'];
  for (const name of names) cache.set(credentialKey('https://example.com', name), name);
  for (const name of names) assert.equal(cache.get(credentialKey('https://example.com', name)), name);
  assert.equal(new Set(names.map(name => credentialKey('https://example.com', name))).size, 5);
  console.log('PASS exact usernames never share a password cache entry');
  const now = Date.now;
  try { Date.now = () => now() + 120001; assert.equal(cache.get(credentialKey('https://example.com', 'Alice')), undefined); }
  finally { Date.now = now; }
  console.log('PASS wall-clock expiration works before deletion timers run');
  let calls = 0, resolve;
  const queries = Array.from({length:8}, () => cache.query('site', () => { calls++; return new Promise(r => resolve=r); }));
  await Promise.resolve(); assert.equal(calls, 1); resolve(['account']);
  assert.deepEqual(await Promise.all(queries), Array(8).fill(['account']));
  console.log('PASS eight concurrent account queries use one loader');
  let complete;
  const pending = cache.query('late', () => new Promise(r => complete=r));
  await Promise.resolve(); cache.clear(); complete(['stale']);
  await assert.rejects(pending, /session changed/); assert.equal(cache.get('late'), undefined);
  console.log('PASS a locked or replaced session cannot repopulate the cache');
  let ready = true;
  const guarded = new SessionCache(1000, () => ready);
  guarded.set('key', 'secret'); ready = false;
  assert.equal(guarded.get('key'), undefined); assert.throws(() => guarded.set('key','secret'));
  guarded.clear();
  console.log('PASS reads and writes require a usable session');
} finally { cache.clear(); }
