// Owns native transport, session-bound caches and document-bound fill/save operations.
import { ApplePasswords, State } from "./protocol.js";
import { activeTab, errorKey, isLocalDevHost, normalizePin, pageContext } from "./shared.js";
import { SessionCache, credentialKey } from "./session-cache.js";
import { beginInlineUnlock } from "./unlock-flow.js";
import { createToolbarStatus } from "./toolbar-status.js";
import { createSaveStore } from "./save-store.js";

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
const pendingSaves = new Map();
const SAVE_TTL = 180000;
const saveStore = createSaveStore(chrome.storage?.session);
let saveStorageError = false;
let savesRecovered = false;
let saveRecoveryError = null;
let saveRecoveryAttempt = null;
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
const failure = (error) => ({ ok: false, errorKey: error?.message === "save queue full" ? "saveQueueFull" : errorKey(error), error: String(error?.message ?? error), state: client.state });
const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  (byte) => byte.toString(16).padStart(2, "0")).join("");

function publicSaves() {
  return [...pendingSaves.values()].map(({ id, host, username, saveKind, status, expiresAt, messageKey }) =>
    ({ id, host, username, saveKind, status, expiresAt, messageKey }));
}
function updateToolbar() {
  const attention = [...pendingSaves.values()].filter((entry) =>
    ["queued", "review", "blocked", "needsAccount", "failed", "uncertain", "expired", "notice", "cancelPending"].includes(entry.status)).length;
  toolbar.update(client.state, connecting, attention + (saveRecoveryError ? 1 : 0));
}
function publish() {
  updateToolbar();
  const message = { type: "state", state: client.state, revision: ++revision, saves: publicSaves(), saveRecoveryError };
  for (const port of uiPorts) { try { port.postMessage(message); } catch {} }
}
function clearCaches() { passwordCache.clear(); loginCache.clear(); }
client.onStateChange((state) => {
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
  port.postMessage({ type: "state", state: client.state, revision, saves: publicSaves(), saveRecoveryError });
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
function getLoginNames(tabId, url, frameId = 0) {
  const context = usablePage(url);
  if (!context) throw new Error("unavailable URL");
  return loginCache.query(context.origin, () => client.getLoginNamesForURL(tabId, url, { frameId }));
}
function ensureConnected() {
  if (connectionAttempt) return connectionAttempt;
  if (client.port && client.session) return Promise.resolve(true);
  connecting = true;
  updateToolbar();
  connectionAttempt = Promise.resolve().then(() => client.connect()).then(() => {
    lastConnectionError = null; return true;
  }, (error) => {
    lastConnectionError = errorKey(error); return false;
  }).finally(() => {
    connecting = false;
    connectionAttempt = null;
    updateToolbar();
  });
  return connectionAttempt;
}
function cancelDocument(documentId) {
  for (const [key, operation] of operations) if (key.startsWith(documentId + ":")) operation.abort(new Error("document changed"));
  recentFills.delete(documentId);
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
      credential = await client.getPasswordForLoginName(target.tabId, target.frameUrl, { username }, { signal: controller.signal, frameId: target.frameId });
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
      lastFillByTab.set(target.tabId, { ...target, username, at: Date.now() });
    }
    return { ok: !!response?.filled, filled: !!response?.filled, fields: response?.fields,
      stage: response?.stage, errorKey: response?.errorKey || (response?.filled ? undefined : "errorPartialFill") };
  } finally { operations.delete(key); }
}

function setSaveStatus(entry, status, messageKey) {
  entry.status = status; entry.messageKey = messageKey;
  persistSaves().catch(() => {});
  publish();
  sendToDocument(entry.target, { type: "saveStatus", messageKey }).catch(() => {});
}
async function persistSaves() {
  try { await saveStore.save([...pendingSaves.values()]); saveStorageError = false; }
  catch (error) { saveStorageError = true; throw error; }
}
function makeRoomForSave() {
  while (pendingSaves.size >= 10) {
    const terminal = [...pendingSaves.values()].find((entry) => !entry.password && entry.status !== "cancelPending");
    if (!terminal) throw new Error("save queue full");
    clearTimeout(terminal.timer); pendingSaves.delete(terminal.id);
  }
}
function discardSecret(entry, status, messageKey) {
  clearTimeout(entry.timer); clearTimeout(entry.retryTimer);
  entry.password = "";
  entry.controller?.abort(new Error(status === "expired" ? "save expired" : "save cancelled"));
  setSaveStatus(entry, status, messageKey);
}
function stillPending(entry) {
  if (!entry.password || entry.status === "cancelPending" || entry.status === "cancelled" || entry.status === "expired") return false;
  if (Date.now() >= entry.expiresAt) { discardSecret(entry, "expired", "saveExpired"); return false; }
  return true;
}
function completeCancellation(entry) {
  if (entry.cancelTask) return entry.cancelTask;
  clearTimeout(entry.timer); clearTimeout(entry.retryTimer); clearTimeout(entry.cancelRetryTimer);
  // Stop the in-worker send immediately. A cancellation is only acknowledged
  // after a password-free tombstone has replaced the old persisted candidate.
  entry.password = "";
  entry.controller?.abort(new Error("save cancelled")); entry.controller = null;
  entry.status = "cancelPending"; entry.messageKey = "saveCancelling";
  delete entry.recoveryStatus;
  delete entry.recoveryMessageKey;
  publish();
  entry.cancelTask = (async () => {
    try { await persistSaves(); }
    catch {
      entry.messageKey = "saveCancelFailed"; publish();
      sendToDocument(entry.target, { type: "saveStatus", messageKey: "saveCancelFailed" }).catch(() => {});
      entry.cancelAttempts = (entry.cancelAttempts || 0) + 1;
      entry.cancelRetryTimer = setTimeout(() => {
        if (pendingSaves.get(entry.id) === entry) completeCancellation(entry);
      }, Math.min(30000, 2000 * 2 ** Math.min(entry.cancelAttempts - 1, 4)));
      return false;
    }
    if (pendingSaves.get(entry.id) === entry) pendingSaves.delete(entry.id);
    publish();
    // Failure to remove an already committed tombstone is safe: recovery will
    // never replay it, and will try cleanup again. Do not claim this for a
    // cancellation whose tombstone write itself failed.
    await persistSaves().catch(() => {});
    return true;
  })().finally(() => { entry.cancelTask = null; });
  return entry.cancelTask;
}
async function queueSave(message, target) {
  if (typeof message.password !== "string" || !message.password || typeof message.username !== "string") throw new Error("invalid save message");
  const reviewError = message.review && ["errorPasswordConfirmation", "errorChooseField"].includes(message.errorKey) ? message.errorKey : null;
  if (message.review && message.errorKey && !reviewError) throw new Error("invalid review error");
  const saveKind = ["login", "new", "change"].includes(message.saveKind) ? message.saveKind :
    (message.newPwCtx ? "new" : "login");
  if (typeof message.submissionId !== "string" || !message.submissionId) throw new Error("invalid submission id");
  const sameDocument = (entry) => entry.target.documentId === target.documentId && entry.target.documentKey === target.documentKey;
  const existing = [...pendingSaves.values()].find((entry) => sameDocument(entry) && entry.submissionId === message.submissionId);
  if (existing) {
    try { await persistSaves(); }
    catch { return { ok: false, errorKey: "saveStorageFailed", saveId: existing.id }; }
    return { ok: true, saveId: existing.id, status: existing.status };
  }
  const draft = message.draftId && [...pendingSaves.values()].find((entry) => sameDocument(entry) && entry.draftId === message.draftId && ["review", "blocked", "needsAccount"].includes(entry.status));
  if (draft) { clearTimeout(draft.timer); draft.password = ""; pendingSaves.delete(draft.id); }
  makeRoomForSave();
  const entry = { id: crypto.randomUUID(), target, host: new URL(target.frameUrl).host,
    username: message.username, password: message.password, saveKind,
    submissionId: message.submissionId, draftId: message.draftId, expiresAt: Date.now() + SAVE_TTL,
    status: "queued", attempts: 0, controller: null };
  entry.timer = setTimeout(() => discardSecret(entry, "expired", "saveExpired"), SAVE_TTL);
  pendingSaves.set(entry.id, entry);
  const status = reviewError ? "blocked" : message.needsAccount || (message.review && !entry.username) ? "needsAccount" : message.review ? "review" : "queued";
  const messageKey = reviewError || (status === "needsAccount" ? "saveNoAccount" : status === "review" ? "saveReview" : client.ready ? "saveQueued" : "saveWaitingUnlock");
  if (!savesRecovered) { entry.recoveryStatus = status; entry.recoveryMessageKey = messageKey; }
  setSaveStatus(entry, status, messageKey);
  // Acknowledge only after the in-memory browser session copy is available.
  try { await persistSaves(); }
  catch { setSaveStatus(entry, "failed", "saveStorageFailed"); return { ok: false, errorKey: "saveStorageFailed", saveId: entry.id }; }
  // Open the existing unlock/save UI while the user's submit is still recent.
  // Older browsers may refuse openPopup; the persistent badge remains actionable.
  if (!message.review && !client.ready && chrome.action?.openPopup) {
    try { Promise.resolve(chrome.action.openPopup()).catch(() => {}); } catch {}
  }
  queueMicrotask(flushPendingSaves);
  return { ok: true, saveId: entry.id, status: entry.status };
}
async function flushPendingSaves() {
  if (!await recoverPendingSaves()) return;
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
        const record = recentFills.get(entry.target.documentId);
        const passwordDigest = await digest(entry.password);
        if (!stillPending(entry)) continue;
        const unchanged = entry.saveKind === "login" && record && record.username === entry.username && Date.now() - record.at < 300000 &&
          await record.digest === passwordDigest;
        if (!stillPending(entry)) continue;
        if (unchanged && recentFills.get(entry.target.documentId) === record) {
          discardSecret(entry, "skipped", "saveUnchanged"); continue;
        }
        if (!entry.username && !client.capabilities?.canSaveAccountWithEmptyUserName) {
          setSaveStatus(entry, "needsAccount", "saveNoAccount"); continue;
        }
        entry.controller = new AbortController();
        entry.attempts++;
        setSaveStatus(entry, "saving", "saveSending");
        // Recovery of this state is uncertain, never an automatic duplicate post.
        await persistSaves();
        if (!stillPending(entry)) continue;
        // maybeAdd lets Apple's own sheet compare an existing account and confirm updates.
        // Do not read the password (and request Touch ID) just to suppress a save prompt.
        await client.saveLogin(entry.target.tabId, entry.target.frameUrl, entry.username, entry.password,
          { signal: entry.controller.signal, expiresAt: entry.expiresAt, frameId: entry.target.frameId, kind: entry.saveKind });
        if (!stillPending(entry)) continue;
        clearCaches();
        // A previous fill digest describes the old version, not a subsequent save.
        for (const frame of frames.values()) if (frame.origin === entry.target.origin) recentFills.delete(frame.documentId);
        recentFills.delete(entry.target.documentId);
        entry.controller = null;
        entry.completedAt = Date.now();
        discardSecret(entry, "submitted", "saveSubmitted");
      } catch (error) {
        if (!stillPending(entry)) continue;
        entry.controller = null;
        console.warn("[FAPassword] deferred save failed");
        if (error.mayHaveBeenSent) setSaveStatus(entry, "uncertain", "saveUncertain");
        else if (saveStorageError) setSaveStatus(entry, "failed", "saveStorageFailed");
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

function recoverPendingSaves() {
  if (savesRecovered) return Promise.resolve(true);
  if (saveRecoveryAttempt) return saveRecoveryAttempt;
  saveRecoveryAttempt = (async () => {
    let recovered;
    try { recovered = await saveStore.load(); }
    catch {
      saveStorageError = true; saveRecoveryError = "saveStorageFailed"; publish();
      return false;
    }
    for (const saved of recovered) {
      if (typeof saved?.id !== "string" || typeof saved.username !== "string" || typeof saved.password !== "string" ||
        !saved.target || !usablePage(saved.target.frameUrl) || !Number.isFinite(saved.expiresAt)) continue;
      const local = pendingSaves.get(saved.id) || [...pendingSaves.values()].find((entry) =>
        entry.target.documentId === saved.target.documentId && entry.target.documentKey === saved.target.documentKey &&
        entry.submissionId === saved.submissionId);
      if (local) {
        if (local.status === "cancelPending") continue;
        // A persisted terminal or possibly sent operation must dominate a
        // duplicate captured during an unreadable session, avoiding replay.
        if (!["saving", "uncertain", "submitted", "skipped", "expired", "cancelPending", "cancelled"].includes(saved.status)) continue;
        clearTimeout(local.timer); clearTimeout(local.retryTimer);
        local.password = ""; pendingSaves.delete(local.id);
      }
      const entry = { ...saved, controller: null, expiresAt: Math.min(saved.expiresAt, Date.now() + SAVE_TTL) };
      if (["cancelPending", "cancelled"].includes(entry.status)) {
        entry.password = ""; entry.status = "cancelPending"; entry.messageKey = "saveCancelling";
      } else if (entry.password && Date.now() >= entry.expiresAt) {
        entry.password = ""; entry.status = "expired"; entry.messageKey = "saveExpired";
      } else if (entry.status === "saving") { entry.status = "uncertain"; entry.messageKey = "saveUncertain"; }
      else if (entry.status === "queued") {
        // A former worker may have accepted a cancellation that could not be
        // persisted. Without durable knowledge, require a fresh confirmation
        // rather than automatically replaying any recovered queued password.
        entry.status = entry.username ? "review" : "needsAccount";
        entry.messageKey = entry.username ? "saveRecoveredReview" : "saveNoAccount";
      }
      if (entry.password) entry.timer = setTimeout(() => discardSecret(entry, "expired", "saveExpired"), entry.expiresAt - Date.now());
      pendingSaves.set(entry.id, entry);
    }
    savesRecovered = true; saveRecoveryError = null;
    for (const entry of pendingSaves.values()) {
      if (!entry.recoveryStatus) continue;
      if (stillPending(entry)) {
        entry.status = entry.recoveryStatus;
        entry.messageKey = entry.recoveryMessageKey || (entry.status === "needsAccount" ? "saveNoAccount" : entry.status === "review" ? "saveReview" :
          client.ready ? "saveQueued" : "saveWaitingUnlock");
      }
      delete entry.recoveryStatus;
      delete entry.recoveryMessageKey;
    }
    // This is a merge, never an overwrite of an unread snapshot. A failed merge
    // write still cannot send: flush persists each saving state before posting.
    await persistSaves().catch(() => {}); publish();
    for (const entry of pendingSaves.values()) if (entry.status === "cancelPending") completeCancellation(entry);
    if (client.ready) queueMicrotask(flushPendingSaves);
    return true;
  })().finally(() => { saveRecoveryAttempt = null; });
  return saveRecoveryAttempt;
}
recoverPendingSaves();

const contentAllowed = new Set(["frameReady", "recordFocus", "inlineLogins", "inlineFill", "cancelFill", "resolveSave", "updateSaveDraft", "saveNotice", "beginUnlock"]);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    try {
      const fromUi = ownUi(sender);
      const fromContent = sender.id === chrome.runtime.id && sender.tab && contentAllowed.has(message?.type);
      if (!fromUi && !fromContent) throw new Error("forbidden message");
      await recoverPendingSaves();
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
          return respond({ ok: true, locked: false, logins: orderLogins(target.origin, await getLoginNames(target.tabId, target.frameUrl, target.frameId)) });
        case "inlineFill":
          return respond(await performFill(target, message.loginName?.username, message.requestId));
        case "cancelFill":
          operations.get(operationKey(target.documentId, message.requestId))?.abort(new Error("fill cancelled"));
          return respond({ ok: true });
        case "resolveSave":
          return respond(await queueSave(message, target));
        case "updateSaveDraft": {
          const entry = [...pendingSaves.values()].find((entry) => entry.draftId === message.draftId &&
            entry.target.documentId === target.documentId && entry.target.documentKey === target.documentKey &&
            ["review", "blocked", "needsAccount"].includes(entry.status));
          if (!entry || !stillPending(entry)) return respond({ ok: true });
          const credential = message.credential;
          if (!credential || credential.errorKey || !credential.password) {
            setSaveStatus(entry, "blocked", credential?.errorKey === "errorChooseField" ? "errorChooseField" : "errorPasswordConfirmation");
          } else {
            if (typeof credential.password !== "string" || typeof credential.username !== "string") throw new Error("invalid draft");
            entry.password = credential.password; entry.username = credential.username;
            setSaveStatus(entry, credential.needsAccount || !entry.username ? "needsAccount" : "review", credential.needsAccount || !entry.username ? "saveNoAccount" : "saveReview");
          }
          await persistSaves(); return respond({ ok: true });
        }
        case "saveNotice": {
          const allowed = ["errorChooseField", "errorPasswordConfirmation", "saveFailed", "saveStorageFailed", "saveQueueFull", "errorConnection"];
          if (!allowed.includes(message.messageKey)) throw new Error("invalid save notice");
          const previous = [...pendingSaves.values()].find((entry) => entry.target.documentId === target.documentId && entry.submissionId === message.submissionId);
          if (previous) return respond({ ok: true });
          makeRoomForSave();
          const entry = { id: crypto.randomUUID(), target, host: new URL(target.frameUrl).host, username: "", password: "",
            status: "notice", submissionId: message.submissionId, expiresAt: Date.now() + SAVE_TTL, messageKey: message.messageKey };
          pendingSaves.set(entry.id, entry); publish(); await persistSaves(); return respond({ ok: true });
        }
        case "beginUnlock":
          return respond(await beginInlineUnlock(client, ensureConnected, () => chrome.action.openPopup()));
        case "getState":
        case "retryConnection":
          await ensureConnected();
          return respond({ ok: true, state: client.state, hasChallenge: client.hasChallenge,
            errorKey: lastConnectionError || saveRecoveryError, saveRecoveryError, saves: publicSaves() });
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
          const logins = orderLogins(origin, await getLoginNames(tab.id, url, frame?.frameId || 0));
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
          if (!entry || !stillPending(entry) || entry.status === "saving" || entry.status === "blocked" || entry.status === "cancelPending") throw new Error("save expired");
          if (entry.status === "needsAccount") {
            if (typeof message.username !== "string" || !message.username.trim()) throw new Error("no account selected");
            entry.username = message.username;
          }
          clearTimeout(entry.retryTimer);
          setSaveStatus(entry, "queued", "saveQueued"); await persistSaves(); queueMicrotask(flushPendingSaves);
          return respond({ ok: true, saves: publicSaves() });
        }
        case "cancelSave": {
          const entry = pendingSaves.get(message.saveId);
          if (!entry && !savesRecovered) return respond({ ok: false, errorKey: "saveStorageFailed",
            state: client.state, saveRecoveryError, saves: publicSaves() });
          if (entry && !await completeCancellation(entry)) return respond({ ok: false, errorKey: "saveCancelFailed",
            state: client.state, saveRecoveryError, saves: publicSaves() });
          return respond({ ok: true, saves: publicSaves() });
        }
        default: throw new Error("unknown message");
      }
    } catch (error) { respond(failure(error)); }
  })();
  return true;
});
// Reapply only the user's selected browser controls; payment autofill is never touched.
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
