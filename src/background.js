// Owns native transport, session-bound caches and document-bound fill/save operations.
import { ApplePasswords, State } from "./protocol.js";
import { activeTab, errorKey, isLocalDevHost, normalizePin, pageContext } from "./shared.js";
import { SessionCache, credentialKey } from "./session-cache.js";
import { beginInlineUnlock } from "./unlock-flow.js";
import { createToolbarStatus } from "./toolbar-status.js";

const client = new ApplePasswords();
const toolbar = createToolbarStatus(chrome);
let connectionAttempt = null;
let connecting = false;
const passwordCache = new SessionCache(120000, () => client.ready);
const loginCache = new SessionCache(15000, () => client.ready);
const frames = new Map();
const uiTargets = new Map();
const operations = new Map();
const uiPorts = new Set();
const lastFillByTab = new Map();
const lastFocusByTab = new Map();
const mruByHost = new Map();
const recentFills = new Map();
const generated = new Map();
const pendingSaves = new Map();
const SAVE_TTL = 180000;
let flushing = false;
let lastConnectionError = null;
let revision = 0;

const ownUi = (sender) => sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("src/popup.html");
const frameKey = (tabId, frameId) => `${tabId}:${frameId}`;
const operationKey = (documentId, requestId) => `${documentId}:${requestId}`;
const usablePage = (url) => {
  const context = pageContext(url);
  return context && ["http:", "https:"].includes(context.url.protocol) &&
    (context.secure || isLocalDevHost(context.host)) ? context : null;
};
const failure = (error) => ({ ok: false, errorKey: errorKey(error), error: String(error?.message ?? error), state: client.state });
const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  (byte) => byte.toString(16).padStart(2, "0")).join("");

function publicSaves() {
  return [...pendingSaves.values()].map(({ id, host, username, status, expiresAt, messageKey }) =>
    ({ id, host, username, status, expiresAt, messageKey }));
}
function publish() {
  const message = { type: "state", state: client.state, revision: ++revision, saves: publicSaves() };
  for (const port of uiPorts) { try { port.postMessage(message); } catch {} }
}
function clearCaches() { passwordCache.clear(); loginCache.clear(); }
client.onStateChange((state) => {
  toolbar.update(state, connecting);
  if (state !== State.Unlocked) {
    clearCaches();
    recentFills.clear();
    for (const operation of operations.values()) operation.abort(new Error("session changed"));
  }
  publish();
  if (state === State.Unlocked) queueMicrotask(flushPendingSaves);
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "fapassword-popup" || !ownUi(port.sender || {})) return;
  uiPorts.add(port);
  port.onDisconnect.addListener(() => uiPorts.delete(port));
  port.postMessage({ type: "state", state: client.state, revision, saves: publicSaves() });
});

function recordMru(origin, username) {
  const values = (mruByHost.get(origin) || []).filter((value) => value !== username);
  mruByHost.delete(origin); mruByHost.set(origin, [username, ...values].slice(0, 10));
  while (mruByHost.size > 100) mruByHost.delete(mruByHost.keys().next().value);
}
function orderLogins(origin, logins) {
  const seen = new Set();
  const order = mruByHost.get(origin) || [];
  const rank = (username) => { const index = order.indexOf(username); return index < 0 ? Infinity : index; };
  return logins.filter((login) => {
    if (typeof login.username !== "string" || seen.has(login.username)) return false;
    seen.add(login.username); return true;
  }).sort((a, b) => rank(a.username) - rank(b.username));
}
function getLoginNames(tabId, url) {
  const context = usablePage(url);
  if (!context) throw new Error("unavailable URL");
  return loginCache.query(context.origin, () => client.getLoginNamesForURL(tabId, url));
}
function ensureConnected() {
  if (connectionAttempt) return connectionAttempt;
  if (client.port && client.session) return Promise.resolve(true);
  connecting = true;
  toolbar.update(client.state, connecting);
  connectionAttempt = Promise.resolve().then(() => client.connect()).then(() => {
    lastConnectionError = null; return true;
  }, (error) => {
    lastConnectionError = errorKey(error); return false;
  }).finally(() => {
    connecting = false;
    connectionAttempt = null;
    toolbar.update(client.state);
  });
  return connectionAttempt;
}
function cancelDocument(documentId) {
  for (const [key, operation] of operations) if (key.startsWith(documentId + ":")) operation.abort(new Error("document changed"));
  recentFills.delete(documentId);
  generated.delete(documentId);
}
chrome.tabs.onRemoved.addListener((tabId) => {
  lastFillByTab.delete(tabId);
  lastFocusByTab.delete(tabId);
  for (const [key, frame] of frames) if (frame.tabId === tabId) { cancelDocument(frame.documentId); frames.delete(key); }
  for (const [key, target] of uiTargets) if (target.tabId === tabId) uiTargets.delete(key);
});

function senderTarget(sender, documentKey) {
  const context = usablePage(sender.url);
  if (!context || sender.tab?.id == null || !Number.isInteger(sender.frameId) || !sender.documentId || typeof documentKey !== "string") {
    throw new Error("unavailable frame URL");
  }
  return { tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId, documentKey,
    origin: context.origin, frameUrl: sender.url, topOrigin: pageContext(sender.tab.url)?.origin };
}
function rememberFrame(target) {
  const key = frameKey(target.tabId, target.frameId);
  const previous = frames.get(key);
  if (previous && previous.documentId !== target.documentId) cancelDocument(previous.documentId);
  frames.set(key, target);
}
async function sendToDocument(target, message) {
  try {
    return await chrome.tabs.sendMessage(target.tabId, { ...message, documentKey: target.documentKey },
      { documentId: target.documentId, frameId: target.frameId });
  } catch { throw new Error("The page document changed; try again"); }
}
async function captureTopTarget(tab) {
  if (!tab?.id || !usablePage(tab.url)) throw new Error("unavailable page URL");
  // describeFrame registers its browser-supplied documentId before replying. This also
  // repopulates frame metadata after a worker restart without storing secrets on disk.
  let response;
  try { response = await chrome.tabs.sendMessage(tab.id, { type: "describeFrame" }, { frameId: 0 }); }
  catch { throw new Error("unavailable page URL"); }
  const frame = frames.get(frameKey(tab.id, 0));
  if (!response?.ok || !frame || response.documentKey !== frame.documentKey || frame.origin !== pageContext(tab.url).origin) {
    throw new Error("page document changed");
  }
  return { ...frame };
}
function ticketFor(target) {
  for (const [id, value] of uiTargets) if (Date.now() - value.at > 180000) uiTargets.delete(id);
  const id = crypto.randomUUID();
  uiTargets.set(id, { ...target, at: Date.now() });
  while (uiTargets.size > 50) uiTargets.delete(uiTargets.keys().next().value);
  return id;
}
async function validateUiTarget(id) {
  const target = uiTargets.get(id);
  const tab = await activeTab();
  if (!target || Date.now() - target.at > 180000 || target.tabId !== tab?.id ||
      target.topOrigin !== pageContext(tab?.url)?.origin) throw new Error("stale page target");
  const response = await sendToDocument(target, { type: "describeFrame" });
  if (!response?.ok) throw new Error("page document changed");
  return target;
}
async function performFill(target, username, requestId) {
  if (typeof username !== "string" || typeof requestId !== "string") throw new Error("invalid fill message");
  const key = operationKey(target.documentId, requestId);
  if (operations.has(key)) throw new Error("duplicate fill request");
  const controller = new AbortController();
  operations.set(key, controller);
  const generation = passwordCache.generation;
  const epoch = client.epoch;
  try {
    if (!client.ready) throw new Error("not unlocked");
    const cacheKey = credentialKey(target.origin, username);
    let credential = passwordCache.get(cacheKey);
    if (!credential) {
      credential = await client.getPasswordForLoginName(target.tabId, target.frameUrl, { username }, { signal: controller.signal });
      if (!credential) return { ok: false, errorKey: "fillFailed", filled: false };
      if (credential.username !== username || !client.ready || epoch !== client.epoch || controller.signal.aborted) throw new Error("session changed");
      passwordCache.set(cacheKey, credential, generation);
    }
    if (!client.ready || generation !== passwordCache.generation || controller.signal.aborted) throw new Error("session changed");
    const recent = { username, digest: digest(credential.password), at: Date.now() };
    recentFills.set(target.documentId, recent);
    // Install the digest record before sending: page handlers can submit synchronously during fill.
    const response = await sendToDocument(target, { type: "fill", requestId, expectedOrigin: target.origin,
      username: credential.username, password: credential.password });
    if (!response?.filled && recentFills.get(target.documentId) === recent) recentFills.delete(target.documentId);
    if (response?.filled) {
      recordMru(target.origin, username);
      lastFillByTab.set(target.tabId, { ...target, username });
    }
    return { ok: !!response?.filled, filled: !!response?.filled, fields: response?.fields,
      stage: response?.stage, errorKey: response?.errorKey || (response?.filled ? undefined : "errorPartialFill") };
  } finally { operations.delete(key); }
}

function setSaveStatus(entry, status, messageKey) {
  entry.status = status; entry.messageKey = messageKey;
  publish();
  sendToDocument(entry.target, { type: "saveStatus", messageKey }).catch(() => {});
}
function discardSecret(entry, status, messageKey) {
  clearTimeout(entry.timer); clearTimeout(entry.retryTimer);
  entry.password = "";
  entry.controller?.abort(new Error(status === "expired" ? "save expired" : "save cancelled"));
  setSaveStatus(entry, status, messageKey);
}
function stillPending(entry) {
  if (!entry.password || entry.status === "cancelled" || entry.status === "expired") return false;
  if (Date.now() >= entry.expiresAt) { discardSecret(entry, "expired", "saveExpired"); return false; }
  return true;
}
function queueSave(message, target) {
  if (typeof message.password !== "string" || !message.password || typeof message.username !== "string") throw new Error("invalid save message");
  const entry = { id: crypto.randomUUID(), target, host: new URL(target.frameUrl).hostname,
    username: message.username, password: message.password, newPwCtx: !!message.newPwCtx,
    generatedId: message.generatedId, submissionId: message.submissionId, expiresAt: Date.now() + SAVE_TTL,
    status: "queued", attempts: 0, controller: null };
  entry.signature = digest(JSON.stringify([target.origin, entry.username, entry.password]));
  entry.timer = setTimeout(() => discardSecret(entry, "expired", "saveExpired"), SAVE_TTL);
  pendingSaves.set(entry.id, entry);
  while (pendingSaves.size > 10) {
    const oldest = pendingSaves.values().next().value;
    discardSecret(oldest, "expired", "saveExpired"); pendingSaves.delete(oldest.id);
  }
  setSaveStatus(entry, "queued", client.ready ? "saveQueued" : "saveWaitingUnlock");
  queueMicrotask(flushPendingSaves);
  return { ok: true, saveId: entry.id, status: entry.status };
}
async function flushPendingSaves() {
  if (flushing) return;
  flushing = true;
  try {
    const queued = [...pendingSaves.values()].filter((entry) => entry.status === "queued" && stillPending(entry));
    if (!queued.length) return;
    if (!client.ready) await ensureConnected();
    if (!client.ready) {
      for (const entry of queued) if (stillPending(entry)) setSaveStatus(entry, "queued", "saveWaitingUnlock");
      return;
    }
    for (const entry of queued) {
      if (!stillPending(entry) || !client.ready) continue;
      try {
        const signature = await entry.signature;
        if (!stillPending(entry)) continue;
        const duplicate = [...pendingSaves.values()].some((other) => other !== entry && other.completedAt &&
          Date.now() - other.completedAt < 15000 && other.resolvedSignature === signature);
        const record = recentFills.get(entry.target.documentId);
        const passwordDigest = await digest(entry.password);
        if (!stillPending(entry)) continue;
        const unchanged = record && record.username === entry.username && Date.now() - record.at < 300000 &&
          await record.digest === passwordDigest;
        if (!stillPending(entry)) continue;
        if (duplicate || unchanged) {
          discardSecret(entry, "skipped", "saveUnchanged"); continue;
        }
        const generatedRecord = generated.get(entry.target.documentId);
        const wasGenerated = !!generatedRecord && generatedRecord.id === entry.generatedId && Date.now() - generatedRecord.at < 600000 &&
          await generatedRecord.digest === passwordDigest;
        if (!stillPending(entry)) continue;
        if (!entry.username && !entry.newPwCtx && !wasGenerated) {
          discardSecret(entry, "skipped", "saveNoAccount"); continue;
        }
        entry.controller = new AbortController();
        entry.attempts++;
        setSaveStatus(entry, "saving", "saveSending");
        // maybeAdd lets Apple's own sheet compare an existing account and confirm updates.
        // Do not read the password (and request Touch ID) just to suppress a save prompt.
        await client.saveLogin(entry.target.tabId, entry.target.frameUrl, entry.username, entry.password,
          { signal: entry.controller.signal, expiresAt: entry.expiresAt, frameId: entry.target.frameId });
        if (!stillPending(entry)) continue;
        clearCaches();
        entry.controller = null;
        entry.resolvedSignature = signature; entry.completedAt = Date.now();
        discardSecret(entry, "submitted", "saveSubmitted");
      } catch (error) {
        if (!stillPending(entry)) continue;
        entry.controller = null;
        console.warn("[FAPassword] deferred save failed", error);
        if (error.mayHaveBeenSent) setSaveStatus(entry, "uncertain", "saveUncertain");
        else {
          setSaveStatus(entry, "failed", "saveFailed");
          if (entry.attempts < 3) entry.retryTimer = setTimeout(() => {
            if (!stillPending(entry) || entry.status !== "failed") return;
            setSaveStatus(entry, "queued", "saveQueued"); flushPendingSaves();
          }, 2000 * Math.max(entry.attempts, 1));
        }
      }
    }
  } finally {
    flushing = false;
    if (client.ready && [...pendingSaves.values()].some((entry) => entry.status === "queued" && stillPending(entry))) queueMicrotask(flushPendingSaves);
  }
}

const contentAllowed = new Set(["frameReady", "recordFocus", "inlineLogins", "inlineFill", "cancelFill", "resolveSave", "rememberGenerated", "beginUnlock"]);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    try {
      const fromUi = ownUi(sender);
      const fromContent = sender.id === chrome.runtime.id && sender.tab && contentAllowed.has(message?.type);
      if (!fromUi && !fromContent) throw new Error("forbidden message");
      let target;
      if (fromContent) {
        target = senderTarget(sender, message.documentKey);
        if (message.type === "frameReady") { rememberFrame(target); return respond({ ok: true }); }
        const current = frames.get(frameKey(target.tabId, target.frameId));
        if (current && current.documentId !== target.documentId) throw new Error("stale document");
        rememberFrame(target);
      }
      switch (message.type) {
        case "getPasswordsLauncher":
        case "openPasswords":
          return respond(await new Promise((resolve) => {
            chrome.runtime.sendNativeMessage("com.fapassword.policy", {
              action: message.type === "openPasswords" ? "openPasswords" : "passwordsCapabilities",
            }, (response) => {
              const error = chrome.runtime.lastError;
              resolve(error ? { ok: false } : response || { ok: false });
            });
          }));
        case "policy":
          if (!["get", "set", "clear"].includes(message.action)) throw new Error("invalid policy action");
          return respond(await new Promise((resolve) => {
            chrome.runtime.sendNativeMessage("com.fapassword.policy", { action: message.action }, (response) => {
              const error = chrome.runtime.lastError;
              resolve(error ? { ok: false, errorKey: "policyHelperFailed" } : response || { ok: false });
            });
          }));
        case "recordFocus":
          lastFocusByTab.set(target.tabId, target);
          return respond({ ok: true });
        case "inlineLogins":
          await ensureConnected();
          if (!client.ready) return respond(client.state === State.NeedsPin ?
            { ok: true, locked: true, logins: [] } : { ok: false, errorKey: lastConnectionError || "errorConnection" });
          return respond({ ok: true, locked: false, logins: orderLogins(target.origin, await getLoginNames(target.tabId, target.frameUrl)) });
        case "inlineFill":
          return respond(await performFill(target, message.loginName?.username, message.requestId));
        case "cancelFill":
          operations.get(operationKey(target.documentId, message.requestId))?.abort(new Error("fill cancelled"));
          return respond({ ok: true });
        case "rememberGenerated":
          if (typeof message.password !== "string" || typeof message.generatedId !== "string") throw new Error("invalid message");
          generated.set(target.documentId, { id: message.generatedId, digest: digest(message.password), at: Date.now() });
          return respond({ ok: true });
        case "resolveSave":
          return respond(queueSave(message, target));
        case "beginUnlock":
          return respond(await beginInlineUnlock(client, ensureConnected, () => chrome.action.openPopup()));
        case "getState":
        case "retryConnection":
          await ensureConnected();
          return respond({ ok: true, state: client.state, hasChallenge: client.hasChallenge, errorKey: lastConnectionError, saves: publicSaves() });
        case "requestChallenge": {
          await ensureConnected();
          const issued = await client.requestChallenge({ ifNeeded: !!message.ifNeeded });
          return respond({ ok: true, state: client.state, hasChallenge: client.hasChallenge, issued });
        }
        case "verifyPin": {
          const pin = normalizePin(message.pin);
          if (pin.length !== 6) return respond({ ok: false, errorKey: "errorPinLength" });
          await ensureConnected();
          try { await client.verifyPin(pin); }
          catch (error) {
            let newCode = error.code === "challenge_reissued";
            if (!newCode && !client.hasChallenge && client.state === State.NeedsPin) {
              try { await client.requestChallenge(); newCode = true; } catch {}
            }
            return respond({ ...failure(error), newCode });
          }
          return respond({ ok: true, state: client.state });
        }
        case "getLogins": {
          const tab = await activeTab();
          const context = usablePage(tab?.url);
          if (!tab?.id || !context) return respond({ ok: false, errorKey: "pageUnavailable" });
          let frame = lastFocusByTab.get(tab?.id);
          if (frame && frame.topOrigin === context.origin) {
            const description = await sendToDocument(frame, { type: "describeFrame" }).catch(() => null);
            if (!description?.ok) frame = null;
          } else frame = null;
          frame ||= await captureTopTarget(tab).catch(() => null);
          // Listing accounts needs a site, not an editable field or a content script.
          // A missing document disables filling; actual fills still validate their ticket.
          const url = frame?.frameUrl || tab.url;
          const origin = frame?.origin || context.origin;
          const logins = orderLogins(origin, await getLoginNames(tab.id, url));
          const currentTab = await activeTab();
          if (currentTab?.id !== tab.id || pageContext(currentTab.url)?.origin !== context.origin) {
            return respond({ ok: false, errorKey: "pageUnavailable" });
          }
          return respond({ ok: true, logins, targetId: frame ? ticketFor(frame) : null, host: new URL(url).hostname,
            refill: lastFillByTab.get(tab.id) ? { username: lastFillByTab.get(tab.id).username, host: new URL(lastFillByTab.get(tab.id).frameUrl).hostname } : null });
        }
        case "fillOnPage": {
          const frame = await validateUiTarget(message.targetId);
          const preparation = await sendToDocument(frame, { type: "prepareFill" });
          if (!preparation?.ok) return respond(preparation || { ok: false, errorKey: "errorPageChanged" });
          return respond(await performFill(frame, message.loginName?.username, preparation.requestId));
        }
        case "refreshLogins":
          clearCaches(); return respond({ ok: true });
        case "refillOnPage": {
          const tab = await activeTab();
          const previous = lastFillByTab.get(tab?.id);
          if (!previous || previous.topOrigin !== pageContext(tab?.url)?.origin) throw new Error("stale page target");
          const preparation = await sendToDocument(previous, { type: "prepareFill" });
          if (!preparation?.ok) return respond(preparation || { ok: false, errorKey: "errorPageChanged" });
          clearCaches();
          return respond(await performFill(previous, previous.username, preparation.requestId));
        }
        case "retrySave": {
          const entry = pendingSaves.get(message.saveId);
          if (!entry || !stillPending(entry) || entry.status === "saving") throw new Error("save expired");
          clearTimeout(entry.retryTimer);
          setSaveStatus(entry, "queued", "saveQueued"); queueMicrotask(flushPendingSaves);
          return respond({ ok: true, saves: publicSaves() });
        }
        case "cancelSave": {
          const entry = pendingSaves.get(message.saveId);
          if (entry) { discardSecret(entry, "cancelled", "saveCancelled"); pendingSaves.delete(entry.id); publish(); }
          return respond({ ok: true, saves: publicSaves() });
        }
        default: throw new Error("unknown message");
      }
    } catch (error) { respond(failure(error)); }
  })();
  return true;
});
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
chrome.runtime.onStartup.addListener(ensureConnected);
chrome.runtime.onInstalled.addListener(ensureConnected);
ensureConnected();
