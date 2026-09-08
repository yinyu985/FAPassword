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
    toggle.checked = detail.value === false;
    const controllable =
      detail.levelOfControl === "controllable_by_this_extension" ||
      detail.levelOfControl === "controlled_by_this_extension";
    toggle.disabled = !controllable;
    setNote(note, controllable ? "" : blockedText(detail.levelOfControl), !controllable);
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
        if (writeFailed || readFailed || !detail || detail.value !== !on) {
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
    if (!pinOperation) pinInput.focus();
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

let savesSignature = "";
function renderSaves(saves = []) {
  const signature = JSON.stringify([lastState, saves]);
  if (signature === savesSignature) return;
  savesSignature = signature;
  const section = document.getElementById("pending-saves");
  const list = document.getElementById("save-list");
  list.replaceChildren(); section.hidden = !saves.length;
  for (const save of saves) {
    const item = document.createElement("li");
    const text = document.createElement("p");
    text.className = "notice";
    text.classList.toggle("failed", ["failed", "uncertain", "expired"].includes(save.status) || save.messageKey === "saveNoAccount");
    text.textContent = `${save.host} · ${save.username || t("noUsername")} — ${t(save.messageKey || "saveQueued")}`;
    item.appendChild(text);
    if (["queued", "failed", "uncertain"].includes(save.status)) {
      const retry = document.createElement("button");
      retry.textContent = t(lastState === "unlocked" ? "retry" : "unlock");
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        if (lastState !== "unlocked") await connectAndRender();
        const result = await send({ type: "retrySave", saveId: save.id });
        if (result.saves) renderSaves(result.saves);
      });
      item.appendChild(retry);
    }
    const cancel = document.createElement("button");
    cancel.textContent = t(["submitted", "skipped", "expired", "cancelled"].includes(save.status) ? "dismiss" : "cancelSave");
    cancel.addEventListener("click", async () => { const result = await send({ type: "cancelSave", saveId: save.id }); renderSaves(result.saves); });
    item.appendChild(cancel); list.appendChild(item);
  }
}
let connecting = false;
async function connectAndRender() {
  if (connecting) return;
  connecting = true;
  for (const button of document.querySelectorAll(".retry-connection")) button.disabled = true;
  try {
    const response = await send({ type: "retryConnection" });
    render(response.state || "disconnected"); renderSaves(response.saves);
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
    render(message.state); renderSaves(message.saves);
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
