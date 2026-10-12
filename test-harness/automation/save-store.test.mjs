import assert from 'node:assert/strict';
import { createSaveStore } from '../../src/save-store.js';
const data = {};
const access = [];
const storage = {
  async setAccessLevel(value) { access.push(value); },
  async get(key) { return structuredClone({ [key]: data[key] }); },
  async set(value) { await new Promise(resolve => setTimeout(resolve, 5)); Object.assign(data, structuredClone(value)); },
};
const store = createSaveStore(storage);
assert.deepEqual(await store.load(), []);
assert.deepEqual(access, [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
const entry = { id: 'candidate', password: 'Fixture123', username: 'fixture', status: 'queued',
  target: { origin: 'https://example.test' }, expiresAt: Date.now() + 180000, controller: {}, timer: 123 };
const first = store.save([entry]);
entry.password = ''; entry.status = 'submitted';
const second = store.save([entry]);
await Promise.all([first, second]);
const recovered = await createSaveStore(storage).load();
assert.equal(recovered[0].password, '');
assert.equal(recovered[0].status, 'submitted');
assert.equal('controller' in recovered[0], false);
assert.equal('timer' in recovered[0], false);
await store.save([]);
assert.deepEqual(await store.load(), []);
let fails = true;
const recovering = createSaveStore({ ...storage, async set(value) { if (fails) throw new Error('storage unavailable'); await storage.set(value); } });
await recovering.load();
await assert.rejects(recovering.save([entry]));
fails = false;
await recovering.save([]);
assert.deepEqual(await recovering.load(), []);
await store.save([entry]);
const unreadable = createSaveStore({ ...storage, async get() { throw new Error('recovery unavailable'); } });
await assert.rejects(unreadable.load());
await assert.rejects(unreadable.save([]));
assert.equal((await store.load()).length, 1, 'failed recovery cannot overwrite unknown pending entries');
await store.save([]);
console.log('PASS session storage is trusted-context only; ordered snapshots clear secrets and recover from failed writes');
console.log('PASS a failed recovery read cannot overwrite previously queued credentials');
