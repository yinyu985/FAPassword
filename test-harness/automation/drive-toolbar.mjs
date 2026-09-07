// Real Chromium action APIs and production worker; only the native helper is simulated.
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "./e2e-playwright.mjs";

const extension = await mkdtemp(join(tmpdir(), "fapassword-toolbar-extension-"));
let context, worker;
async function until(predicate, description) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(description);
}
async function expectIcon(red, titleKey) {
  await until(() => worker.evaluate(async ({ red, titleKey }) => {
    const latest = toolbarProbe.writes.at(-1);
    return latest?.result === "applied" && !!latest.pixels === red &&
      await chrome.action.getTitle({}) === chrome.i18n.getMessage(titleKey);
  }, { red, titleKey }), `Toolbar did not apply ${red ? "red" : "white"} with ${titleKey}`);
}
try {
  await cp(new URL(".builds/locked/", import.meta.url), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
  const testWorker = join(extension, manifest.background.service_worker);
  let source = await readFile(testWorker, "utf8");
  assert.equal(source.split("\nimportScripts(").length, 2);
  // Release negotiation only after observing Connecting; avoid timing-dependent assertions.
  source = source.replace("\nimportScripts(",
    "\ntestNative.capabilitiesGate = new Promise(resolve => toolbarProbe.releaseConnection = resolve);\nimportScripts(");
  await writeFile(testWorker, `
(() => {
  globalThis.toolbarProbe = { writes: [] };
  const setIcon = chrome.action.setIcon.bind(chrome.action);
  chrome.action.setIcon = async details => {
    const entry = { path: details.path, pixels: details.imageData &&
      Object.fromEntries(Object.entries(details.imageData).map(([size, image]) =>
        [size, Array.from(image.data.slice(0, 4))])), result: "pending" };
    toolbarProbe.writes.push(entry);
    try { await setIcon(details); entry.result = "applied"; }
    catch (error) { entry.result = "failed"; entry.error = String(error); throw error; }
  };
})();
` + source);
  context = await chromium.launchPersistentContext("", { headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  context.setDefaultTimeout(6000);
  worker = context.serviceWorkers()[0];
  await expectIcon(true, "toolbarConnecting");
  await worker.evaluate(() => toolbarProbe.releaseConnection());
  await expectIcon(true, "toolbarLocked");
  const startup = await worker.evaluate(() => toolbarProbe.writes);
  const redIndex = startup.findIndex(entry => entry.pixels && entry.result === "applied");
  assert.ok(redIndex >= 0 && startup.every(entry => entry.pixels), "startup and helper negotiation must never turn white before unlock");
  for (const rgba of Object.values(startup[redIndex].pixels)) assert.deepEqual(rgba, [239, 83, 80, 255]);
  assert.deepEqual(await worker.evaluate(() => testNative.counters), { names: 0, passwords: 0, saves: 0, challenges: 0 });
  console.log("PASS real action API stays red through startup and helper connection while awaiting PIN; no authentication or credential query");

  const popup = await context.newPage();
  await popup.goto(new URL("popup.html", worker.url()).href);
  await popup.locator("#pin:enabled").waitFor();
  await popup.fill("#pin", "000000");
  await popup.locator('#pin[aria-invalid="true"]:enabled').waitFor();
  await expectIcon(true, "toolbarLocked");
  assert.ok(await worker.evaluate(() => toolbarProbe.writes.every(entry => entry.pixels)), "an incorrect PIN must never turn the icon white");
  console.log("PASS an incorrect PIN keeps the real action icon red");
  await popup.fill("#pin", "123456");
  await popup.locator("#view-unlocked:not([hidden])").waitFor({ state: "attached" });
  await expectIcon(false, "toolbarUnlocked");
  const whitePixels = await worker.evaluate(async () => {
    const result = {};
    for (const [size, path] of Object.entries(toolbarProbe.writes.at(-1).path)) {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`Icon could not load: ${path}`);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = new OffscreenCanvas(Number(size), Number(size));
      const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0);
      result[size] = Array.from(ctx.getImageData(0, 0, 1, 1).data);
      bitmap.close();
    }
    return result;
  });
  for (const rgba of Object.values(whitePixels)) assert.deepEqual(rgba, [255, 255, 255, 255]);
  console.log("PASS only successful PIN verification restores white at every icon size");

  const reauthenticate = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "requestChallenge" }));
  assert.equal(reauthenticate.ok, true);
  await expectIcon(true, "toolbarLocked");
  console.log("PASS a session requiring reauthentication turns red even while the helper remains connected");

  // Close the popup so its UI cannot reconnect automatically during this assertion.
  await popup.close();
  await worker.evaluate(() => testNative.ports.at(-1).disconnect());
  await expectIcon(true, "toolbarDisconnected");
  await worker.evaluate(() => {
    testNative.capabilitiesGate = new Promise(resolve => toolbarProbe.releaseConnection = resolve);
  });
  const reconnect = await context.newPage();
  await reconnect.goto(new URL("popup.html", worker.url()).href);
  await expectIcon(true, "toolbarConnecting");
  await worker.evaluate(() => toolbarProbe.releaseConnection());
  await expectIcon(true, "toolbarLocked");
  await reconnect.locator("#pin:enabled").waitFor();
  await reconnect.fill("#pin", "123456");
  await expectIcon(false, "toolbarUnlocked");
  const writes = await worker.evaluate(() => toolbarProbe.writes);
  assert.ok(writes.every(entry => entry.result === "applied"), "every real icon API call must finish successfully");
  console.log("PASS disconnect and reconnection stay red until successful PIN verification restores white");
} catch (error) {
  if (worker) console.error("Toolbar API evidence:", JSON.stringify(await worker.evaluate(() => toolbarProbe.writes)));
  throw error;
} finally {
  if (context) await context.close();
  await rm(extension, { recursive: true, force: true });
}
