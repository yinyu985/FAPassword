import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';

// Drive the shipped event handlers in memory; no browser, native host or real credentials.
import { createLanguage } from '../src/language.js';
const content = await readFile(new URL('../src/content.js', import.meta.url), 'utf8');
async function fixture({ generation = false, preparation = false } = {}) {
  const listeners = {}, saves = [], tasks = new Map();
  const document = { addEventListener(type, fn) { (listeners[type] ??= []).push(fn); } };
  const window = { addEventListener() {} }; window.top = window;
  class Element { getRootNode() { return document; } matches() { return false; } }
  class HTMLInputElement extends Element {
    get value() { return this.text ?? ''; }
    set value(v) { this.text = v; }
    dispatchEvent() {}
  }
  const form = Object.assign(new Element(), { tagName: 'FORM', isConnected: true, querySelectorAll: () => [] });
  const field = Object.assign(new HTMLInputElement(), { tagName: 'INPUT', type: 'password', name: 'pw', form, isConnected: true });
  const confirm = Object.assign(new HTMLInputElement(), { ...field, name: 'confirm' });
  const account = Object.assign(new HTMLInputElement(), { ...field, type: 'text', name: 'account' });
  const page = content.replace(/\}\)\(\);\s*$/, 'Object.assign(window, { generate: fillGeneratedPassword, prepare: prepareFill }); })();');
  const fields = () => preparation || generation ? [field, confirm] : field.isConnected ? [field] : [];
  runInNewContext(page, {
    FAPASSWORD_LANGUAGE: createLanguage, crypto: webcrypto, document, window, Event, Element, HTMLInputElement, ShadowRoot: class {}, MutationObserver: class { observe() {} disconnect() {} },
    location: { protocol: 'https:', ancestorOrigins: [] }, FAPASSWORD_PAGE_POLICY: { allows: () => true },
    FAPASSWORD_FIELDS: { classify: () => ({ inputs: preparation ? [...fields(), account] : fields(), passwords: fields(), usernames: preparation ? [account] : [] }), scopeFor: () => form,
      isPasswordish: e => e.type === 'password', isUsernameField: e => e === account,
      isLoginField: () => true, isReadable: () => true, isFillable: () => true, everPassword: new WeakSet(),
      isVisible: () => true, isNewPasswordField: () => generation, attrBlob: () => '' },
    setTimeout(fn, ms) { tasks.set(fn, ms); return fn; }, clearTimeout(fn) { tasks.delete(fn); },
    chrome: { storage: { local: { get: async () => ({ automaticSave: !generation }) } }, runtime: { onMessage: { addListener() {} },
      async sendMessage(m) { if (m.type === 'resolveSave') saves.push(m.password); return { ok: true }; } } },
  });
  await new Promise(resolve => setImmediate(resolve));
  function emit(type, target, extra = {}) {
    for (const fn of listeners[type] || []) fn({ target, type, isTrusted: true, ...extra });
  }
  function tick() { for (const [fn, ms] of [...tasks]) if (!ms && tasks.delete(fn)) fn(); }
  return { field, confirm, account, prepare: window.prepare, form, emit, tick, saves, generate: value => window.generate(field, value),
    enter: () => emit('keydown', field, { key: 'Enter' }) };
}

test('preparation requires an explicit password field or a unique current-password candidate', async () => {
  const f = await fixture({ preparation: true });
  // No focus: the first DOM candidate is itself a password. That is not a user selection.
  assert.throws(() => f.prepare(), /errorChooseField/);
  assert.throws(() => f.prepare(f.account), /errorChooseField/);
  assert.equal(f.prepare(f.confirm).stage, 'password');
  f.confirm.autocomplete = 'current-password'; assert.equal(f.prepare(f.account).stage, 'password');
  f.field.autocomplete = 'current-password'; assert.throws(() => f.prepare(f.account), /errorChooseField/);
});

test('regeneration updates a generated confirmation, not a manual edit or deliberate clear', async () => {
  const f = await fixture({ generation: true });
  f.generate('first'); assert.equal(f.confirm.value, 'first');
  f.generate('second'); assert.equal(f.confirm.value, 'second');
  f.confirm.value = 'manual'; f.emit('input', f.confirm);
  f.generate('third'); assert.equal(f.confirm.value, 'manual');
  f.confirm.value = ''; f.emit('input', f.confirm);
  f.generate('fourth'); assert.equal(f.confirm.value, ''); assert.equal(f.field.value, 'fourth');
  assert.deepEqual(f.saves, []);
});

test('clearing before submission does not revive a recent input or activation snapshot', async () => {
  const f = await fixture();
  f.field.value = 'fixture'; f.emit('input', f.field); f.tick();
  f.field.value = ''; f.emit('input', f.field); f.tick();
  f.enter(); f.emit('submit', f.form); f.tick();
  assert.deepEqual(f.saves, []);
  f.field.value = 'fixture'; f.enter(); f.field.value = '';
  f.emit('submit', f.form); f.tick();
  assert.deepEqual(f.saves, []);
});

test('removing a password field after an explicit action retains that action’s candidate', async () => {
  const f = await fixture();
  f.field.value = 'fixture'; f.enter(); f.field.isConnected = false; f.tick();
  assert.deepEqual(f.saves, ['fixture']);
});

test('reset and formdata after submit cannot replace the submitted value', async () => {
  const f = await fixture();
  f.field.value = 'fixture'; f.enter(); f.emit('submit', f.form);
  f.emit('reset', f.form); f.field.value = '';
  f.emit('formdata', f.form, { formData: { getAll: () => [''] } }); f.tick();
  assert.deepEqual(f.saves, ['fixture']);
});
