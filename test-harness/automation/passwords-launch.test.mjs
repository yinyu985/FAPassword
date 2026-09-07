import assert from 'node:assert/strict';
import { passwordsUrl, resolvePasswordsUrl, preparePasswordsLaunch, PASSWORDS_MODERN_SETTINGS_URL, PASSWORDS_SETTINGS_URL, PASSWORDS_HELP_URL } from '../../src/passwords-launch.js';
for (const version of ['13.0', '14.7.6']) assert.equal(passwordsUrl('macOS', version), PASSWORDS_SETTINGS_URL);
for (const version of ['15.0', '26.0', '27.1']) assert.equal(passwordsUrl('macOS', version), PASSWORDS_MODERN_SETTINGS_URL);
for (const version of ['', undefined, '0.0.0', 'invalid', '15x']) assert.equal(passwordsUrl('macOS', version), PASSWORDS_HELP_URL);
assert.equal(passwordsUrl('Windows', '15.0'), PASSWORDS_HELP_URL);
assert.equal(await resolvePasswordsUrl({ userAgent: 'Mac OS X 10_15_7' }), PASSWORDS_HELP_URL);
assert.equal(await resolvePasswordsUrl({ userAgentData: { getHighEntropyValues: async () => { throw new Error('denied'); } } }), PASSWORDS_HELP_URL);
assert.equal(await resolvePasswordsUrl({ userAgent: 'Mac OS X 10_15_7', userAgentData: { getHighEntropyValues: async () => ({platform:'macOS',platformVersion:'26.0.0'}) } }), PASSWORDS_MODERN_SETTINGS_URL);
const modern = { userAgentData: { getHighEntropyValues: async () => ({ platform: 'macOS', platformVersion: '15.7.7' }) } };
for (const response of [{ ok: false }, { ok: true }, undefined]) {
  assert.deepEqual(await preparePasswordsLaunch(async () => response, modern), { native: false, url: PASSWORDS_MODERN_SETTINGS_URL });
}
assert.deepEqual(await preparePasswordsLaunch(async () => { throw new Error('missing helper'); }, modern), { native: false, url: PASSWORDS_MODERN_SETTINGS_URL });
// Native launch still works when the browser withholds OS version information.
assert.deepEqual(await preparePasswordsLaunch(async message => {
  assert.deepEqual(message, { type: 'getPasswordsLauncher' });
  return { ok: true, canOpenPasswords: true };
}, {}), { native: true, url: PASSWORDS_HELP_URL });
console.log('PASS macOS 13/14, 15/26+, unavailable version and frozen-UA launch routing (system launch not tested)');

// Exercise the production background authorization and fixed native action mapping.
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const id = 'passwords-launch-test';
const calls = [];
globalThis.chrome = {
  runtime: { id, getURL: path => `chrome-extension://${id}/${path}`,
    onMessage: event(), onConnect: event(), onInstalled: event(), onStartup: event(),
    connectNative() { throw new Error('No vault transport in launcher tests'); },
    sendNativeMessage(host, message, callback) {
      calls.push({ host, message });
      callback({ ok: true, canOpenPasswords: true, target: 'app' });
    },
  },
  tabs: { onRemoved: event() },
};
await import('../../src/background.js');
const listener = chrome.runtime.onMessage.listeners.at(-1);
const ui = { id, url: chrome.runtime.getURL('src/popup.html') };
const call = (message, sender = ui) => new Promise(resolve => listener(message, sender, resolve));
for (const type of ['getPasswordsLauncher', 'openPasswords']) {
  assert.equal((await call({ type })).ok, true);
  const count = calls.length;
  for (const sender of [
    { id, tab: { id: 1 }, url: 'https://example.test/', frameId: 0, documentId: 'document' },
    { id: 'another-extension', url: ui.url },
  ]) assert.equal((await call({ type }, sender)).ok, false);
  assert.equal(calls.length, count);
}
assert.deepEqual(calls, [
  { host: 'com.fapassword.policy', message: { action: 'passwordsCapabilities' } },
  { host: 'com.fapassword.policy', message: { action: 'openPasswords' } },
]);
// Caller-supplied targets cannot turn the launcher into an arbitrary command runner.
await call({ type: 'openPasswords', action: 'set', url: 'file:///tmp/untrusted.app' });
assert.deepEqual(calls.at(-1).message, { action: 'openPasswords' });
chrome.runtime.sendNativeMessage = (host, message, callback) => {
  chrome.runtime.lastError = { message: 'Native host unavailable' };
  callback();
  delete chrome.runtime.lastError;
};
assert.deepEqual(await call({ type: 'getPasswordsLauncher' }), { ok: false });
assert.deepEqual(await call({ type: 'openPasswords' }), { ok: false });
console.log('PASS native capability detection, popup-only launch, fixed targets and missing-helper errors');
