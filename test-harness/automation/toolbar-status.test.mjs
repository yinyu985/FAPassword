import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createToolbarStatus } from "../../src/toolbar-status.js";

const english = JSON.parse(await readFile(new URL("../../_locales/en/messages.json", import.meta.url)));
const chinese = JSON.parse(await readFile(new URL("../../_locales/zh_CN/messages.json", import.meta.url)));
const icons = [], titles = [];
const api = {
  runtime: { getURL: path => `chrome-extension://toolbar-test/${path}` },
  i18n: { getMessage(key) { assert.ok(chinese[key]?.message); return english[key].message; } },
  action: {
    async setIcon(value) { icons.push(value); },
    async setTitle({ title }) { titles.push(title); },
  },
};
let loads = 0;
const red = { 16: { fixture: "red-background-original-artwork" } };
const toolbar = createToolbarStatus(api, () => {
  loads++;
  return Promise.resolve(red);
});
await toolbar.update("disconnected", true);
assert.equal(icons.at(-1).imageData, red, "connecting must warn before any connection failure is reported");
assert.match(titles.at(-1), /Connecting/);
await toolbar.update("needs_pin");
assert.equal(icons.at(-1).imageData, red, "a helper connection without successful unlock must stay red");
assert.match(titles.at(-1), /Locked.*unlock/);
console.log("PASS connecting and waiting for PIN both stay red");

await toolbar.update("no_helper");
assert.equal(icons.at(-1).imageData, red);
assert.match(titles.at(-1), /helper unavailable/);
await toolbar.update("disconnected");
assert.equal(icons.at(-1).imageData, red);
assert.match(titles.at(-1), /Connection failed/);
await toolbar.update("disconnected", true);
assert.equal(icons.at(-1).imageData, red, "retrying must not reset the warning to white");
assert.match(titles.at(-1), /Connecting/);
await toolbar.update("unlocked");
assert.ok(icons.at(-1).path);
for (const [size, path] of Object.entries(icons.at(-1).path)) {
  assert.equal(new URL(path, "chrome-extension://toolbar-test/src/background.bundle.js").pathname,
    `/icons/icon${size}.png`, "normal icons must resolve from the extension root, not src/icons");
}
assert.match(titles.at(-1), /Connected and unlocked/);
const count = icons.length;
await Promise.all(Array.from({ length: 8 }, () => toolbar.update("unlocked")));
assert.equal(icons.length, count);
assert.equal(loads, 1);
console.log("PASS failures and retries stay red, recovery restores artwork, repeated notifications reuse state and bitmap");

await toolbar.update("needs_pin");
assert.equal(icons.at(-1).imageData, red, "losing authorization must turn an unlocked white icon red again");
await toolbar.update("unlocked");
assert.ok(icons.at(-1).path);
console.log("PASS session relock turns red and successful reauthentication restores white");

for (const connecting of [true, false]) {
  let finishDecode;
  const writes = [];
  const delayed = createToolbarStatus({ ...api, action: {
    async setIcon(value) { writes.push(value); }, async setTitle() {},
  } }, () => new Promise(resolve => { finishDecode = () => resolve(red); }));
  const pending = delayed.update("disconnected", connecting);
  const recovered = delayed.update("unlocked");
  finishDecode();
  await Promise.all([pending, recovered]);
  assert.ok(writes.length > 0);
  assert.ok(writes.every(icon => icon.path), "late startup/failure decoding must not flash red after recovery");
}
console.log("PASS late startup and failure bitmap decoding cannot overwrite a successfully unlocked session");

let finishWrite;
api.action.setIcon = value => {
  icons.push(value);
  return new Promise(resolve => { finishWrite = resolve; });
};
const writing = toolbar.update("disconnected");
toolbar.update("unlocked");
finishWrite();
// Let the serialized writer advance to the recovery state.
for (let turn = 0; icons.at(-1).imageData && turn < 20; turn++) await Promise.resolve();
assert.ok(icons.at(-1).path, "recovery write must start after the failure write completes");
finishWrite();
await writing;
assert.ok(icons.at(-1).path);
assert.match(titles.at(-1), /Connected and unlocked/);
console.log("PASS slow browser icon writes finish in order and leave the latest connection state visible");

const warn = console.warn;
try {
  console.warn = () => {};
  api.action.setIcon = async () => { throw new Error("API unavailable"); };
  await toolbar.update("disconnected");
  api.action.setIcon = async value => { icons.push(value); };
  await toolbar.update("disconnected");
  assert.equal(icons.at(-1).imageData, red);
} finally { console.warn = warn; }
console.log("PASS action failures are contained and the next update can retry");
