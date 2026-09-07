import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { chromium } from "./e2e-playwright.mjs";

const base = process.env.FAPASSWORD_BASE || "http://127.0.0.1:8799";
const extension = fileURLToPath(new URL("./.builds/locked", import.meta.url));
const shots = fileURLToPath(new URL("./shots/", import.meta.url));
await mkdir(shots, { recursive: true });
const context = await chromium.launchPersistentContext("unused", {
  headless: false, viewport: { width: 800, height: 640 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--headless=new"],
});
context.setDefaultTimeout(6000);
const worker = context.serviceWorkers()[0];
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", error => { pageErrors.push(error.message); console.error("PAGE ERROR", error.message); });
const popup = await context.newPage();
const api = message => popup.evaluate(message => chrome.runtime.sendMessage(message), message);
const count = name => worker.evaluate(name => testNative.counters[name], name);
async function until(predicate) {
  for (let i = 0; i < 150; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("Expected UI state did not arrive");
}
const idle = () => until(() => popup.locator("#refresh").isEnabled());
const clickRefresh = () => popup.evaluate(() => document.getElementById("refresh").click());
const message = name => popup.evaluate(name => chrome.i18n.getMessage(name), name);
const bodyHeight = () => popup.locator("body").evaluate(el => el.getBoundingClientRect().height);
async function resetPage() {
  await page.goto(base + "/security-regression.html");
  await page.evaluate(() => document.body.innerHTML = '<form style="margin:80px 24px"><input id="u" autocomplete="username" style="width:280px;height:32px"><input id="p" autocomplete="current-password" type="password"></form>');
  await page.bringToFront();
  await api({ type: "refreshLogins" });
}
try {
  await page.goto(base + "/security-regression.html");
  await popup.goto(new URL("popup.html", worker.url()).href);
  await popup.locator("#pin:enabled").waitFor();
  await page.bringToFront();
  await worker.evaluate(() => {
    testNative.namesGate = new Promise(resolve => testNative.releaseNames = resolve);
  });
  const beforeUnlock = await count("names");
  // Keep the website active, as with an actual toolbar popup, while entering the code.
  await popup.evaluate(() => {
    const pin = document.getElementById("pin");
    pin.value = "123456"; pin.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await popup.locator("#view-unlocked:not([hidden])").waitFor({ state: "attached" });
  await until(async () => await count("names") > beforeUnlock);
  assert.equal(await popup.locator("#refresh").isDisabled(), true);
  await popup.evaluate(() => {
    for (let i = 0; i < 20; i++) document.getElementById("refresh").dispatchEvent(new MouseEvent("click"));
  });
  await worker.evaluate(() => { testNative.releaseNames(); testNative.namesGate = null; testNative.delays.names = 450; });
  await idle();
  assert.equal(await count("names") - beforeUnlock, 1);
  assert.equal(await popup.locator("#logins button").count(), 1);
  assert.equal(await popup.inputValue("#pin"), "");
  console.log("PASS unlock and immediate repeated refresh share the initial account query");

  await resetPage();
  await clickRefresh(); await idle();
  await popup.setViewportSize({ width: 350, height: 640 });
  const listBounds = await popup.locator("#logins").boundingBox();
  await popup.evaluate(() => {
    window.rowsBeforeRefresh = [...document.querySelectorAll("#logins li")];
    window.rowRemovals = 0;
    new MutationObserver(records => {
      window.rowRemovals += records.reduce((sum, record) => sum + record.removedNodes.length, 0);
    }).observe(document.getElementById("logins"), { childList: true });
  });
  const beforeNames = await count("names"), beforePasswords = await count("passwords"), beforeCodes = await count("challenges");
  await popup.evaluate(() => {
    for (let i = 0; i < 30; i++) document.getElementById("refresh").dispatchEvent(new MouseEvent("click"));
  });
  assert.equal(await popup.locator("#logins li").count(), 1);
  assert.deepEqual(await popup.locator("#logins").boundingBox(), listBounds);
  await idle();
  assert.equal(await count("names") - beforeNames, 1);
  assert.equal(await count("passwords"), beforePasswords);
  assert.equal(await count("challenges"), beforeCodes);
  assert.deepEqual(await popup.locator("#logins").boundingBox(), listBounds);
  assert.equal(await popup.evaluate(() => window.rowsBeforeRefresh.every((row, i) => row === document.querySelectorAll("#logins li")[i])), true);
  assert.equal(await popup.evaluate(() => window.rowRemovals), 0);
  assert.equal(await popup.locator("#status-message").textContent(), await message("passwordsRefreshed"));
  for (let i = 0; i < 4; i++) { await clickRefresh(); await idle(); assert.deepEqual(await popup.locator("#logins").boundingBox(), listBounds); }
  assert.equal(await page.inputValue("#p"), "");
  await popup.locator("body").screenshot({ path: shots + "popup-refresh-stable.png" });
  console.log("PASS rapid and successive refreshes keep rows, list position and credentials unchanged");

  await worker.evaluate(() => testNative.statuses.names = 1);
  await clickRefresh(); await idle();
  assert.equal(await popup.locator("#logins li").count(), 1);
  assert.equal(await popup.locator("#status-message.failed").count(), 1);
  assert.deepEqual(await popup.locator("#logins").boundingBox(), listBounds);
  await worker.evaluate(() => { testNative.statuses.names = undefined; testNative.entries = []; });
  await clickRefresh(); await idle();
  assert.equal(await popup.locator("#logins li").count(), 0);
  assert.equal(await popup.locator("#status-message").textContent(), await message("noLogins"));
  assert.equal(await popup.locator("#status-message.failed").count(), 0);
  await worker.evaluate(() => { testNative.delays.names = 0; testNative.entries = null; });
  console.log("PASS failed refresh preserves accounts; a successful empty result clears the error");

  // Read-only account queries must also work where no content script has registered.
  await worker.evaluate(() => {
    globalThis.experienceSendMessage = chrome.tabs.sendMessage;
    chrome.tabs.sendMessage = async () => { throw new Error("Receiving end does not exist"); };
  });
  try {
    await clickRefresh(); await idle();
    assert.equal(await popup.locator("#logins li").count(), 1);
    assert.equal(await popup.locator("#logins button").isDisabled(), true);
    assert.equal(await popup.locator("#status-message").textContent(), await message("passwordsRefreshed"));
    const result = await api({ type: "getLogins" });
    assert.equal(result.ok, true); assert.equal(result.targetId, null);
    assert.equal((await api({ type: "fillOnPage", targetId: result.targetId, loginName: result.logins[0] })).ok, false);
  } finally {
    await worker.evaluate(() => { chrome.tabs.sendMessage = globalThis.experienceSendMessage; delete globalThis.experienceSendMessage; });
  }
  console.log("PASS refreshing without a content script lists accounts while documentless filling stays disabled");

  await page.goto("about:blank"); await page.bringToFront(); await popup.reload(); await idle();
  assert.equal(await popup.locator("#status-message").textContent(), await message("pageUnavailable"));
  const unavailableHeight = await bodyHeight();
  for (let i = 0; i < 3; i++) {
    await clickRefresh();
    await idle();
    assert.equal(await popup.locator("#status-message").textContent(), await message("pageUnavailable"));
    assert.equal(await bodyHeight(), unavailableHeight);
  }
  console.log("PASS repeated refresh on an unavailable page keeps the existing message and window height");

  await resetPage();
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    await page.locator("#u").click();
    await page.getByRole("option").first().waitFor();
    const geometry = await page.getByRole("listbox").evaluate(box => {
      const footer = box.nextElementSibling;
      return { firstIsOption: box.firstElementChild.getAttribute("role") === "option",
        footer: footer.textContent, aligned: getComputedStyle(footer).textAlign,
        compact: footer.getBoundingClientRect().height <= 18,
        separated: parseFloat(getComputedStyle(footer).borderTopWidth) >= 1 &&
          getComputedStyle(footer).backgroundColor !== getComputedStyle(box.parentElement).backgroundColor,
        below: footer.getBoundingClientRect().top >= box.getBoundingClientRect().bottom,
        footerRole: footer.getAttribute("role"), tabIndex: footer.tabIndex,
        overflows: box.scrollHeight > box.clientHeight, scrollbar: getComputedStyle(box).scrollbarWidth,
        fallback: getComputedStyle(box, "::-webkit-scrollbar").display };
    });
    assert.deepEqual(geometry, { firstIsOption: true, footer: "FAPassword", aligned: "right", below: true,
      compact: true, separated: true,
      footerRole: null, tabIndex: -1, overflows: false, scrollbar: "none", fallback: "none" });
    await page.locator("[data-fapassword-host]").screenshot({ path: shots + `inline-${theme}.png` });
    await page.keyboard.press("Escape");
    await page.mouse.click(10, 10);
  }
  console.log("PASS both inline themes lead with the account, show only a bottom-right wordmark, and hide scrollbars");

  await page.locator("#u").evaluate(el => { el.style.position = "fixed"; el.style.bottom = "40px"; });
  await page.locator("#u").click(); await page.getByRole("option").first().waitFor();
  const anchorRect = await page.locator("#u").boundingBox();
  const offerRect = await page.locator("[data-fapassword-host]").boundingBox();
  assert.ok(offerRect.y + offerRect.height <= anchorRect.y, "account and footer should flip above the bottom-edge field");
  await page.keyboard.press("Escape");
  console.log("PASS a bottom-edge field opens above with enough room for its first account and footer");

  await worker.evaluate(() => testNative.entries = Array.from({ length: 120 }, (_, i) => ({ USR: "account-" + i, PWD: "secret-" + i })));
  await resetPage();
  await page.locator("#u").click(); await page.getByRole("option").first().waitFor();
  const scroller = page.getByRole("listbox");
  assert.equal(await page.getByRole("option").count(), 120);
  assert.equal(await scroller.evaluate(el => el.scrollHeight > el.clientHeight && getComputedStyle(el).scrollbarWidth === "none"), true);
  const rect = await scroller.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + 20);
  await page.mouse.wheel(0, 10000);
  await until(() => scroller.evaluate(el => el.scrollTop > 0));
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.getByRole("option").last().evaluate(el => el.getRootNode().activeElement === el), true);
  const last = await page.getByRole("option").last().boundingBox();
  assert.ok(last.y >= rect.y && last.y + last.height <= rect.y + rect.height + 1);
  assert.equal(await scroller.evaluate(el => el.nextElementSibling.textContent), "FAPassword");
  await page.locator("[data-fapassword-host]").screenshot({ path: shots + "inline-long-list.png" });
  await page.keyboard.press("Enter");
  await until(async () => await page.inputValue("#p") === "secret-119");
  assert.equal(await page.inputValue("#u"), "account-119");
  console.log("PASS all 120 accounts remain reachable by wheel and keyboard without visible scrollbars");

  await page.route(base + "/strict-style", route => route.fulfill({
    contentType: "text/html", headers: { "Content-Security-Policy": "style-src 'none'; script-src 'none'" },
    body: '<!doctype html><form><input autocomplete="username"><input type="password" autocomplete="current-password"></form>',
  }));
  await page.goto(base + "/strict-style"); await page.locator('[autocomplete="username"]').click();
  await page.getByRole("option").first().waitFor();
  assert.equal(await page.getByRole("listbox").evaluate(el => el.scrollHeight > el.clientHeight && getComputedStyle(el).scrollbarWidth === "none"), true);
  console.log("PASS a site's restrictive stylesheet CSP cannot restore the inline scrollbar");

  await page.keyboard.press("Escape"); await page.mouse.click(790, 80);
  await page.setViewportSize({ width: 800, height: 90 });
  await worker.evaluate(() => testNative.statuses.names = 1);
  await api({ type: "refreshLogins" });
  const beforeTiny = await count("names");
  await page.locator('[autocomplete="username"]').click();
  await until(async () => await count("names") > beforeTiny);
  await page.waitForTimeout(150);
  assert.equal(await page.locator("[data-fapassword-host]").count(), 0);
  assert.deepEqual(pageErrors, []);
  console.log("PASS insufficient viewport space dismisses even an error offer without an orphaned surface or exception");
} catch (error) {
  console.error("UI detail", await page.locator("[data-fapassword-host]").count(),
    await page.locator("[role=status]").allTextContents(),
    await worker.evaluate(() => ({ counters: testNative.counters, error: testNative.error })));
  throw error;
} finally {
  await context.close();
}
