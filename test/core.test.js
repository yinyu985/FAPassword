import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { SessionCache } from '../src/session-cache.js';
import { createSaveStore } from '../src/save-store.js';
import '../src/page-policy.js';

const policy = globalThis.FAPASSWORD_PAGE_POLICY;

test('credential policy allows HTTPS and only the supported HTTP loopback hosts', () => {
  for (const url of ['https://miwifi.com/', 'http://localhost:8080/', 'http://app.localhost/', 'http://127.0.0.1/', 'http://[::1]/']) {
    assert.equal(policy.allows(new URL(url)), true, url);
  }
  for (const url of ['http://miwifi.com/', 'http://192.168.1.1/', 'http://localhost.example/', 'http://localhost@example.net/', 'file:///local']) {
    assert.equal(policy.allows(new URL(url)), false, url);
  }
});

test('unsupported pages exit before content code touches the DOM or extension APIs', async () => {
  const content = await readFile(new URL('../src/content.js', import.meta.url), 'utf8');
  for (const [url, ancestors] of [['http://miwifi.com/', []], ['https://login.example/', ['http://miwifi.com']]]) {
    const location = Object.assign(new URL(url), { ancestorOrigins: ancestors });
    // No document or chrome globals: installing any listener or sending a message would throw.
    runInNewContext(content, { URL, location, FAPASSWORD_PAGE_POLICY: policy });
  }
});

test('a pending cache lookup cannot restore a credential after the session is cleared', async () => {
  const cache = new SessionCache(10000);
  let complete;
  const loading = new Promise(resolve => { complete = resolve; });
  try {
    const pending = cache.query('account', () => loading);
    cache.clear();
    complete('fixture');
    await assert.rejects(pending, /session changed/);
    assert.equal(cache.get('account'), undefined);
  } finally { cache.clear(); }
});

test('failed save-queue recovery never overwrites the unread queue', async () => {
  let writes = 0;
  const store = createSaveStore({
    setAccessLevel: async ({ accessLevel }) => assert.equal(accessLevel, 'TRUSTED_CONTEXTS'),
    get: async () => { throw new Error('read failed'); },
    set: async () => { writes++; },
  });
  await assert.rejects(store.load(), /read failed/);
  await assert.rejects(store.save(() => []), /recovery unavailable/);
  assert.equal(writes, 0);
});
