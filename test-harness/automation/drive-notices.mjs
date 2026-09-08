import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from './e2e-playwright.mjs';
const extension = fileURLToPath(new URL('./.builds/locked', import.meta.url));
const shots = fileURLToPath(new URL('./shots/', import.meta.url));
await mkdir(shots, { recursive: true });
const context = await chromium.launchPersistentContext('unused', { headless: false,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--headless=new'] });
try {
  const worker = context.serviceWorkers()[0];
  for (const locale of ['en', 'zh_CN']) {
    const catalog = JSON.parse(await readFile(new URL(`../../_locales/${locale}/messages.json`, import.meta.url)));
    const popup = await context.newPage();
    popup.setDefaultTimeout(6000);
    const errors = [];
    popup.on('pageerror', error => errors.push(error.message));
    await popup.setViewportSize({ width: 350, height: 900 });
    await popup.addInitScript(({ catalog, locale }) => {
      chrome.i18n.getMessage = (name, substitutions = []) => {
        const entry = catalog[name];
        if (!entry) return name;
        const values = Array.isArray(substitutions) ? substitutions : [substitutions];
        return entry.message.replace(/\$([A-Za-z_]+)\$/g, (match, key) => {
          const token = entry.placeholders?.[key.toLowerCase()]?.content;
          return token ? values[Number(token.slice(1)) - 1] || '' : match;
        });
      };
      chrome.i18n.getUILanguage = () => locale;
      window.fixture = {
        logins: { ok: true, host: 'www.zhipin.com', logins: [] },
        privacyValue: true, refuse: false, copied: '', copyFailed: false,
      };
      chrome.runtime.connect = () => ({
        onMessage: { addListener: listener => fixture.emit = listener },
        onDisconnect: { addListener() {} },
      });
      chrome.runtime.sendMessage = (message, callback) => {
        const responses = {
          retryConnection: { state: 'unlocked' }, getLogins: fixture.logins,
          refreshLogins: { ok: true }, getPasswordsLauncher: { ok: true, canOpenPasswords: true },
          openPasswords: { ok: true, target: 'app' },
          policy: { ok: true, scopeVersion: 2, browserName: 'Helium', hidden: false },
        };
        queueMicrotask(() => callback(responses[message.type] || { ok: true }));
      };
      for (const name of ['passwordSavingEnabled', 'autofillAddressEnabled']) {
        const pref = chrome.privacy.services[name];
        pref.get = (_, callback) => queueMicrotask(() => callback({ value: fixture.privacyValue, levelOfControl: 'controllable_by_this_extension' }));
        pref.set = (_, callback) => { if (!fixture.refuse) fixture.privacyValue = false; queueMicrotask(callback); };
        pref.clear = (_, callback) => { if (!fixture.refuse) fixture.privacyValue = true; queueMicrotask(callback); };
      }
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => {
        if (fixture.copyFailed) throw new Error('fixture copy failure');
        fixture.copied = text;
      } } });
    }, { catalog, locale });
    await popup.goto(new URL('popup.html', worker.url()).href);
    await popup.waitForFunction(() => document.querySelector('#status-message').textContent === chrome.i18n.getMessage('noLogins'));
    assert.equal(await popup.locator('#site').isVisible(), false);
    const metrics = selector => popup.locator(selector).evaluate(el => {
      const css = getComputedStyle(el);
      return Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'padding', 'margin', 'color'].map(key => [key, css[key]]));
    });
    const typography = ({ color, ...rest }) => rest;
    await popup.locator('details').evaluate(el => el.open = true);
    for (const theme of ['light', 'dark']) {
      await popup.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const normal = await metrics('#status-message');
      assert.equal(normal.fontSize, '13px');
      assert.equal(normal.fontWeight, '650');
      assert.equal(normal.padding, '8px 0px');
      assert.equal(normal.color, theme === 'dark' ? 'rgb(241, 242, 239)' : 'rgb(23, 26, 24)');
      assert.deepEqual(await metrics('#policy-scope'), normal);
      await popup.evaluate(() => fixture.emit({ type: 'state', state: 'unlocked', saves: [
        { id: '1', host: 'test.example', username: 'test', status: 'submitted', messageKey: 'saveSubmitted' },
        { id: '2', host: 'test.example', username: 'test', status: 'failed', messageKey: 'saveFailed' },
      ] }));
      assert.deepEqual(await metrics('#save-list li:first-child p'), normal);
      const saveError = await metrics('#save-list li:last-child p');
      assert.deepEqual(typography(saveError), typography(normal));
      assert.equal(saveError.color, theme === 'dark' ? 'rgb(241, 154, 148)' : 'rgb(162, 52, 47)');
      const saveStates = [
        ['queued', 'saveQueued', false], ['queued', 'saveWaitingUnlock', false],
        ['saving', 'saveSending', false], ['submitted', 'saveSubmitted', false],
        ['uncertain', 'saveUncertain', true], ['failed', 'saveFailed', true],
        ['expired', 'saveExpired', true], ['cancelled', 'saveCancelled', false],
        ['skipped', 'saveUnchanged', false], ['skipped', 'saveNoAccount', true],
      ];
      for (const [status, messageKey, failed] of saveStates) {
        await popup.evaluate(({ status, messageKey }) => fixture.emit({ type: 'state', state: 'unlocked', saves: [
          { id: 'state', host: 'test.example', username: 'test', status, messageKey },
        ] }), { status, messageKey });
        assert.deepEqual(await metrics('#save-list p'), failed ? saveError : normal, messageKey);
      }
      await popup.evaluate(() => { fixture.logins = { ok: false, errorKey: 'loadFailed' }; });
      await popup.locator('#refresh').click();
      await popup.waitForFunction(() => document.querySelector('#status-message').classList.contains('failed'));
      assert.deepEqual(await metrics('#status-message'), saveError);
      await popup.evaluate(() => { fixture.logins = { ok: true, host: 'www.zhipin.com', logins: [] }; });
      await popup.locator('#refresh').click();
      await popup.waitForFunction(() => !document.querySelector('#status-message').classList.contains('failed'));
      assert.deepEqual(await metrics('#status-message'), normal);
      for (const [toggle, note] of [['#pm-toggle', '#pm-note'], ['#af-toggle', '#af-note']]) {
        await popup.evaluate(() => { fixture.refuse = true; });
        await popup.locator(toggle).click();
        await popup.waitForFunction(note => document.querySelector(note).classList.contains('failed'), note);
        await popup.waitForTimeout(100);
        assert.deepEqual(await metrics(note), saveError);
        assert.equal(await popup.locator(toggle).isChecked(), false);
        await popup.evaluate(() => { fixture.refuse = false; });
        await popup.locator(toggle).click();
        await popup.waitForFunction(note => document.querySelector(note).textContent === '', note);
        assert.equal(await popup.locator(toggle).isChecked(), true);
        await popup.evaluate(() => { fixture.refuse = true; });
        await popup.locator(toggle).click();
        await popup.waitForFunction(note => document.querySelector(note).classList.contains('failed'), note);
        assert.equal(await popup.locator(toggle).isChecked(), true);
        await popup.evaluate(() => { fixture.refuse = false; });
        await popup.locator(toggle).click();
        await popup.waitForFunction(note => document.querySelector(note).textContent === '', note);
      }
      await popup.locator('#generate-password').click();
      assert.equal(await popup.inputValue('#password-length'), '16');
      assert.equal(await popup.locator('#include-special').isChecked(), false);
      assert.match(await popup.inputValue('#generated-password'), /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9]{16}$/);
      assert.equal(await popup.locator('label[for="generated-password"], #generated-password-help').count(), 0);
      await popup.locator('#copy-generated-password').click();
      await popup.waitForFunction(() => document.querySelector('#status-message').textContent === chrome.i18n.getMessage('passwordCopied'));
      assert.equal(await popup.evaluate(() => fixture.copied), await popup.inputValue('#generated-password'));
      assert.deepEqual(await metrics('#status-message'), normal);
      await popup.evaluate(() => { fixture.copyFailed = true; });
      await popup.locator('#copy-generated-password').click();
      await popup.waitForFunction(() => document.querySelector('#status-message').classList.contains('failed'));
      assert.deepEqual(await metrics('#status-message'), saveError);
      await popup.evaluate(() => { fixture.copyFailed = false; });
      await popup.locator('#include-special').check();
      await popup.locator('#password-length').fill('24');
      await popup.locator('#generate-password').click();
      const special = await popup.inputValue('#generated-password');
      assert.equal(special.length, 24); assert.match(special, /[^A-Za-z0-9]/);
      for (const [requested, expected] of [['7', 8], ['65', 64]]) {
        await popup.locator('#password-length').fill(requested);
        await popup.locator('#generate-password').click();
        assert.equal((await popup.inputValue('#generated-password')).length, expected);
        assert.equal(await popup.inputValue('#password-length'), String(expected));
      }
      await popup.locator('#include-special').uncheck();
      await popup.locator('#password-length').fill('');
      await popup.locator('#generate-password').click();
      assert.equal(await popup.inputValue('#generated-password').then(s => s.length), 16);
      await popup.locator('#refresh').click();
      await popup.waitForFunction(() => document.querySelector('#status-message').textContent === chrome.i18n.getMessage('noLogins'));
      assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await popup.locator('body').screenshot({ path: shots + `notices-${locale}-${theme}.png` });
      console.log(`PASS ${locale}/${theme}: notices match, errors recover, both toggle failures persist, generator and copy work`);
    }
    await popup.evaluate(() => { fixture.logins = { ok: true, host: 'www.zhipin.com', logins: [{ username: 'test' }], targetId: 'test' }; });
    await popup.locator('#refresh').click();
    await popup.locator('#site').waitFor({ state: 'visible' });
    await popup.evaluate(() => fixture.emit({ type: 'state', state: 'disconnected' }));
    assert.equal(await popup.locator('#site').isVisible(), false);
    assert.deepEqual(errors, []);
    await popup.close();
  }
} finally { await context.close(); }
