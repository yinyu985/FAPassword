import test from 'node:test';
import assert from 'node:assert/strict';
import { createLanguage } from '../src/language.js';

test('language: defaults to browser, persists overrides, formats placeholders, rolls back failed writes', async () => {
  let setting, changed, fail = false, repaints = 0;
  const api = { i18n: { getMessage: key => `browser:${key}`, getUILanguage: () => 'fr' }, storage: {
    onChanged: { addListener(fn) { changed = fn; } }, local: {
      async get() { return { uiLanguage: setting }; }, async set({ uiLanguage }) {
        if (fail) throw Error('write failed'); setting = uiLanguage; changed({ uiLanguage: { newValue: setting } }, 'local');
      } } } };
  const a = createLanguage(api, () => repaints++); await a.ready;
  assert.equal(a.t('fill'), 'browser:fill');
  await a.set('zh_CN'); assert.equal(a.lang, 'zh-CN');
  assert.equal(a.t('refillAccount', ['A$2', 'fixture.invalid']), '重新填充 fixture.invalid 上的 A$2');
  await a.set('en'); assert.equal(a.t('fillAccount', 'A'), 'Fill A'); assert.equal(repaints, 2);
  const b = createLanguage(api); await b.ready; assert.equal(b.choice, 'en');
  fail = true; await assert.rejects(b.set('zh_CN')); assert.equal(b.choice, 'en');
  fail = false; await b.set('auto'); assert.equal(b.lang, 'fr');
});
