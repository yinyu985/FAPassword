import { activeTab, normalizePin, pageContext } from "./shared.js";

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
const pinNote = document.getElementById("pin-note");
const pinError = document.getElementById("pin-error");
const refreshBtn = document.getElementById("refresh");
const verifyBtn = document.getElementById("verify");
const newCodeBtn = document.getElementById("newcode");

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

  const render = () => {
    pref.get({}, (detail) => {
      if (chrome.runtime.lastError || !detail) return;
      row.hidden = false;
      toggle.checked = detail.value === false;
      const controllable =
        detail.levelOfControl === "controllable_by_this_extension" ||
        detail.levelOfControl === "controlled_by_this_extension";
      toggle.disabled = !controllable;
      note.textContent = controllable ? "" : blockedText(detail.levelOfControl);
    });
  };

  toggle.addEventListener("change", () => {
    const on = toggle.checked;
    chrome.storage?.local?.set({ [storageKey]: on });
    const verify = () =>
      pref.get({}, (detail) => {
        render();
        if (on && detail && detail.value !== false) note.textContent = t(refusedText);
      });
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
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage("com.fapassword.policy", { action }, (resp) => {
        if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
        else resolve(resp || { error: "no reply" });
      });
    } catch (e) {
      resolve({ error: String(e) });
    }
  });
}

async function renderPolicyToggle() {
  const r = await policyMsg("get");
  if (r.error || !r.ok) {
    policyToggle.disabled = true;
    policyNote.textContent = t("policyHelperNeeded");
    return;
  }
  policyToggle.disabled = false;
  policyToggle.checked = !!r.hidden;
  policyNote.textContent = "";
}

policyToggle.addEventListener("change", async () => {
  const on = policyToggle.checked;
  policyToggle.disabled = true;
  const r = await policyMsg(on ? "set" : "clear");
  policyToggle.disabled = false;
  if (r.error || !r.ok) {
    policyNote.textContent = t("policyHelperFailed");
    policyToggle.checked = !on;
    return;
  }
  // reflect the REAL forced-policy state; the profile only sticks once approved
  policyToggle.checked = !!r.hidden;
  if (on && !r.hidden) policyNote.textContent = t("approveProfile");
  else if (!on && r.hidden) policyNote.textContent = t("removeProfile");
  else policyNote.textContent = "";
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
  dot.className = "dot";
  if (state === "unlocked") dot.classList.add("ok");
  else if (state === "needs_pin") dot.classList.add("warn");
  else if (state === "no_helper") dot.classList.add("err");
}

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      const error = chrome.runtime.lastError;
      resolve(error ? { ok: false, error: error.message } : response);
    });
  });
}

let lastState = "disconnected";
let renderSeq = 0;

async function render(state) {
  const seq = ++renderSeq;
  lastState = state;
  setDot(state);
  refreshBtn.hidden = state !== "unlocked" && state !== "needs_pin";
  if (state === "no_helper") return show("nohelper");
  if (state === "disconnected") return show("connecting");
  if (state === "needs_pin") {
    show("pin");
    pinInput.focus();
    return;
  }
  if (state === "unlocked") {
    await renderLogins(seq);
    if (seq !== renderSeq) return;
    return show("unlocked");
  }
  // unknown state must never leave every view hidden (blank popup)
  show("connecting");
}

async function renderLogins(seq = renderSeq) {
  const tab = await activeTab();
  const list = document.getElementById("logins");
  const none = document.getElementById("nologins");
  list.innerHTML = "";
  none.hidden = true;

  const context = tab?.url ? pageContext(tab.url) : null;
  document.getElementById("site").textContent = context?.host || "";
  if (tab?.id == null || !context || !["http:", "https:"].includes(context.url.protocol)) {
    none.textContent = t("pageUnavailable");
    none.hidden = false;
    return;
  }

  const res = await send({ type: "getLogins" });
  if (seq !== renderSeq) return;
  if (!res?.ok) {
    none.hidden = false;
    none.textContent = res?.error ?? t("loadFailed");
    return;
  }
  if (!res.logins.length) {
    none.hidden = false;
    return;
  }
  for (const login of res.logins) {
    const li = document.createElement("li");
    const u = document.createElement("span");
    u.className = "u";
    u.textContent = login.username || t("noUsername");
    u.title = login.username || t("noUsername");
    const fill = document.createElement("button");
    fill.textContent = t("fill");
    fill.addEventListener("click", async () => {
      fill.disabled = true;
      const r = await send({ type: "fillOnPage", loginName: login });
      if (r?.ok && r.filled) window.close();
      else {
        fill.disabled = false;
        none.textContent = r?.error || t("fillFailed");
        none.hidden = false;
      }
    });
    li.append(u, fill);
    list.appendChild(li);
  }
}

let verifyingPin = false;

async function verifyPin() {
  if (verifyingPin) return;
  pinNote.hidden = true;
  pinError.hidden = true;
  const pin = normalizePin(pinInput.value);
  pinInput.value = pin;
  if (pin.length !== 6) return;
  verifyingPin = true;
  verifyBtn.disabled = true;
  newCodeBtn.disabled = true;
  const res = await send({ type: "verifyPin", pin });
  verifyingPin = false;
  verifyBtn.disabled = false;
  newCodeBtn.disabled = false;
  if (res?.ok) render(res.state);
  else {
    // a failed attempt spends the code, so the background put a fresh one on the Mac
    const base = res?.error ?? t("verificationFailed");
    pinError.textContent = res?.newCode ? t("enterNewCode", base) : base;
    pinError.hidden = false;
    pinInput.value = "";
    pinInput.focus();
  }
}

verifyBtn.addEventListener("click", verifyPin);

pinInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") verifyPin();
});
pinInput.addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text");
  if (text == null) return;
  // Normalize before maxlength can truncate formatted OCR text such as
  // "123 456" or a value with a trailing newline/invisible character.
  e.preventDefault();
  pinInput.value = normalizePin(text);
  if (pinInput.value.length === 6) verifyPin();
});
// auto-submit once all 6 digits are in, like apple - no Enter needed
pinInput.addEventListener("input", () => {
  const pin = normalizePin(pinInput.value);
  if (pinInput.value !== pin) pinInput.value = pin;
  if (pin.length === 6) verifyPin();
});

let noteTimer = null;
function flashNote(text) {
  const el = document.getElementById("refresh-note");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => (el.hidden = true), 2500);
}

let requestingNewCode = false;
async function requestNewCode() {
  if (requestingNewCode || verifyingPin) return;
  requestingNewCode = true;
  pinNote.hidden = true;
  pinError.hidden = true;
  pinInput.value = "";
  newCodeBtn.disabled = true;
  newCodeBtn.setAttribute("aria-busy", "true");
  newCodeBtn.textContent = t("requestingNewCode");

  try {
    const res = await send({ type: "requestChallenge" });
    if (!res?.ok || !res.hasChallenge) {
      pinError.textContent = res?.error ?? t("codeRequestFailed");
      pinError.hidden = false;
      return;
    }
    await render(res.state);
    pinNote.textContent = t("newCodeReady");
    pinNote.hidden = false;
    pinInput.focus();
  } catch (error) {
    pinError.textContent = String(error?.message ?? error ?? t("codeRequestFailed"));
    pinError.hidden = false;
  } finally {
    requestingNewCode = false;
    newCodeBtn.disabled = false;
    newCodeBtn.removeAttribute("aria-busy");
    newCodeBtn.textContent = t("requestNewCode");
  }
}

refreshBtn.addEventListener("click", async () => {
  refreshBtn.disabled = true;
  refreshBtn.classList.add("spinning");
  if (lastState === "needs_pin") {
    // locked: refresh means "get me a fresh code on the mac"
    await requestNewCode();
  } else {
    // unlocked: drop cached passwords, re-fill the page with a fresh read (a password just
    // changed in the Passwords app lands without re-clicking Fill), then re-list
    const r = await send({ type: "refreshAndRefill" });
    await renderLogins();
    if (r?.refilled) flashNote(t("refilled", r.username));
    else flashNote(t("passwordsRefreshed"));
  }
  refreshBtn.classList.remove("spinning");
  refreshBtn.disabled = false;
});

newCodeBtn.addEventListener("click", requestNewCode);

const statePort = chrome.runtime.connect({ name: "fapassword-popup" });
statePort.onMessage.addListener((msg) => {
  if (msg?.type === "state") render(msg.state);
});

(async () => {
  const res = await send({ type: "getState" });
  let state = res?.state ?? "disconnected";
  if (state === "needs_pin") {
    // trigger the macOS access prompt, but never on top of a code thats already showing
    // (the inline box may have just asked for one) - a second prompt kills the first code
    const ch = await send({ type: "requestChallenge", ifNeeded: true });
    state = ch?.state ?? state;
    if (!ch?.ok) {
      pinError.textContent = ch?.error || t("codeRequestFailed");
      pinError.hidden = false;
    }
  }
  render(state);
})();
