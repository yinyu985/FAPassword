// Owns the native connection + SRP session. A live native-messaging port keeps an MV3
// service worker alive; disconnects are handled explicitly in protocol.js.

import { ApplePasswords, State } from "./protocol.js";
import { activeTab, isLocalDevHost, normalizePin, pageContext } from "./shared.js";

const client = new ApplePasswords();
const uiPorts = new Set();

client.onStateChange((s) => {
  // any state other than unlocked means the session/keys are gone - drop the plaintext cache
  if (s !== State.Unlocked) {
    pwCacheClear();
    clearLoginCache();
  }
  if (s === State.Disconnected || s === State.NoHelper) clearPendingSaves();
  for (const port of uiPorts) {
    try {
      port.postMessage({ type: "state", state: s });
    } catch (_) {}
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "fapassword-popup" || port.sender?.id !== chrome.runtime.id || port.sender?.tab) return;
  uiPorts.add(port);
  port.onDisconnect.addListener(() => uiPorts.delete(port));
  port.postMessage({ type: "state", state: client.state });
});

// most-recently-used login per host (in-memory), so the dropdown floats your usual account up
const mruByHost = new Map(); // host -> [username lowercased, most recent first]
function recordMru(host, username) {
  if (!host || !username) return;
  const u = username.toLowerCase();
  const arr = (mruByHost.get(host) || []).filter((x) => x !== u);
  arr.unshift(u);
  // Refresh insertion order and cap distinct origins during very long browser sessions.
  mruByHost.delete(host);
  mruByHost.set(host, arr.slice(0, 10));
  while (mruByHost.size > 100) mruByHost.delete(mruByHost.keys().next().value);
}
function orderByMru(host, logins) {
  const order = mruByHost.get(host);
  if (!order || !order.length) return logins;
  const rank = (u) => {
    const i = order.indexOf((u || "").toLowerCase());
    return i === -1 ? Infinity : i;
  };
  // stable sort keeps the helper's own order for anything not in the MRU list
  return [...logins].sort((a, b) => rank(a.username) - rank(b.username));
}

// which account a submitted password attaches to ("" lets the native sheet ask, null saves nothing); in the background so a redirect cant lose it
function pickSaveTarget({ host, existing, detected, generated, newPwCtx }) {
  const matched = detected && existing.find((u) => u.toLowerCase() === detected.toLowerCase());
  // update only on a new password, stay quiet on a plain re-login
  if (matched) return generated || newPwCtx ? matched : null;
  if (detected) return detected;
  // no username on a reset with saved account(s): attach to the MRU one, apple's sheet lets the user re-pick
  if (newPwCtx && existing.length) {
    return orderByMru(host, existing.map((u) => ({ username: u })))[0].username;
  }
  if (generated) return "";
  return null;
}

// new-password saves that arrived while locked; a reset can navigate away, so stash and flush on unlock
const PENDING_SAVE_TTL_MS = 3 * 60_000;
const pendingSaves = [];
function removePendingSaveAt(index) {
  const [save] = pendingSaves.splice(index, 1);
  if (save?.timer) clearTimeout(save.timer);
  return save;
}
function clearPendingSaves() {
  while (pendingSaves.length) removePendingSaveAt(pendingSaves.length - 1);
}
function prunePendingSaves() {
  const cutoff = Date.now() - PENDING_SAVE_TTL_MS;
  for (let i = pendingSaves.length - 1; i >= 0; i--) {
    if (pendingSaves[i].at < cutoff) removePendingSaveAt(i);
  }
}
function retainPendingSave(save) {
  const remaining = PENDING_SAVE_TTL_MS - (Date.now() - save.at);
  if (remaining <= 0) return;
  save.timer = setTimeout(() => {
    const i = pendingSaves.indexOf(save);
    if (i >= 0) removePendingSaveAt(i);
  }, remaining);
  pendingSaves.push(save);
}
function queuePendingSave(save) {
  prunePendingSaves();
  save.at = Date.now();
  const k = `${save.host} ${(save.detected || "").toLowerCase()}`;
  const i = pendingSaves.findIndex((p) => `${p.host} ${(p.detected || "").toLowerCase()}` === k);
  if (i >= 0) removePendingSaveAt(i); // newest wins
  retainPendingSave(save);
  while (pendingSaves.length > 10) removePendingSaveAt(0);
}
async function flushPendingSaves() {
  prunePendingSaves();
  if (!client.ready || !pendingSaves.length) return;
  const batch = pendingSaves.splice(0);
  for (const save of batch) {
    if (save.timer) clearTimeout(save.timer);
    save.timer = null;
  }
  for (const s of batch) {
    try {
      const existing = (await getLoginNames(s.tabId, s.frameUrl))
        .map((l) => l.username)
        .filter(Boolean);
      const target = pickSaveTarget({ ...s, existing });
      if (target === null) continue;
      await client.saveLogin(s.tabId, s.frameUrl, target, s.password);
    } catch (error) {
      // Keep a transiently-failed save until its short plaintext TTL expires.
      if (client.ready) retainPendingSave(s);
      console.warn("[FAPassword] deferred save failed", error);
    }
  }
}

// collapse identical-looking usernames: trailing/leading space, zero-width chars, case, and
// unicode composition all equal. keeps internal spaces so distinct usernames arent merged
function normUsername(u) {
  return (u || "")
    .normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .toLowerCase();
}

// helper returns the same username several times (www + apex entries, or a stray-space dupe).
// fills look up by username, so extra rows only ever fetch the same credential - drop them
function uniqueByUsername(logins) {
  const seen = new Set();
  return logins.filter((l) => {
    const k = normUsername(l.username);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// What we last filled per tab, so a popup refresh can re-fill the same exact frame/origin.
const lastFillByTab = new Map(); // tabId -> { origin, username, frameId }
chrome.tabs.onRemoved.addListener((tabId) => lastFillByTab.delete(tabId));

// short-lived cache of decrypted passwords so re-filling the same login skips a second Touch
// ID (apple prompts every read). plaintext in worker memory up to the TTL, cleared on lock
const PW_CACHE_TTL_MS = 120_000; // 2 minutes
const pwCache = new Map(); // `${origin}\n${username lowercased}` -> { cred, timer }
function pwCacheKey(host, username) {
  return `${host}\n${(username || "").toLowerCase()}`;
}
function pwCacheGet(host, username) {
  const k = pwCacheKey(host, username);
  const hit = pwCache.get(k);
  if (!hit) return null;
  return hit.cred;
}
function pwCacheSet(host, cred) {
  if (!host || !cred?.username) return;
  const k = pwCacheKey(host, cred.username);
  const old = pwCache.get(k);
  if (old?.timer) clearTimeout(old.timer);
  const entry = { cred, timer: null };
  entry.timer = setTimeout(() => {
    if (pwCache.get(k) === entry) pwCache.delete(k);
  }, PW_CACHE_TTL_MS);
  pwCache.set(k, entry);
}
function pwCacheClear() {
  for (const entry of pwCache.values()) if (entry.timer) clearTimeout(entry.timer);
  pwCache.clear();
}

// Login names are less sensitive than passwords but still private. Cache them only briefly,
// per exact origin, to avoid repeated native queries on focus without retaining stale lists.
const LOGIN_CACHE_TTL_MS = 15_000;
const loginCache = new Map();
function clearLoginCache(origin) {
  if (origin) {
    const entry = loginCache.get(origin);
    if (entry?.timer) clearTimeout(entry.timer);
    loginCache.delete(origin);
    return;
  }
  for (const entry of loginCache.values()) if (entry.timer) clearTimeout(entry.timer);
  loginCache.clear();
}
async function getLoginNames(tabId, url) {
  const context = pageContext(url);
  if (!context) throw new Error("invalid page URL");
  const hit = loginCache.get(context.origin);
  if (hit && Date.now() - hit.at < LOGIN_CACHE_TTL_MS) return hit.logins;
  const logins = await client.getLoginNamesForURL(tabId, url);
  clearLoginCache(context.origin);
  const entry = { logins, at: Date.now(), timer: null };
  entry.timer = setTimeout(() => {
    if (loginCache.get(context.origin) === entry) loginCache.delete(context.origin);
  }, LOGIN_CACHE_TTL_MS);
  loginCache.set(context.origin, entry);
  return logins;
}

// A stuck native challenge/verify call should not leave popup controls hanging forever.
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label || "timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function sendFillToFrame(tabId, frameId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch (error) {
    const detail = String(error?.message ?? error);
    if (/could not establish connection|receiving end does not exist|frame.*(removed|not found)|no tab/i.test(detail)) {
      throw new Error("The page changed while waiting. Try again.");
    }
    throw error;
  }
}

async function ensureConnected() {
  if (client.state === State.Disconnected || client.state === State.NoHelper) {
    try {
      await client.connect();
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }
  return { ok: true };
}

chrome.runtime.onStartup.addListener(ensureConnected);
chrome.runtime.onInstalled.addListener(ensureConnected);
ensureConnected();

// suppress only chrome password autofill, leave address + credit-card/google pay alone
function suppressChromeAutofill() {
  const svc = chrome.privacy?.services;
  if (!svc?.passwordSavingEnabled) return;
  // Opt-in only: installing this extension must not silently change browser-wide settings.
  // Credit-card autofill is never touched, so Google Pay keeps working.
  chrome.storage?.local?.get({ suppressSaveBubble: false, suppressAddressAutofill: false }, (o) => {
    if (chrome.runtime.lastError) return;
    try {
      if (o.suppressSaveBubble) {
        svc.passwordSavingEnabled.set({ value: false }, () => void chrome.runtime.lastError);
      } else {
        svc.passwordSavingEnabled.clear({}, () => void chrome.runtime.lastError);
      }
      if (o.suppressAddressAutofill && svc.autofillAddressEnabled) {
        svc.autofillAddressEnabled.set({ value: false }, () => void chrome.runtime.lastError);
      } else if (svc.autofillAddressEnabled) {
        svc.autofillAddressEnabled.clear({}, () => void chrome.runtime.lastError);
      }
    } catch (_) {}
  });
}
chrome.runtime.onInstalled.addListener(suppressChromeAutofill);
chrome.runtime.onStartup.addListener(suppressChromeAutofill);
suppressChromeAutofill();

// only the extension's own popup may drive privileged actions (content messages carry sender.tab, the popup never does)
function isFromOwnUi(sender) {
  return sender.id === chrome.runtime.id && sender.tab === undefined;
}

// messages a content script may send - only the sender's own tab/origin, never return a password to the page
const CONTENT_ALLOWED = new Set(["inlineLogins", "inlineFill", "resolveSave", "beginUnlock"]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // privileged actions are popup-only; content script gets the inline msgs only
      const fromUi = isFromOwnUi(sender);
      const fromContent = sender.id === chrome.runtime.id && sender.tab !== undefined;
      if (!fromUi && !(fromContent && CONTENT_ALLOWED.has(msg?.type))) {
        sendResponse({ ok: false, error: "forbidden" });
        return;
      }

      switch (msg?.type) {
        case "inlineLogins": {
          // login names only (no passwords) for the exact frame that asked, keyed to sender.url not the top tab
          const frameUrl = sender.url;
          const context = pageContext(frameUrl);
          if (!context) return sendResponse({ ok: false, error: "invalid frame URL" });
          if (!context.secure && !isLocalDevHost(context.host)) {
            return sendResponse({ ok: false, error: "refusing to list logins on a non-HTTPS frame" });
          }
          const connection = await ensureConnected();
          if (!client.ready) {
            if (client.state === State.NeedsPin) {
              return sendResponse({ ok: true, locked: true, logins: [] });
            }
            return sendResponse({
              ok: false,
              error: connection.error || "Couldn't connect to Apple Passwords",
              state: client.state,
            });
          }
          try {
            const logins = await getLoginNames(sender.tab?.id, frameUrl);
            sendResponse({
              ok: true,
              locked: false,
              logins: uniqueByUsername(orderByMru(context.origin, logins)),
            });
          } catch (error) {
            console.warn("[FAPassword] login-name query failed", error);
            sendResponse({ ok: false, error: "Couldn't load logins" });
          }
          break;
        }

        case "inlineFill": {
          // fetch + fill for the requesting frame's own origin only (frameId), never broadcast - confused-deputy fix
          const frameUrl = sender.url;
          const frameId = sender.frameId;
          if (!frameUrl || sender.tab?.id == null || frameId == null) {
            return sendResponse({ ok: false, error: "no frame" });
          }
          const context = pageContext(frameUrl);
          if (!context) return sendResponse({ ok: false, error: "invalid frame URL" });
          if (!context.secure && !isLocalDevHost(context.host)) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS frame" });
          }
          // ignore caller-supplied loginName.sites, query by frame's own host
          // (handled in protocol.js); pass only username through
          const safeLogin = { username: msg.loginName?.username };
          // cache hit skips the helper read and its Touch ID; miss reads then caches
          let cred = pwCacheGet(context.origin, safeLogin.username);
          if (!cred) {
            cred = await client.getPasswordForLoginName(sender.tab.id, frameUrl, safeLogin);
            if (cred) pwCacheSet(context.origin, cred);
          }
          let filled = false;
          if (cred) {
            const resp = await sendFillToFrame(
              sender.tab.id,
              frameId,
              {
                type: "fill",
                username: cred.username,
                password: cred.password,
                expectedOrigin: context.origin,
                requestId: msg.requestId,
              },
            );
            filled = !!resp?.filled;
            if (filled) {
              recordMru(context.origin, cred.username);
              lastFillByTab.set(sender.tab.id, { origin: context.origin, username: cred.username, frameId });
            }
          }
          sendResponse({ ok: true, filled });
          break;
        }

        case "resolveSave": {
          // resolve + save here in the background so a submit that navigates cant kill it; native sheet is still the write gate
          const frameUrl = sender.url;
          if (!frameUrl || sender.tab?.id == null) {
            return sendResponse({ ok: false, error: "no frame" });
          }
          const context = pageContext(frameUrl);
          if (!context) return sendResponse({ ok: false, error: "invalid frame URL" });
          const host = context.origin;
          if (!context.secure && !isLocalDevHost(context.host)) {
            return sendResponse({ ok: false, error: "refusing to save from a non-HTTPS frame" });
          }
          if (!msg.password) return sendResponse({ ok: false, error: "no password" });
          const detected = (msg.username || "").trim();
          const generated = !!msg.generated;
          const newPwCtx = !!msg.newPwCtx;
          await ensureConnected();

          // locked: cant list or write - stash a new-password save for unlock, a plain re-login isnt worth deferring
          if (!client.ready) {
            if (generated || newPwCtx) {
              queuePendingSave({
                host,
                frameUrl,
                tabId: sender.tab.id,
                detected,
                password: msg.password,
                generated,
                newPwCtx,
              });
            }
            return sendResponse({ ok: true, saved: false, locked: true });
          }

          const existing = (await getLoginNames(sender.tab.id, frameUrl))
            .map((l) => l.username)
            .filter(Boolean);
          const target = pickSaveTarget({ host, existing, detected, generated, newPwCtx });
          console.debug("[FAPassword] resolveSave", {
            host,
            detected: detected || "(none)",
            generated,
            newPwCtx,
            existingCount: existing.length,
            target: target === null ? "(skip)" : target || "(ask)",
          });
          if (target === null) return sendResponse({ ok: true, saved: false, skipped: true });
          await client.saveLogin(sender.tab.id, frameUrl, target, msg.password);
          clearLoginCache(context.origin);
          sendResponse({ ok: true, saved: true });
          break;
        }

        case "beginUnlock": {
          // Opening the extension-owned popup is preferable: PIN entry never belongs in
          // page DOM. If Chromium cannot open it, still honor this trusted row click by
          // issuing exactly one challenge and tell the user where to enter the code.
          if (chrome.action?.openPopup) {
            try {
              await chrome.action.openPopup();
              return sendResponse({ ok: true, popupOpened: true });
            } catch (error) {
              console.warn("[FAPassword] couldn't open popup from page", error);
            }
          }

          const connection = await ensureConnected();
          if (!connection.ok || (client.state !== State.NeedsPin && client.state !== State.Unlocked)) {
            return sendResponse({
              ok: false,
              error: connection.error || "Couldn't connect to Apple Passwords",
              state: client.state,
            });
          }
          if (client.state === State.NeedsPin) {
            await withTimeout(client.requestChallenge({ ifNeeded: true }), 8000, "challenge timed out");
          }
          sendResponse({
            ok: true,
            popupOpened: false,
            state: client.state,
            challengeReady: client.hasChallenge,
          });
          break;
        }

        case "getState":
          await ensureConnected();
          sendResponse({ ok: true, state: client.state, hasChallenge: client.hasChallenge });
          break;

        case "requestChallenge":
          // top frame (or popup) only, so a hostile sub-frame cant spam native prompts
          if (fromContent && sender.frameId !== 0) return sendResponse({ ok: false, error: "forbidden" });
          {
            const connection = await ensureConnected();
            if (!connection.ok) {
              return sendResponse({ ok: false, error: connection.error, state: client.state });
            }
            // ifNeeded: leave a code thats already up on the Mac alone. re-asking would show a
            // second prompt and kill the code the user is in the middle of typing
            const issued = await withTimeout(
              client.requestChallenge({ ifNeeded: !!msg.ifNeeded }),
              8000,
              "challenge timed out",
            );
            sendResponse({ ok: true, state: client.state, hasChallenge: client.hasChallenge, issued });
          }
          break;

        case "verifyPin": {
          if (fromContent && sender.frameId !== 0) return sendResponse({ ok: false, error: "forbidden" });
          const pin = normalizePin(msg.pin);
          if (pin.length !== 6) return sendResponse({ ok: false, error: "Enter all 6 digits" });
          await ensureConnected();
          try {
            // Cap so a non-responding helper cannot leave popup controls stuck.
            await withTimeout(client.verifyPin(pin), 8000, "verification timed out");
          } catch (e) {
            // a spent challenge cant be retried - put a fresh code on the Mac and tell the UI
            // to ask for THAT one, or the user retypes a dead code forever
            let newCode = e?.code === "challenge_reissued";
            if (!newCode && !client.hasChallenge && client.state === State.NeedsPin) {
              try {
                await withTimeout(client.requestChallenge(), 8000, "challenge timed out");
                newCode = true;
              } catch (_) {}
            }
            return sendResponse({
              ok: false,
              error: String(e?.message ?? e),
              newCode,
              state: client.state,
            });
          }
          sendResponse({ ok: true, state: client.state });
          // just unlocked - complete any saves stashed while locked
          if (client.ready) flushPendingSaves();
          break;
        }

        case "getLogins": {
          // real active tab's URL, never caller-supplied
          const tab = await activeTab();
          if (!tab?.url) return sendResponse({ ok: false, error: "no active tab" });
          const context = pageContext(tab.url);
          if (!context || (!context.secure && !isLocalDevHost(context.host))) {
            return sendResponse({ ok: false, error: "This page can't be filled" });
          }
          const logins = await getLoginNames(tab.id, tab.url);
          sendResponse({ ok: true, logins: uniqueByUsername(orderByMru(context.origin, logins)) });
          break;
        }

        case "fillOnPage": {
          const tab = await activeTab();
          if (!tab?.url) return sendResponse({ ok: false, error: "no active tab" });
          const context = pageContext(tab.url);
          if (!context) return sendResponse({ ok: false, error: "invalid page URL" });
          // require HTTPS except local dev: loopback (secure context) and reserved
          // .test / .localhost TLDs (RFC 6761, never real sites)
          if (!context.secure && !isLocalDevHost(context.host)) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS page" });
          }
          let cred = pwCacheGet(context.origin, msg.loginName?.username);
          if (!cred) {
            cred = await client.getPasswordForLoginName(tab.id, tab.url, msg.loginName);
            if (cred) pwCacheSet(context.origin, cred);
          }
          let filled = false;
          if (cred) {
            // content script re-checks expectedOrigin before filling
            const resp = await sendFillToFrame(
              tab.id,
              0,
              {
                type: "fill",
                username: cred.username,
                password: cred.password,
                expectedOrigin: context.origin,
              },
            );
            filled = !!resp?.filled;
            if (filled) {
              recordMru(context.origin, cred.username);
              lastFillByTab.set(tab.id, { origin: context.origin, username: cred.username, frameId: 0 });
            }
          }
          sendResponse({ ok: true, filled });
          break;
        }

        case "refreshAndRefill": {
          // drop cache then re-fill the tab's last-filled login with a fresh read, so a
          // password changed in the Passwords app lands without re-clicking Fill
          pwCacheClear();
          const tab = await activeTab();
          const entry = tab?.id != null ? lastFillByTab.get(tab.id) : null;
          const context = tab?.url ? pageContext(tab.url) : null;
          if (!entry || !context || entry.origin !== context.origin) {
            return sendResponse({ ok: true, refilled: false });
          }
          try {
            const cred = await client.getPasswordForLoginName(tab.id, tab.url, { username: entry.username });
            if (!cred) return sendResponse({ ok: true, refilled: false });
            pwCacheSet(context.origin, cred);
            const resp = await sendFillToFrame(
              tab.id,
              entry.frameId ?? 0,
              {
                type: "fill",
                username: cred.username,
                password: cred.password,
                expectedOrigin: context.origin,
              },
            );
            sendResponse({ ok: true, refilled: !!resp?.filled, username: cred.username });
          } catch (e) {
            sendResponse({ ok: true, refilled: false, error: String(e?.message ?? e) });
          }
          break;
        }

        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message ?? e), state: client.state });
    }
  })();
  return true; // async response
});
