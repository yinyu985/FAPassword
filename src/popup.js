import { normalizePin } from "./shared.js";
import "./password-generator.js";
import { preparePasswordsLaunch, PASSWORDS_HELP_URL, PASSWORDS_MODERN_SETTINGS_URL } from './passwords-launch.js';

const t = (name, substitutions) => chrome.i18n.getMessage(name, substitutions) || name;
document.documentElement.lang = chrome.i18n.getUILanguage().replace("_", "-");
for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
for (const el of document.querySelectorAll("[data-i18n-aria-label]")) {
  el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
}

const views = {
  nohelper: document.getElementById("view-nohelper"),
  pin: document.getElementById("view-pin"),
  connecting: document.getElementById("view-connecting"),
  unlocked: document.getElementById("view-unlocked"),
};
const dot = document.getElementById("dot");
const pinInput = document.getElementById("pin");
const statusMessage = document.getElementById("status-message");
const refreshBtn = document.getElementById("refresh");
const verifyBtn = document.getElementById("verify");
const newCodeBtn = document.getElementById("newcode");
const openPasswordsBtn = document.getElementById("open-passwords");
let passwordsLaunchUrl = PASSWORDS_HELP_URL;
let passwordsNativeLauncher = false;
openPasswordsBtn.disabled = true;
preparePasswordsLaunch(send).then(({ url, native }) => {
  passwordsLaunchUrl = url;
  passwordsNativeLauncher = native;
  openPasswordsBtn.disabled = false;
});
const generatePasswordBtn = document.getElementById("generate-password");
const generatedPasswordPanel = document.getElementById("generated-password-panel");
const generatedPasswordInput = document.getElementById("generated-password");
const copyGeneratedPasswordBtn = document.getElementById("copy-generated-password");
const includeSpecialInput = document.getElementById("include-special");
const passwordLengthInput = document.getElementById("password-length");

function show(name) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
}

// Both browser privacy toggles have the same lifecycle: show only when supported, persist
// the user's choice, set/clear the Chromium preference, then read it back because policy can
// silently refuse a write.
function setupPrivacyToggle({ toggleId, rowId, noteId, service, storageKey, blockedText, refusedText }) {
  const toggle = document.getElementById(toggleId);
  const row = document.getElementById(rowId);
  const note = document.getElementById(noteId);
  const pref = chrome.privacy?.services?.[service];
  if (!pref?.get) return;

  const renderDetail = (detail) => {
    row.hidden = false;
    const controlled = detail.levelOfControl === "controlled_by_this_extension";
    const controllable =
      detail.levelOfControl === "controllable_by_this_extension" ||
      controlled;
    // When the browser's own setting is already false, clearing this extension's
    // setting must leave the switch off: it represents who controls the value,
    // not merely the effective browser-wide value.
    toggle.checked = controlled ? detail.value === false : !controllable && detail.value === false;
    toggle.disabled = !controllable;
    if (!controllable) setNote(note, blockedText(detail.levelOfControl), true);
    else if (detail.value === false && !controlled) setNote(note, t("disabledByBrowser"));
    else setNote(note);
  };
  const render = () => pref.get({}, (detail) => {
    if (chrome.runtime.lastError || !detail) return;
    renderDetail(detail);
  });

  toggle.addEventListener("change", () => {
    const on = toggle.checked;
    toggle.disabled = true;
    chrome.storage?.local?.set({ [storageKey]: on });
    const verify = () => {
      const writeFailed = !!chrome.runtime.lastError;
      pref.get({}, (detail) => {
        const readFailed = !!chrome.runtime.lastError;
        if (detail && !readFailed) renderDetail(detail);
        else toggle.disabled = false;
        const applied = detail && (on
          ? detail.value === false && detail.levelOfControl === "controlled_by_this_extension"
          : detail.levelOfControl !== "controlled_by_this_extension");
        if (writeFailed || readFailed || !applied) {
          setNote(note, t(refusedText), true);
        }
      });
    };
    if (on) pref.set({ value: false }, verify);
    else pref.clear({}, verify);
  });

  render();
}

setupPrivacyToggle({
  toggleId: "pm-toggle",
  rowId: "pm-row",
  noteId: "pm-note",
  service: "passwordSavingEnabled",
  storageKey: "suppressSaveBubble",
  blockedText: (level) =>
    t(level === "controlled_by_other_extensions" ? "controlledByExtension" : "controlledByPolicy"),
  refusedText: "browserRefused",
});

// hide the browser password manager via a real macOS config profile (a user defaults write isnt forced), approved once in System Settings
const policyToggle = document.getElementById("policy-toggle");
const policyNote = document.getElementById("policy-note");

function policyMsg(action) {
  return send({ type: "policy", action });
}

async function renderPolicyToggle() {
  const r = await policyMsg("get");
  if (r.error || !r.ok || r.scopeVersion !== 2) {
    policyToggle.disabled = true;
    setNote(policyNote, t("policyHelperNeeded"), true);
    return;
  }
  policyToggle.disabled = !!(r.managed && r.value === true);
  document.getElementById("policy-scope").textContent = t("policyScope", r.browserName);
  policyToggle.checked = !!r.hidden;
  setNote(policyNote, r.managed && r.value === true ? t("controlledByPolicy") : "", r.managed && r.value === true);
}

policyToggle.addEventListener("change", async () => {
  const on = policyToggle.checked;
  policyToggle.disabled = true;
  const r = await policyMsg(on ? "set" : "clear");
  policyToggle.disabled = false;
  if (r.error || !r.ok) {
    setNote(policyNote, t("policyHelperFailed"), true);
    policyToggle.checked = !on;
    return;
  }
  // reflect the REAL forced-policy state; the profile only sticks once approved
  policyToggle.checked = !!r.hidden;
  if (on && !r.hidden) setNote(policyNote, t("approveProfile"));
  else if (!on && r.hidden) setNote(policyNote, t("removeProfile"));
  else setNote(policyNote);
});

renderPolicyToggle();

// Address/contact autofill and typed-form history only; credit-card autofill stays untouched.
setupPrivacyToggle({
  toggleId: "af-toggle",
  rowId: "af-row",
  noteId: "af-note",
  service: "autofillAddressEnabled",
  storageKey: "suppressAddressAutofill",
  blockedText: () => t("controlledElsewhere"),
  refusedText: "autofillRefused",
});

function setDot(state) {
  dot.className = `dot ${state === "unlocked" ? "ok" : state === "needs_pin" ? "warn" : "err"}`;
  const label = t(state === "unlocked" ? "stateUnlocked" : state === "needs_pin" ? "stateLocked" : "stateDisconnected");
  dot.title = label; dot.setAttribute("aria-label", label);
}
function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      resolve(error ? { ok: false, errorKey: "errorConnection" } : response || { ok: false, errorKey: "errorConnection" });
    });
  });
}
const responseText = (response, fallback = "errorOperation") => t(response?.errorKey || fallback);
let lastState = null;
let renderSeq = 0;
let pinOperation = null;
let listOperation = null;
let fillOperation = null;
let loginResult = null;
const refillBtn = document.getElementById("refill");
const list = document.getElementById("logins");

function updateControls() {
  const busy = !!(listOperation || fillOperation);
  refreshBtn.disabled = !!pinOperation || busy;
  refreshBtn.classList.toggle("spinning", !!listOperation?.refresh);
  refreshBtn.setAttribute("aria-busy", String(!!listOperation?.refresh));
  list.setAttribute("aria-busy", String(busy));
  for (const button of list.querySelectorAll("button")) button.disabled = busy || !loginResult?.targetId;
  refillBtn.disabled = busy;
}
function setNote(element, text = "", failed = false) {
  element.textContent = text;
  element.classList.toggle("failed", failed);
}
function setStatus(text = "", failed = false) {
  // One shared live region below the active view; empty text occupies no space.
  if (statusMessage.textContent !== text) statusMessage.textContent = text;
  statusMessage.classList.toggle("failed", failed);
}

openPasswordsBtn.addEventListener("click", async () => {
  if (openPasswordsBtn.disabled) return;
  openPasswordsBtn.disabled = true;
  if (passwordsNativeLauncher) {
    try {
      const result = await send({ type: "openPasswords" });
      if (!result?.ok) throw new Error("Passwords launch failed");
      setStatus(t(result.target === "app" ? "passwordOpenRequested" : "passwordSettingsOpened"));
    } catch {
      passwordsNativeLauncher = false;
      // A new click preserves user activation for the browser-only fallback.
      setStatus(t("passwordLaunchRetrySettings"), true);
    } finally {
      openPasswordsBtn.disabled = false;
    }
    return;
  }
  // Resolve the OS version before the click to preserve its user activation.
  const link = document.createElement("a");
  link.href = passwordsLaunchUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.hidden = true;
  document.body.appendChild(link);
  try {
    link.click();
    // External protocols have no completion callback; never claim the app opened.
    setStatus(t(passwordsLaunchUrl === PASSWORDS_MODERN_SETTINGS_URL ? "passwordOpenModern" :
      passwordsLaunchUrl === PASSWORDS_HELP_URL ? "passwordOpenHelp" : "passwordOpenRequested"));
  } catch {
    setStatus(t("openPasswordsFailed"), true);
  } finally {
    link.remove();
    openPasswordsBtn.disabled = false;
  }
});

generatePasswordBtn.addEventListener("click", () => {
  const length = Math.min(64, Math.max(8, Number.parseInt(passwordLengthInput.value, 10) || 16));
  passwordLengthInput.value = String(length);
  generatedPasswordInput.value = globalThis.FAPASSWORD_PASSWORDS.custom(length, includeSpecialInput.checked);
  generatedPasswordPanel.hidden = false;
  setStatus();
  generatedPasswordInput.focus();
  generatedPasswordInput.select();
});

copyGeneratedPasswordBtn.addEventListener("click", async () => {
  const password = generatedPasswordInput.value;
  if (!password) return;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(password);
    else {
      generatedPasswordInput.focus();
      generatedPasswordInput.select();
      if (!document.execCommand("copy")) throw new Error("copy failed");
    }
    setStatus(t("passwordCopied"));
  } catch {
    setStatus(t("copyPasswordFailed"), true);
  }
});

function pinBusy(operation) {
  pinOperation = operation;
  pinInput.disabled = verifyBtn.disabled = newCodeBtn.disabled = !!operation;
  updateControls();
  views.pin.setAttribute("aria-busy", String(!!operation));
}
function setPinStatus(text = t("pinMessage"), failed = false) {
  setStatus(text, failed);
  pinInput.setAttribute("aria-invalid", String(failed));
}
function render(state) {
  if (state === lastState) return;
  lastState = state;
  const seq = ++renderSeq;
  listOperation = fillOperation = loginResult = null;
  list.replaceChildren();
  document.getElementById("site").hidden = true;
  setStatus();
  updateControls();
  setDot(state);
  refreshBtn.hidden = !["unlocked", "needs_pin"].includes(state);
  if (state !== "needs_pin") { pinInput.value = ""; pinInput.setAttribute("aria-invalid", "false"); }
  if (state === "no_helper") { setStatus(t("noHelperMessage"), true); return show("nohelper"); }
  if (state === "disconnected") {
    show("connecting");
    setStatus(t("errorConnection"), true);
    return;
  }
  if (state === "needs_pin") {
    show("pin");
    setPinStatus(t(pinOperation === "request" ? "requestingCode" : pinOperation === "verify" ? "verifying" : "pinMessage"));
    if (!pinOperation && !document.activeElement?.matches("#save-list input")) pinInput.focus();
    return;
  }
  if (state === "unlocked") { show("unlocked"); renderLogins(seq); return; }
  show("connecting");
  setStatus(t("connecting"));
}
function accountRow(login) {
  const item = document.createElement("li");
  item.accountName = login.username;
  const username = document.createElement("span");
  username.className = "u"; username.textContent = login.username || t("noUsername"); username.title = username.textContent;
  const fill = document.createElement("button");
  fill.textContent = t("fill"); fill.setAttribute("aria-label", t("fillAccount", username.textContent));
  fill.addEventListener("click", async () => {
    if (listOperation || fillOperation || !loginResult?.targetId) return;
    const operation = fillOperation = { seq: renderSeq };
    updateControls(); setStatus(t("filling"));
    try {
      const response = await send({ type: "fillOnPage", targetId: loginResult.targetId, loginName: login });
      if (operation !== fillOperation) return;
      if (response.ok && response.filled) window.close();
      else setStatus(responseText(response, "fillFailed"), true);
    } finally {
      if (operation === fillOperation) { fillOperation = null; updateControls(); }
    }
  });
  item.append(username, fill);
  return item;
}

function renderLogins(seq = renderSeq, refresh = false) {
  if (listOperation?.seq === seq) return listOperation.promise;
  const operation = listOperation = { seq, refresh };
  updateControls();
  if (!loginResult && !refresh) {
    setStatus(t("loadingLogins"));
    refillBtn.hidden = true;
  }
  if (refresh) setStatus(t("refreshingLogins"));
  operation.promise = (async () => {
    try {
      const invalidated = refresh ? await send({ type: "refreshLogins" }) : { ok: true };
      const result = invalidated.ok ? await send({ type: "getLogins" }) : invalidated;
      if (operation !== listOperation || seq !== renderSeq || lastState !== "unlocked") return false;
      if (!result.ok) {
        setStatus(responseText(result, "loadFailed"), true);
        return false;
      }
      loginResult = result;
      const site = document.getElementById("site");
      site.hidden = !result.logins.length;
      if (site.textContent !== result.host) site.textContent = result.host || "";
      refillBtn.hidden = !result.refill;
      if (result.refill) refillBtn.textContent = t("refillAccount", [result.refill.username || t("noUsername"), result.refill.host]);
      const existing = new Map([...list.children].map((item) => [item.accountName, item]));
      const rows = result.logins.map((login) => existing.get(login.username) || accountRow(login));
      if (rows.length !== list.children.length || rows.some((row, index) => row !== list.children[index])) {
        list.replaceChildren(...rows);
      }
      for (const button of list.querySelectorAll("button")) button.title = result.targetId ? "" : t("errorChooseField");
      setStatus(!result.logins.length ? t("noLogins") : refresh ? t("passwordsRefreshed") : "");
      return true;
    } finally {
      if (operation === listOperation) { listOperation = null; updateControls(); }
    }
  })();
  return operation.promise;
}
async function verifyPin() {
  if (pinOperation) return;
  const pin = normalizePin(pinInput.value);
  pinInput.value = pin;
  if (pin.length !== 6) { setPinStatus(t("errorPinLength"), true); return; }
  setPinStatus(t("verifying"));
  pinBusy("verify");
  try {
    const response = await send({ type: "verifyPin", pin });
    pinInput.value = "";
    if (response.ok) render(response.state);
    else {
      setPinStatus(response.newCode ? t("enterNewCode", responseText(response, "verificationFailed")) : responseText(response, "verificationFailed"), true);
      if (response.state && response.state !== "needs_pin") render(response.state);
    }
  } finally { pinBusy(null); if (lastState === "needs_pin") pinInput.focus(); }
}
async function requestNewCode(ifNeeded = false) {
  if (pinOperation) return;
  pinInput.value = "";
  setPinStatus(t("requestingCode"));
  pinBusy("request");
  try {
    const response = await send({ type: "requestChallenge", ifNeeded });
    if (!response.ok || !response.hasChallenge) {
      setPinStatus(responseText(response, "codeRequestFailed"), true);
      if (response.state && response.state !== "needs_pin") render(response.state);
      return;
    }
    render(response.state);
    if (lastState === "needs_pin") setPinStatus(t(response.issued ? "newCodeReady" : "pinMessage"));
  } finally { pinBusy(null); if (lastState === "needs_pin") pinInput.focus(); }
}
verifyBtn.addEventListener("click", verifyPin);
newCodeBtn.addEventListener("click", () => requestNewCode());
pinInput.addEventListener("keydown", (event) => { if (event.key === "Enter") verifyPin(); });
pinInput.addEventListener("paste", (event) => {
  if (pinOperation) return;
  const text = event.clipboardData?.getData("text");
  if (text == null) return;
  event.preventDefault(); pinInput.value = normalizePin(text);
  if (pinInput.value.length === 6) verifyPin();
});
pinInput.addEventListener("input", () => {
  if (pinOperation) return;
  pinInput.value = normalizePin(pinInput.value);
  if (pinInput.value.length === 6) verifyPin();
});
refreshBtn.addEventListener("click", async () => {
  if (pinOperation || listOperation || fillOperation) return;
  if (lastState === "needs_pin") await requestNewCode();
  else if (lastState === "unlocked") await renderLogins(renderSeq, true);
});
refillBtn.addEventListener("click", async () => {
  if (listOperation || fillOperation) return;
  const operation = fillOperation = { seq: renderSeq };
  updateControls(); setStatus(t("filling"));
  try {
    const result = await send({ type: "refillOnPage" });
    if (operation !== fillOperation) return;
    const success = result.ok && result.filled;
    setStatus(success ? t("refillComplete") : responseText(result, "fillFailed"), !success);
  } finally { if (operation === fillOperation) { fillOperation = null; updateControls(); } }
});

const saveRows = new Map();
let saveSnapshotVersion = 0;
let saveRecoveryError = null;
let recoveryNotice;
let recoveryRetry;
function updateSaveRow(row) {
  const save = row.save;
  row.text.classList.toggle("failed", ["failed", "blocked", "notice", "uncertain", "expired", "cancelPending"].includes(save.status) || save.messageKey === "saveNoAccount");
  row.text.textContent = `${save.host} · ${save.username || t("noUsername")} — ${t(save.messageKey || "saveQueued")}`;
  if (save.status === "needsAccount" && !row.accountInput) {
    const input = row.accountInput = document.createElement("input");
    input.type = "text"; input.autocomplete = "off"; input.value = row.accountDraft;
    input.placeholder = t("saveAccountPlaceholder"); input.setAttribute("aria-label", t("saveAccountPlaceholder"));
    input.addEventListener("input", () => { row.accountDraft = input.value; });
    row.item.insertBefore(input, row.retry.parentNode === row.item ? row.retry : row.cancel);
  } else if (save.status !== "needsAccount" && row.accountInput) {
    row.accountDraft = row.accountInput.value;
    row.accountInput.remove(); row.accountInput = null;
  }
  const canRetry = ["queued", "review", "needsAccount", "failed", "uncertain"].includes(save.status);
  if (canRetry && row.retry.parentNode !== row.item) row.item.insertBefore(row.retry, row.cancel);
  else if (!canRetry) row.retry.remove();
  row.retry.textContent = t(["review", "needsAccount"].includes(save.status) ? "saveConfirm" : lastState === "unlocked" ? "retry" : "unlock");
  row.cancel.textContent = t(["submitted", "skipped", "expired", "cancelled", "notice"].includes(save.status) ? "dismiss" : "cancelSave");
  row.retry.disabled = !!row.operation || !!saveRecoveryError;
  row.cancel.disabled = !!row.operation;
  row.item.setAttribute("aria-busy", String(!!row.operation));
}
function saveRow(save) {
  const row = { save, item: document.createElement("li"), text: document.createElement("p"),
    retry: document.createElement("button"), cancel: document.createElement("button"),
    accountInput: null, accountDraft: "", operation: null, errorText: "" };
  row.item.dataset.saveId = save.id;
  row.text.className = "notice";
  row.retry.addEventListener("click", async () => {
    if (row.operation) return;
    const username = row.accountInput?.value;
    if (row.accountInput && !username.trim()) { row.accountInput.focus(); return; }
    row.operation = "retry"; updateSaveRow(row);
    try {
      if (lastState !== "unlocked") await connectAndRender();
      const version = saveSnapshotVersion;
      const result = await send({ type: "retrySave", saveId: row.save.id, username });
      if (saveRows.get(row.save.id) !== row) return;
      if (version === saveSnapshotVersion) renderSaves(result.saves, result.saveRecoveryError, !result.ok);
      if (!result.ok && !["submitted", "skipped", "expired"].includes(row.save.status)) {
        row.errorText = responseText(result, "saveFailed"); setStatus(row.errorText, true);
      }
    } finally { row.operation = null; updateSaveRow(row); }
  });
  row.cancel.addEventListener("click", async () => {
    if (row.operation) return;
    row.operation = "cancel"; updateSaveRow(row);
    try {
      const version = saveSnapshotVersion;
      const result = await send({ type: "cancelSave", saveId: row.save.id });
      // A newer broadcast may already have completed cancellation. A delayed
      // failure snapshot must not recreate the removed row or undo its state.
      if (saveRows.get(row.save.id) !== row) return;
      if (version === saveSnapshotVersion) renderSaves(result.saves, result.saveRecoveryError, !result.ok);
      if (!result.ok) { row.errorText = responseText(result, "saveFailed"); setStatus(row.errorText, true); }
      else if (row.errorText && statusMessage.textContent === row.errorText) setStatus();
    } finally { row.operation = null; updateSaveRow(row); }
  });
  row.item.append(row.text, row.cancel);
  return row;
}
function renderSaves(saves, recoveryError, preserveMissing = false) {
  if (Array.isArray(saves) || recoveryError !== undefined) saveSnapshotVersion++;
  const section = document.getElementById("pending-saves");
  const list = document.getElementById("save-list");
  if (recoveryError !== undefined) saveRecoveryError = recoveryError;
  if (!recoveryNotice) {
    recoveryNotice = document.createElement("p"); recoveryNotice.id = "save-recovery-error";
    recoveryNotice.className = "notice failed"; recoveryNotice.setAttribute("role", "status");
    recoveryRetry = document.createElement("button"); recoveryRetry.textContent = t("retry");
    recoveryRetry.addEventListener("click", async () => {
      recoveryRetry.disabled = true;
      try { await connectAndRender(); } finally { recoveryRetry.disabled = false; }
    });
    section.insertBefore(recoveryNotice, list); section.insertBefore(recoveryRetry, list);
  }
  recoveryNotice.hidden = recoveryRetry.hidden = !saveRecoveryError;
  recoveryNotice.textContent = saveRecoveryError ? t("saveRecoveryFailed") : "";
  // An error response without a snapshot is not evidence that the queue is empty.
  if (Array.isArray(saves) && !saveRecoveryError) {
    if (preserveMissing) {
      const merged = new Map([...saveRows.values()].map(row => [row.save.id, row.save]));
      for (const save of saves) merged.set(save.id, save);
      saves = [...merged.values()];
    }
    const ids = new Set(saves.map(save => save.id));
    for (const [id, row] of saveRows) {
      if (!ids.has(id)) { row.item.remove(); saveRows.delete(id); }
    }
    const focused = document.activeElement;
    const selection = focused?.matches("#save-list input") ? [focused.selectionStart, focused.selectionEnd] : null;
    for (const [index, save] of saves.entries()) {
      let row = saveRows.get(save.id);
      if (!row) { row = saveRow(save); saveRows.set(save.id, row); }
      row.save = save; updateSaveRow(row);
      if (list.children[index] !== row.item) list.insertBefore(row.item, list.children[index] || null);
    }
    if (selection && focused.isConnected && document.activeElement !== focused) {
      focused.focus({ preventScroll: true }); focused.setSelectionRange(...selection);
    }
  } else for (const row of saveRows.values()) updateSaveRow(row);
  section.hidden = !saveRows.size && !saveRecoveryError;
}
let connecting = false;
async function connectAndRender() {
  if (connecting) return;
  connecting = true;
  for (const button of document.querySelectorAll(".retry-connection")) button.disabled = true;
  try {
    const response = await send({ type: "retryConnection" });
    render(response.state || "disconnected"); renderSaves(response.saves, response.saveRecoveryError);
    if (response.state === "needs_pin") await requestNewCode(true);
    else if (response.errorKey) setStatus(responseText(response), true);
  } finally {
    connecting = false;
    for (const button of document.querySelectorAll(".retry-connection")) button.disabled = false;
  }
}
for (const button of document.querySelectorAll(".retry-connection")) button.addEventListener("click", connectAndRender);
let statePort;
let reconnectTimer;
function attachStatePort() {
  statePort = chrome.runtime.connect({ name: "fapassword-popup" });
  statePort.onMessage.addListener((message) => {
    if (message?.type !== "state") return;
    render(message.state); renderSaves(message.saves, message.saveRecoveryError);
  });
  statePort.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    render("disconnected");
    reconnectTimer = setTimeout(attachStatePort, 1000);
  });
}
window.addEventListener("pagehide", () => { clearTimeout(reconnectTimer); pinInput.value = ""; });
attachStatePort();
connectAndRender();
