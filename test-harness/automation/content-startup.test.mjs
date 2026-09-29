// Run the actual classic content scripts without a browser or native helper.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { isLocalDevHost, pageContext } from "../../src/shared.js";

const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
const scripts = await Promise.all(manifest.content_scripts[0].js.map(async (filename) =>
  new vm.Script(await readFile(new URL(filename, root), "utf8"), { filename })));

function start(url) {
  const messages = [], listeners = [], events = new Map();
  let randomBytes = 0;
  const window = { addEventListener: (name, listener) => events.set(name, listener) };
  window.top = window;
  const context = vm.createContext({
    window, location: new URL(url),
    document: { addEventListener() {}, visibilityState: "visible" },
    // This matches the missing capability in the reported HTTP context.
    crypto: { getRandomValues(bytes) { randomBytes += bytes.byteLength; return webcrypto.getRandomValues(bytes); } },
    chrome: { runtime: {
      id: "test-extension",
      onMessage: { addListener: listener => listeners.push(listener) },
      sendMessage: async message => { messages.push(message); return { ok: false, errorKey: "pageUnavailable" }; },
    } },
  });
  for (const script of scripts) script.runInContext(context);
  const describe = documentKey => new Promise(resolve => {
    assert.equal(listeners[0]({ type: "describeFrame", documentKey }, { id: "test-extension" }, resolve), true);
  });
  return { messages, events, describe, randomBytes: () => randomBytes };
}

const url = "http://cicd.alibaba-inc.com/new#/change/systemTask?task_uuid=example";
const first = start(url);
assert.equal(first.messages.length, 1);
assert.equal(first.messages[0].type, "frameReady");
const documentKey = first.messages[0].documentKey;
assert.match(documentKey, /^[0-9a-f]{32}$/);
assert.equal(first.randomBytes(), 16);
first.events.get("pageshow")();
assert.equal(first.messages[1].documentKey, documentKey);
assert.equal((await first.describe(documentKey)).documentKey, documentKey);
assert.equal((await first.describe("stale-document")).errorKey, "errorPageChanged");
const second = start(url);
assert.notEqual(second.messages[0].documentKey, documentKey);
assert.equal((await second.describe(documentKey)).errorKey, "errorPageChanged");
assert(first.messages.every(message => message.type === "frameReady"));
const page = pageContext(url);
assert.equal(page.secure || isLocalDevHost(page.host), false);
console.log("PASS HTTP content startup without randomUUID, document identity isolation and unchanged HTTP security policy");
