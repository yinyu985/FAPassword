// Faults found in the release audit. Real trusted gestures, mock native only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from './e2e-playwright.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const build = root + '/test-harness/automation/.builds/unlocked';
const source = await readFile(root + '/src/content.js', 'utf8');
const expected = source.replace('attachShadow({ mode: "closed" })', 'attachShadow({ mode: "open" })')
  .replace('box.setAttribute("role", "listbox");', 'box.setAttribute("role", "listbox"); box.setAttribute("data-fapassword", "suggestions");');
assert.equal(await readFile(build + '/src/content.js', 'utf8'), expected, 'Mock content is stale');
for (const file of ['field-policy.js', 'background.bundle.js']) {
  assert.deepEqual(await readFile(build + '/src/' + file), await readFile(root + '/src/' + file), file + ' is stale');
}
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<!doctype html><meta charset="utf-8"><style>body{margin:30px}input,button{display:block;width:260px;height:32px;margin:9px}</style>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let context;
let cases = 0;
try {
  context = await chromium.launchPersistentContext('', { headless: true, args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`] });
  context.setDefaultTimeout(7000);
  const worker = context.serviceWorkers()[0];
  const ui = await context.newPage();
  await ui.goto(new URL('popup.html', worker.url()).href);
  const api = message => ui.evaluate(message => chrome.runtime.sendMessage(message), message);
  const page = await context.newPage();
  let index = 0;
  const nativeCount = () => worker.evaluate(() => testNative.counters.saves);
  const form = (password = 'DefaultFixture123', attrs = '') => `<form><input id=u name=username autocomplete=username value=release-${index + 1} ${attrs}><input id=p name=password type=password autocomplete=current-password value="${password}" ${attrs}><button>Login</button></form>`;
  async function test(name, html, setup, action, native, verify) {
    for (const save of (await api({ type: 'getState' })).saves || []) {
      assert.equal((await api({ type: 'cancelSave', saveId: save.id })).ok, true);
    }
    await page.goto(base + '/case-' + (++index));
    await page.evaluate(html => {
      document.body.innerHTML = html;
      window.probe = { submits: 0, actions: 0 };
      document.addEventListener('submit', event => { event.preventDefault(); probe.submits++; });
    }, html);
    await page.bringToFront();
    if (setup) await setup(page);
    const before = await nativeCount();
    await action(page);
    if (native) {
      const deadline = Date.now() + 4000;
      while (await nativeCount() - before < native && Date.now() < deadline) await delay(20);
    }
    await delay(400);
    const state = await api({ type: 'getState' });
    assert.equal(await nativeCount() - before, native, name + ': native count');
    if (native) {
      const saved = await worker.evaluate(() => testNative.saves.at(-1));
      assert.equal(saved.host, new URL(base).host, name + ': host including port');
      assert.equal(saved.action, 4, name + ': MAYBE_ADD');
      assert.deepEqual(await worker.evaluate(() => testNative.saveTargets.at(-1)),
        { tabId: await page.evaluate(() => window.probe.tabId), frameId: 0 }, name + ': native tab/frame');
    }
    if (verify) await verify(page, worker, state);
    cases++;
    console.log('PASS ' + name);
  }
  // The mock records each frame's tab identity without granting page code extension APIs.
  const setTab = async p => {
    const frames = await worker.evaluate(() => testNative.frames);
    const frame = frames.filter(frame => frame.url === p.url() && frame.frameId === 0).at(-1);
    assert.ok(frame, 'Current fixture content must have registered its frame');
    await p.evaluate(tabId => { probe.tabId = tabId; }, frame.tabId);
  };
  const click = async p => { await setTab(p); await p.locator('button').click(); };
  const compare = async (p, w) => {
    const saved = await w.evaluate(() => testNative.saves.at(-1));
    const actual = await p.evaluate(() => window.actual || { username: document.querySelector('#u')?.value, password: document.querySelector('#p')?.value });
    assert.equal(saved.username, actual.username, 'Native account must equal actual submitted account');
    assert.equal(saved.password, actual.password, 'Native password must equal actual submitted password');
    assert.equal(saved.qid, 'CmdSetPassword4LoginName_URL');
  };
  const recordAndReset = p => p.evaluate(() => document.querySelector('form').addEventListener('submit', () => {
    const data = new FormData(document.querySelector('form'));
    window.actual = { username: data.get('username'), password: data.get('password') };
    document.querySelector('form').reset();
  }));
  await test('trusted native submit preserves account and password', form(), null, click, 1, compare);
  await test('submit then reset does not save the HTML default password', form(), recordAndReset,
    async p => { await p.locator('#p').fill('UserTypedFixture789'); await click(p); }, 1, compare);
  await test('valid required submission survives a reset to empty fields', form('', 'required'), recordAndReset,
    async p => { await p.locator('#u').fill('submitted-account'); await p.locator('#p').fill('UserTypedFixture789'); await click(p); }, 1, compare);
  await test('submit handler normalization followed by FormData and reset preserves the actual payload', form(),
    p => p.evaluate(() => document.querySelector('form').addEventListener('submit', () => {
      document.querySelector('#p').value = 'SubmitNormalizedFixture123';
      document.querySelector('#u').value = 'normalized-account';
      const data = new FormData(document.querySelector('form'));
      window.actual = { username: data.get('username'), password: data.get('password') };
      document.querySelector('form').reset();
    })), click, 1, compare);
  await test('asynchronous prerequisite retains the intent for requestSubmit', form(),
    p => p.evaluate(() => document.querySelector('button').addEventListener('click', event => {
      event.preventDefault(); setTimeout(() => document.querySelector('form').requestSubmit(), 100);
    })), click, 1, compare);

  const generation = '<form><input name=username autocomplete=username value=generated-account><input id=p name=password type=password autocomplete=new-password><button type=button>Done</button></form>';
  const generate = async p => { await p.locator('#p').click(); await p.locator('[data-op-generate]').first().waitFor(); await p.locator('[data-op-generate]').first().click(); };
  const rerender = p => p.evaluate(() => document.querySelector('#p').addEventListener('input', event => {
    const form = document.querySelector('form'); const next = form.cloneNode(true);
    next.querySelector('#p').value = event.target.value; form.replaceWith(next);
  }, { once: true }));
  await test('generated password retains its review candidate through an exact component replacement', generation, rerender,
    generate, 0, async (p, w, state) => {
      assert.ok((await p.inputValue('#p')).length);
      assert.equal(state.saves.length, 1); assert.equal(state.saves[0].status, 'review');
      const entries = await w.evaluate(() => chrome.storage.session.get('pendingCredentialSavesV1'));
      assert.equal(entries.pendingCredentialSavesV1[0].password, await p.inputValue('#p'));
    });
  await test('rerendered empty confirmation retains a blocked candidate, never a confirmable mismatch',
    generation.replace('<button', '<input id=c type=password autocomplete=new-password><button'), rerender,
    generate, 0, async (p, w, state) => {
      assert.ok((await p.inputValue('#p')).length); assert.equal(await p.inputValue('#c'), '');
      assert.equal(state.saves.length, 1); assert.equal(state.saves[0].status, 'blocked');
      assert.equal(state.saves[0].messageKey, 'errorPasswordConfirmation');
    });
  await test('edited generator candidate uses the value after input normalization', generation,
    p => p.evaluate(() => document.querySelector('#p').addEventListener('input', event => { if (event.isTrusted) event.target.value = 'NormalizedFixture789'; })),
    async p => {
      await setTab(p); await generate(p); await delay(100); await p.locator('#p').fill('RawFixture789');
      await delay(150); await ui.bringToFront(); await ui.locator('#save-list li').last().locator('button').first().click();
    }, 1, async (p, w) => {
      const saved = await w.evaluate(() => testNative.saves.at(-1));
      assert.equal(saved.username, 'generated-account'); assert.equal(saved.password, await p.inputValue('#p'));
      assert.equal(saved.qid, 'CmdNewAccount4URL');
    });
  await test('canceling a username stage cannot attach that account to an unrelated change form',
    '<form><input id=u autocomplete=username><button type=button id=next>Next</button></form>',
    p => p.evaluate(() => document.querySelector('#next').addEventListener('click', () => {
      document.querySelector('form').outerHTML = '<form><input type=password id=p><button type=button id=cancel>Cancel</button></form>';
      document.querySelector('#cancel').addEventListener('click', () => {
        document.querySelector('form').outerHTML = '<form><input type=hidden name=username value=actual-new-account><input type=password name=oldpassword autocomplete=current-password value=OldFixture123><input type=password name=password autocomplete=new-password value=NewFixture123><button>Change password</button></form>';
      });
    })), async p => { await p.locator('#u').fill('cancelled-stage-account'); await p.locator('#next').click(); await p.locator('#cancel').click(); await click(p); },
    0, async (p, w, state) => {
      assert.equal(state.saves.length, 1); assert.equal(state.saves[0].status, 'needsAccount');
      assert.equal(state.saves[0].username, '', 'Hidden account must require explicit selection, not stale context');
    });
  await test('readonly password can be read from a genuine submit without becoming fillable', form().replace('id=p', 'id=p readonly'), null, click, 1, compare);
  await test('ordinary Save profile does not imply a credential submission', form().replace('<button>Login</button>', '<button type=button>Save profile</button>'),
    p => p.evaluate(() => document.querySelector('button').addEventListener('click', () => probe.actions++)), click, 0);
  await test('asynchronous SPA removal keeps the credential snapshot', form().replace('<button>Login</button>', '<button type=button>Login</button>'),
    p => p.evaluate(() => document.querySelector('button').addEventListener('click', event => {
      event.preventDefault(); window.actual = { username: document.querySelector('#u').value, password: document.querySelector('#p').value };
      setTimeout(() => { probe.actions++; document.querySelector('form').remove(); }, 100);
    })), click, 1, compare);
  await test('native Continue advancing an intermediate wizard does not auto-save', form().replace('<button>Login</button>', '<button>Continue</button>'),
    p => p.evaluate(() => document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); probe.actions++; document.querySelector('form').innerHTML = '<p>Intermediate step</p>'; })), click, 0);
  await test('rejected registration temporarily disabling inputs does not auto-save', form().replace('<button>Login</button>', '<button type=button>Create account</button>'),
    p => p.evaluate(() => document.querySelector('button').addEventListener('click', event => {
      event.preventDefault(); document.querySelectorAll('input').forEach(input => { input.disabled = true; });
      setTimeout(() => document.querySelectorAll('input').forEach(input => { input.disabled = false; }), 100);
    })), click, 0);
  await test('Space on an inactive ARIA Login control does not auto-save', form().replace('<button>Login</button>', '<div role=button tabindex=0>Login</div>'),
    null, async p => { await p.locator('[role=button]').focus(); await p.keyboard.press('Space'); }, 0);
  await test('inactive ARIA Space cannot save through a later unrelated navigation', form().replace('<button>Login</button>', '<div role=button tabindex=0>Login</div>'),
    null, async p => { await p.locator('[role=button]').focus(); await p.keyboard.press('Space'); await delay(400); await p.goto(base + '/unrelated-navigation'); }, 0);
  await test('keyboard Space Next retains the explicitly entered account', '<form><input id=u autocomplete=username><button type=button id=next>Next</button></form>',
    p => p.evaluate(() => document.querySelector('#next').addEventListener('click', () => {
      document.querySelector('form').outerHTML = '<form><input type=password autocomplete=current-password value=KeyboardFixture123><button>Login</button></form>';
    })), async p => { await p.locator('#u').fill('keyboard-stage-account'); await p.locator('#next').focus(); await p.keyboard.press('Space'); await click(p); },
    1, async (p, w) => {
      const saved = await w.evaluate(() => testNative.saves.at(-1));
      assert.equal(saved.username, 'keyboard-stage-account'); assert.equal(saved.password, 'KeyboardFixture123');
      assert.equal(saved.qid, 'CmdSetPassword4LoginName_URL');
    });
  console.log(`==== ${cases}/${cases} save failure regressions PASS; simulated native only ====`);
} finally {
  if (context) await context.close();
  await new Promise(resolve => server.close(resolve));
}
