import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { ApplePasswords, State } from '../src/protocol.js';
import { errorKey } from '../src/shared.js';

// The browser supplies Web Crypto; Node 18 does not expose it globally by default.
globalThis.crypto ??= webcrypto;

for (const [reason, unavailable] of [
  ['Native host has exited.', false], ['The message port closed.', false],
  ['Specified native messaging host not found.', true], ['Access to the specified native messaging host is forbidden.', true],
]) {
  test(`native connection diagnosis: ${reason}`, async t => {
    let reply, drop;
    const port = { onMessage: { addListener(fn) { reply = fn; } }, onDisconnect: { addListener(fn) { drop = fn; } },
      postMessage({ cmd }) { queueMicrotask(() => reply({ cmd, capabilities: {} })); } };
    globalThis.chrome = { runtime: { connectNative: () => port } };
    t.after(() => { delete globalThis.chrome; });
    const client = new ApplePasswords(); await client.connect();
    assert.equal(client.state, State.NeedsPin);
    chrome.runtime.lastError = { message: reason }; drop();
    assert.equal(client.state, unavailable ? State.NoHelper : State.Disconnected);
    assert.equal(errorKey(Error(reason)), unavailable ? 'errorNoHelper' : 'errorConnection');
    assert.equal(client.port, undefined); assert.equal(client.session, undefined);
    delete chrome.runtime.lastError; await client.connect(); assert.equal(client.state, State.NeedsPin);
  });
}
