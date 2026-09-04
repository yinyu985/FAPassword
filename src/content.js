// Fills credentials into the page on request. Never treats OTP inputs as login fields.

const tr = (name) => chrome.i18n?.getMessage(name) || name;
const {
  attrBlob,
  everPassword,
  isFillable,
  isLoginField,
  isOtpField,
  isPasswordField,
  isPasswordish,
  isSearchOrComboField,
  isUsernameField,
  isVisible,
  nonLoginHint: NONLOGIN_HINT,
} = globalThis.FAPASSWORD_FIELDS;

// native value setter + input/change so react/vue/angular re-sync (fixes "login fails until you edit a char")
function setValue(el, value) {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// fill near the anchor the user acted on so a multi-form page fills the right one (scopes to its form/shadow root)
function fillCredentials(username, password, anchor) {
  const root = anchor?.getRootNode?.();
  const searchRoot = root?.querySelectorAll ? root : document;
  const pool = new Set(searchRoot.querySelectorAll("input"));
  const inputs = Array.from(pool).filter(isFillable);
  let passwords = inputs.filter(isPasswordField);
  let usernames = inputs.filter(isUsernameField);

  const anchorForm = anchor && anchor.form;
  if (anchorForm) {
    const pwInForm = passwords.filter((p) => p.form === anchorForm);
    const userInForm = usernames.filter((u) => u.form === anchorForm);
    // Never borrow a password field from another form. Two-step username pages should
    // fill the identifier now and wait for the visible password step.
    passwords = pwInForm;
    usernames = userInForm;
  }

  const inputOrder = new Map(Array.from(searchRoot.querySelectorAll("input"), (el, i) => [el, i]));

  // password in anchor's form, else nearest by doc position, else first
  let firstPw = passwords[0];
  if (anchor && passwords.length > 1) {
    firstPw = passwords
      .map((p) => ({ p, d: Math.abs((inputOrder.get(anchor) ?? 0) - (inputOrder.get(p) ?? 0)) }))
      .sort((a, b) => a.d - b.d)[0].p;
  }

  // if the anchor itself is a username field, fill IT not some other form's
  let userTarget = null;
  if (username) {
    if (anchor && isUsernameField(anchor)) userTarget = anchor;
    else if (usernames.length) {
      userTarget = usernames[0];
      if (firstPw) {
        const before = usernames.filter((u) => u.compareDocumentPosition(firstPw) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (before.length) userTarget = before[before.length - 1];
      }
    }
  }

  let filled = false;
  if (userTarget) {
    setValue(userTarget, username);
    autofilledFields.add(userTarget);
    filled = true;
  }
  if (password && firstPw) {
    setValue(firstPw, password);
    everPassword.add(firstPw);
    autofilledFields.add(firstPw);
    filled = true;
  }
  return filled;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "fill") return false;
  // only accept fills from our own extension and only when host matches the origin
  // the background pinned the cred to, so a cred for site A never lands on site B
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, filled: false, error: "forbidden" });
    return true;
  }
  if (msg.expectedOrigin && location.origin.toLowerCase() !== msg.expectedOrigin) {
    sendResponse({ ok: false, filled: false, error: "origin mismatch" });
    return true;
  }
  if (msg.requestId != null && msg.requestId !== fillRequestSeq) {
    sendResponse({ ok: false, filled: false, error: "stale fill request" });
    return true;
  }
  const filled = fillCredentials(msg.username, msg.password, liveField(fillAnchor));
  // remember what we filled so a submit right after doesnt re-offer to save this existing login
  if (filled) rememberAutofill(msg.username, msg.password);
  sendResponse({ ok: true, filled });
  return true;
});

// set when the user clicks an offer
let fillAnchor = null;
let fillRequestSeq = 0;
const autofilledFields = new WeakSet();
// last credential we autofilled, to suppress a save-offer for a login just filled from the vault
let lastAutofill = null;
// last password we generated, so its submit always offers to save (reset page / password change)
let lastGenerated = null;

async function digestSecret(value) {
  const bytes = new TextEncoder().encode(value || "");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function expireSecretRecord(which, record, ttl) {
  record.timer = setTimeout(() => {
    if (which === "autofill" && lastAutofill === record) lastAutofill = null;
    if (which === "generated" && lastGenerated === record) lastGenerated = null;
  }, ttl);
}

function rememberAutofill(username, password) {
  if (lastAutofill?.timer) clearTimeout(lastAutofill.timer);
  const record = {
    host: location.hostname,
    username,
    passwordDigest: digestSecret(password),
    at: Date.now(),
    timer: null,
  };
  expireSecretRecord("autofill", record, 300_000);
  lastAutofill = record;
}

function rememberGenerated(password) {
  if (lastGenerated?.timer) clearTimeout(lastGenerated.timer);
  const record = {
    host: location.hostname,
    passwordDigest: digestSecret(password),
    at: Date.now(),
    timer: null,
  };
  expireSecretRecord("generated", record, 600_000);
  lastGenerated = record;
}

// inline autofill dropdown on focus, shown only on genuine username/password fields (never OTP/search)
let suggestionEl = null; // closed-shadow host; the page cannot read account names from it
let suggestionBox = null;
let anchorField = null;
let navItems = []; // selectable dropdown rows: [{ el, onActivate }]
let navIndex = -1;

function removeSuggestion() {
  if (suggestionEl) {
    suggestionEl.remove();
    suggestionEl = null;
    suggestionBox = null;
  }
  if (anchorField) {
    anchorField.removeAttribute("aria-expanded");
    anchorField.removeAttribute("aria-haspopup");
  }
  anchorField = null;
  navItems = [];
  navIndex = -1;
}

// highlight active row, keep it in view
function setActiveNav(i) {
  navIndex = i;
  navItems.forEach((it, idx) => {
    const on = idx === i;
    it.el.style.background = on ? "light-dark(#202421, #f4f5f2)" : "transparent";
    it.el.style.color = on ? "light-dark(#f4f5f2, #101211)" : "inherit";
    it.el.style.boxShadow = on
      ? "inset 3px 0 light-dark(#268d72, #59d5b8)"
      : "none";
    if (on) it.el.setAttribute("aria-selected", "true");
    else it.el.removeAttribute("aria-selected");
  });
  if (i >= 0 && navItems[i]) navItems[i].el.scrollIntoView({ block: "nearest" });
}

// make a row selectable by mouse and keyboard, tagged as a listbox option
function registerRow(row, onActivate) {
  row.setAttribute("role", "option");
  const idx = navItems.length;
  navItems.push({ el: row, onActivate });
  row.addEventListener("mouseenter", () => setActiveNav(idx));
  row.addEventListener("mousedown", (e) => {
    if (!e.isTrusted) return; // ignore page-synthesized events
    e.preventDefault();
    onActivate();
  });
}

// arrows move selection, Enter fills the row (not submit), Escape closes. driven from the
// focused anchor field (rows use mousedown+preventDefault so they never steal focus)
function onSuggestionKeydown(e) {
  if (!e.isTrusted) return; // a synthesized Enter must never select+fill a credential
  if (!suggestionEl) return;
  if (e.key === "Escape") {
    removeSuggestion();
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (!navItems.length || e.target !== anchorField) return;
  if (e.key === "ArrowDown") {
    setActiveNav((navIndex + 1) % navItems.length);
    e.preventDefault();
  } else if (e.key === "ArrowUp") {
    setActiveNav((navIndex - 1 + navItems.length) % navItems.length);
    e.preventDefault();
  } else if (e.key === "Enter" && navIndex >= 0) {
    e.preventDefault();
    e.stopPropagation();
    navItems[navIndex].onActivate();
  }
}

// re-position under the anchor on build and on scroll/resize so the dropdown follows
// the field instead of being destroyed
function positionBox() {
  if (!suggestionEl || !anchorField) return;
  // field gone or hidden (SPA step change, goes away after submit) - dont leave it dangling
  if (!anchorField.isConnected || !isVisible(anchorField)) {
    removeSuggestion();
    return;
  }
  const r = anchorField.getBoundingClientRect();
  suggestionEl.style.left = `${window.scrollX + r.left}px`;
  suggestionEl.style.minWidth = `${Math.max(r.width, 200)}px`;
  // flip above the field when there's no room below, so options never render off-screen
  const h = suggestionBox?.offsetHeight || suggestionEl.offsetHeight || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  if (r.bottom + 2 + h > vh && r.top - 2 - h > 0) {
    suggestionEl.style.top = `${window.scrollY + r.top - h - 2}px`;
  } else {
    suggestionEl.style.top = `${window.scrollY + r.bottom + 2}px`;
  }
}

const UI_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';

// Match the extension popup's Firstlight-inspired black-paper / white-ink surface.
// Canvas remains the fallback where light-dark() is unavailable.
function styleSuggestionSurface(el) {
  Object.assign(el.style, {
    background: "Canvas",
    color: "CanvasText",
    colorScheme: "light dark",
    border: "1px solid rgba(128,128,128,0.35)",
    borderRadius: "2px",
    boxShadow: "0 14px 36px rgba(0,0,0,0.30)",
    overflow: "hidden",
    font: `13px/1.4 ${UI_FONT}`,
  });
  el.style.setProperty("background", "light-dark(#f4f5f2, #070808)");
  el.style.setProperty("border-color", "light-dark(#aeb4af, #3a3d3b)");
}

function buildSuggestionBox(field) {
  removeSuggestion();
  anchorField = field;
  const host = document.createElement("div");
  host.setAttribute("data-fapassword-host", "");
  Object.assign(host.style, {
    all: "initial",
    position: "absolute",
    zIndex: "2147483647",
  });
  const shadow = host.attachShadow({ mode: "closed" });
  const box = document.createElement("div");
  box.setAttribute("role", "listbox");
  box.setAttribute("aria-label", tr("suggestionsLabel"));
  styleSuggestionSurface(box);
  Object.assign(box.style, { minWidth: "inherit", boxSizing: "border-box" });
  const header = document.createElement("div");
  header.textContent = "FAPASSWORD";
  Object.assign(header.style, {
    padding: "8px 10px 8px 13px",
    fontSize: "11px",
    fontWeight: "680",
    letterSpacing: "0.12em",
    borderBottom: "1px solid light-dark(#d0d4cf, #282b29)",
    boxShadow: "inset 3px 0 light-dark(#268d72, #59d5b8)",
  });
  box.appendChild(header);
  shadow.appendChild(box);
  document.body.appendChild(host);
  suggestionEl = host;
  suggestionBox = box;
  field.setAttribute("aria-haspopup", "listbox");
  field.setAttribute("aria-expanded", "true");
  positionBox();
  return box;
}

// a password field the user is creating (not signing in with): explicit new-password, or a
// signup shape - a confirm field present, or a register-style submit on the page
function isNewPasswordField(el) {
  if (!isPasswordField(el)) return false;
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  if (ac.includes("current-password")) return false;
  if (ac.includes("new-password")) return true;
  const pwCount = Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible).length;
  if (pwCount >= 2) return true;
  return Array.from(document.querySelectorAll("button, input[type=submit], input[type=button]")).some((b) =>
    /\b(sign[\s-]?up|register|create[\s-]?account|create[\s-]?your[\s-]?account)\b/i.test(b.textContent || b.value || ""),
  );
}

// react can remount the input between dropdown build and click, detaching our reference so
// the fill "works" but shows nothing. re-resolve by id/name, else the visible password field
function liveField(field) {
  if (!field || field.isConnected) return field;
  if (field.id) {
    const byId = document.getElementById(field.id);
    if (byId instanceof HTMLInputElement) return byId;
  }
  if (field.name) {
    const byName = document.querySelector(`input[name="${CSS.escape(field.name)}"]`);
    if (byName instanceof HTMLInputElement) return byName;
  }
  return anchorPwField(document) || field;
}

// fill a chosen generated password into the focused field and any empty confirm field in the
// same form. the submit save-flow then stores it (username + this password) in apple passwords
function fillGeneratedPassword(field, pw) {
  field = liveField(field);
  const targets = new Set([field]);
  const root = field.form || field.getRootNode?.() || document;
  for (const p of Array.from(root.querySelectorAll('input[type="password"]')).filter(isFillable)) {
    if (p === field || p.value) continue;
    if (p.form && field.form && p.form !== field.form) continue;
    targets.add(p);
  }
  for (const t of targets) {
    setValue(t, pw);
    everPassword.add(t);
  }
  // remember we generated this so submit always offers to save it (reset page / password change)
  rememberGenerated(pw);
}

// one row per saved login, showing the username/email like chrome. fill routes through the
// origin-checked background path, page never sees the password
function appendLoginRows(box, field, logins) {
  for (const login of logins) {
    const row = document.createElement("div");
    row.textContent = login.username || tr("noUsername");
    Object.assign(row.style, {
      padding: "9px 10px",
      cursor: "pointer",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
      borderBottom: "1px solid light-dark(#d0d4cf, #282b29)",
    });
    registerRow(row, () => {
      const requestId = ++fillRequestSeq;
      removeSuggestion();
      fillAnchor = field;
      chrome.runtime.sendMessage({ type: "inlineFill", loginName: login, requestId });
    });
    box.appendChild(row);
  }
}

// the two generator options (apple-style), each previewing the value it fills, below the
// saved accounts
function appendGeneratorOptions(box, field, separatorAbove) {
  const options = [
    { label: tr("strongPassword"), value: globalThis.FAPASSWORD_PASSWORDS.appleStyle() },
    { label: tr("noSpecialCharacters"), value: globalThis.FAPASSWORD_PASSWORDS.alphanumeric() },
  ];
  options.forEach((opt, idx) => {
    const item = document.createElement("div");
    item.setAttribute("data-op-generate", "1");
    Object.assign(item.style, {
      padding: "9px 10px",
      cursor: "pointer",
      borderTop: idx === 0 && separatorAbove ? "1px solid light-dark(#aeb4af, #3a3d3b)" : "none",
      borderBottom: "1px solid light-dark(#d0d4cf, #282b29)",
    });
    const label = document.createElement("div");
    label.textContent = opt.label;
    Object.assign(label.style, { fontWeight: "600", fontSize: "13px" });
    const preview = document.createElement("div");
    preview.textContent = opt.value;
    Object.assign(preview.style, {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "12px",
      opacity: "0.65",
      marginTop: "2px",
    });
    item.append(label, preview);
    registerRow(item, () => {
      fillGeneratedPassword(field, opt.value);
      removeSuggestion();
    });
    box.appendChild(item);
  });
}

// the focused element, piercing shadow roots (a field inside a web component)
function deepActiveElement() {
  let a = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

// bumped per offer so a stale async read from an earlier focus cant draw over a newer one
let offerSeq = 0;

// saved accounts first (listing names is free, no Touch ID), then generator options on a
// new-password field. locked vault shows an unlock row. fetches BEFORE building the box so an
// empty result never flashes a box on then off - nothing shows unless theres something to show
async function buildOfferSuggestion(field) {
  const hasGenerator = isNewPasswordField(field);
  const seq = ++offerSeq;

  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "inlineLogins" });
  } catch {
    res = null;
  }
  // a newer focus superseded this, or the field lost focus while we awaited
  if (seq !== offerSeq || field !== deepActiveElement()) return;

  const locked = !!(res?.ok && res.locked);
  const logins = res?.ok && !locked ? res.logins || [] : [];
  // no accounts, not locked, no generator: stay silent instead of flashing an empty box
  if (!locked && !logins.length && !hasGenerator) return;

  const box = buildSuggestionBox(field);
  if (locked) {
    // PIN entry belongs in extension UI, never in page-owned DOM.
    const row = document.createElement("div");
    row.textContent = tr("openToUnlock");
    Object.assign(row.style, {
      padding: "9px 10px",
      cursor: "pointer",
      borderBottom: "1px solid light-dark(#d0d4cf, #282b29)",
    });
    registerRow(row, async () => {
      row.textContent = tr("requestingCode");
      const response = await chrome.runtime.sendMessage({ type: "beginUnlock" }).catch(() => null);
      if (!row.isConnected) return;
      if (response?.state === "unlocked") {
        buildOfferSuggestion(field);
      } else if (response?.popupOpened) {
        row.textContent = tr("completeUnlockInPopup");
      } else if (!response?.popupOpened) {
        row.textContent = response?.challengeReady ? tr("codeReadyClickToolbar") : tr("unlockFailed");
      }
    });
    box.appendChild(row);
    if (hasGenerator) appendGeneratorOptions(box, field, true);
    positionBox();
    return;
  }

  if (logins.length) appendLoginRows(box, field, logins);
  if (hasGenerator) appendGeneratorOptions(box, field, logins.length > 0);
  positionBox(); // final height known now, flip above the field if below the fold
}

// host is or is a subdomain of an allowlisted domain. suffix match (not last-2-labels)
// so "clerk.accounts.dev" matches without ever matching a bare "accounts.dev"
function isAllowlistedLoginHost(host) {
  host = host.toLowerCase();
  return (globalThis.FAPASSWORD_IFRAME_LOGIN_HOSTS || []).some((d) => host === d || host.endsWith("." + d));
}

// in iframes (all_frames), offer only when same-origin with the top page or a known IdP/SSO/payment host
function frameIsSafe() {
  if (window === window.top) return true; // top frame always fine
  if (isAllowlistedLoginHost(location.hostname)) return true;
  try {
    return location.origin === window.top.location.origin;
  } catch {
    return false; // unknown cross-origin frame -> dont offer
  }
}

async function onFocusIn(e) {
  // Invalidates an older credential read that is still waiting for Touch ID.
  fillRequestSeq++;
  // focusin from inside a shadow root retargets e.target to the host, composedPath has the
  // real input
  const field = (e.composedPath ? e.composedPath()[0] : null) || e.target;
  // remember password fields before any show-password toggle flips them to text
  if (field instanceof HTMLInputElement && field.type === "password") everPassword.add(field);
  if (!(field instanceof HTMLInputElement) || !isLoginField(field)) {
    return;
  }
  // Programmatic focus is not consent to query even account names. Pointer/keyboard intent
  // is recorded before the resulting focus event; scripted focus on page load stays silent.
  if (Date.now() - lastUserInteractionAt > 1500) return;
  if (!frameIsSafe()) return; // skip unrelated cross-origin iframes
  // still offer on a site/browser pre-filled login field (apple/chrome do); only stay quiet if WE just filled it
  const v = (field.value || "").trim();
  if (v) {
    const justOurs =
      lastAutofill &&
      lastAutofill.host === location.hostname &&
      Date.now() - lastAutofill.at < 8000 &&
      (v === (lastAutofill.username || "") || autofilledFields.has(field));
    if (justOurs) {
      removeSuggestion();
      return;
    }
  }
  // neutral offer only - dont fetch logins or reveal anything yet. lock state checked
  // lazily on click so we dont hit the helper on every focus
  buildOfferSuggestion(field);
}

let lastUserInteractionAt = 0;
const recordUserInteraction = (event) => {
  if (event.isTrusted) lastUserInteractionAt = Date.now();
};
document.addEventListener("pointerdown", recordUserInteraction, true);
document.addEventListener("keydown", recordUserInteraction, true);
document.addEventListener("focusin", onFocusIn, true);
// arrow/Enter/Escape navigation for the dropdown. capture so we can intercept Enter before
// the page's own submit handling
document.addEventListener("keydown", onSuggestionKeydown, true);
// follow the field on scroll/resize. focusing auto-scrolls it into view, which previously
// fired this and killed the offer - the "click away then back and its gone" bug
document.addEventListener("scroll", positionBox, true);
window.addEventListener("resize", positionBox, true);
// Dismiss when the field blurs to anything outside the dropdown. Rows are pointer/keyboard
// driven; no secret input is ever rendered in page-owned DOM.
document.addEventListener(
  "focusout",
  (e) => {
    if (!suggestionEl || e.target !== anchorField) return;
    if (e.relatedTarget && suggestionEl.contains(e.relatedTarget)) return;
    removeSuggestion();
  },
  true,
);
document.addEventListener(
  "mousedown",
  (e) => {
    if (!suggestionEl) return;
    if (suggestionEl.contains(e.target)) return;
    if (e.target === anchorField) return;
    // clicking ANOTHER login field: dont close here, its own focusin rebuilds the offer.
    // closing now (mousedown before focusin) would race and leave it with no dropdown
    if (e.target instanceof HTMLInputElement && isLoginField(e.target)) return;
    removeSuggestion();
  },
  true,
);

// Offer submitted credentials to the native helper. A trusted submit event alone is not
// evidence of user intent: page script's form.requestSubmit() also produces one.
let lastSaveKey = "";
let lastSaveAt = 0;
let lastSaveIntent = null;

function hasUserActivation() {
  return navigator.userActivation ? navigator.userActivation.isActive : true;
}

function armSaveIntent(scope) {
  lastSaveIntent = { scope, at: Date.now() };
}

function consumeSaveIntent(scope) {
  const intent = lastSaveIntent;
  lastSaveIntent = null;
  if (!intent || Date.now() - intent.at > 3000) return false;
  return intent.scope === document || intent.scope === scope;
}

// treat a control as a submit if it is type=submit, or a button whose label reads like
// a sign-in / sign-up / save action (covers SPA logins with no real <form> submit)
const SUBMITY_LABEL =
  /\b(sign[\s-]?in|sign[\s-]?up|log[\s-]?in|register|create[\s-]?account|save|update|reset|confirm|activate|enroll|finish|proceed|verify|join|change[\s-]?password|continue|next|submit)\b/i;

// ids and names carry no word boundaries ("findpwd", "submit_btn", "loginBtn"), so match
// bare substrings there - a generic label like "OK" only signals via its id/name
const SUBMITY_ATTR = /pwd|passw|reset|submit|login|signin|confirm|continue|next|save/i;

function isSubmitControl(el) {
  if (!(el instanceof Element)) return false;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  if ((tag === "button" || tag === "input") && type === "submit") return true;
  const attrs = `${el.getAttribute("name") || ""} ${el.id || ""}`;
  if (tag === "button" && (type === "" || type === "button")) {
    return SUBMITY_LABEL.test((el.textContent || el.value || "") ?? "") || SUBMITY_ATTR.test(attrs);
  }
  // old-school pages (tplink) submit via <input type=button value="OK" id="findpwd">
  if (tag === "input" && type === "button") {
    return SUBMITY_LABEL.test(el.value || "") || SUBMITY_ATTR.test(attrs);
  }
  // SPA "buttons" that arent buttons: styled div/a with role=button (sling-style reset pages)
  if ((el.getAttribute("role") || "").toLowerCase() === "button" || tag === "a") {
    return SUBMITY_LABEL.test((el.textContent || attrBlob(el)) ?? "");
  }
  return false;
}

// pick the submitted credential: new password = last non-empty password field, username = login field before it
function collectSubmittedCredentials(scope) {
  const root = scope && scope.querySelectorAll ? scope : document;
  const inputs = Array.from(root.querySelectorAll("input"));
  // isPasswordish because a show-password toggle leaves the field type=text at submit
  const pws = inputs.filter((i) => isPasswordish(i) && i.value);
  if (!pws.length) return null;
  // new password = the value typed twice (new+confirm pair), else the new-password field,
  // else last. "last" alone saved the OLD password when current sat below new + confirm
  let password = pws[pws.length - 1].value;
  const counts = new Map();
  for (const p of pws) counts.set(p.value, (counts.get(p.value) || 0) + 1);
  const dup = [...counts.entries()].find(([, n]) => n >= 2);
  const marked = pws.find((p) => (p.getAttribute("autocomplete") || "").toLowerCase().includes("new-password"));
  if (dup) password = dup[0];
  else if (marked) password = marked.value;
  const firstPw = pws[0];
  // field sits before the (first) password in document order
  const before = (el) => el.compareDocumentPosition(firstPw) & Node.DOCUMENT_POSITION_FOLLOWING;

  // never let a password field or a password VALUE be the username. this is what saved
  // credentials with the password in the username slot on toggled reset forms
  const pwValues = new Set(pws.map((p) => p.value));
  const usable = (i) => !isPasswordish(i) && !pwValues.has(i.value.trim());

  // preferred: a real username/email field that precedes the password
  const strict = inputs.filter((i) => isUsernameField(i) && i.value && usable(i));
  const strictBefore = strict.filter(before);
  let userEl = strictBefore.length ? strictBefore[strictBefore.length - 1] : strict[0] || null;

  // fallback: no strict match (bare box, no autocomplete). nearest filled text/email/tel field
  // before the password is the username, but reject junk so a reset doesnt save "9" as the name
  if (!userEl) {
    const looksLikeUsername = (v) => {
      v = (v || "").trim();
      if (v.length < 3) return false;
      if (/^\d+$/.test(v) && v.length < 6) return false; // a short number is a code, not a name
      return true;
    };
    const guess = inputs.filter((i) => {
      if (!i.value || !usable(i)) return false;
      if (isOtpField(i) || isSearchOrComboField(i)) return false;
      const t = (i.type || "text").toLowerCase();
      if (!["text", "email", "tel", ""].includes(t)) return false;
      if (NONLOGIN_HINT.test(attrBlob(i))) return false;
      if (!looksLikeUsername(i.value)) return false;
      return before(i);
    });
    userEl = guess.length ? guess[guess.length - 1] : null;
  }

  // allPasswords: a change form's last field is often the current/old password, so the caller
  // can spot a generated value that isnt last
  return { username: (userEl?.value || "").trim(), password, allPasswords: pws.map((p) => p.value) };
}

function anchorPwField(root) {
  const scope = root && root.querySelectorAll ? root : document;
  const pws = Array.from(scope.querySelectorAll("input")).filter(isPasswordish);
  return pws.find(isVisible) || pws[0] || null;
}

// hand the submitted credential to the background to save; awaiting the lookup here lost the save on a redirect
async function maybeOfferSave(scope) {
  if (!frameIsSafe()) return;
  const cred = collectSubmittedCredentials(scope);
  if (!cred || !cred.password) return;

  // generated = our generated value is in any submitted field (change form's last field is often the old password)
  let generatedIndex = -1;
  if (
    lastGenerated &&
    lastGenerated.host === location.hostname &&
    Date.now() - lastGenerated.at < 600000
  ) {
    const digests = await Promise.all((cred.allPasswords || []).map(digestSecret));
    generatedIndex = digests.indexOf(await lastGenerated.passwordDigest);
  }
  const generated = generatedIndex >= 0;
  const savePassword = generated ? cred.allPasswords[generatedIndex] : cred.password;

  // a login we just autofilled unchanged is not a save (unless we generated a new password)
  if (
    !generated &&
    lastAutofill &&
    lastAutofill.host === location.hostname &&
    Date.now() - lastAutofill.at < 300000 &&
    (await lastAutofill.passwordDigest) === (await digestSecret(cred.password))
  ) {
    console.debug("[FAPassword] save skipped: recently autofilled");
    return;
  }

  // dedupe claimed synchronously ("shows up twice" fix); 15s covers the click+submit+Enter burst
  const key = await digestSecret(`${location.origin}\0${cred.username || savePassword}`);
  const now = Date.now();
  if (key === lastSaveKey && now - lastSaveAt < 15000) return;
  lastSaveKey = key;
  lastSaveAt = now;

  // create/change context vs a plain login (two+ password fields, new-password, or generated)
  const root = scope && scope.querySelectorAll ? scope : document;
  const pwInputs = Array.from(root.querySelectorAll("input")).filter(isPasswordish);
  const newPwCtx =
    generated ||
    (cred.allPasswords || []).length >= 2 ||
    pwInputs.some((p) => (p.getAttribute("autocomplete") || "").toLowerCase().includes("new-password"));

  // fire and forget - awaiting would let a navigating submit kill us; locked saves get stashed and flushed on unlock
  console.debug("[FAPassword] handing save to background", {
    host: location.hostname,
    user: cred.username || "(none)",
    generated,
    newPwCtx,
  });
  chrome.runtime
    .sendMessage({
      type: "resolveSave",
      username: cred.username,
      password: savePassword,
      generated,
      newPwCtx,
    })
    .catch(() => {});
}

document.addEventListener(
  "submit",
  (e) => {
    if (!e.isTrusted || !consumeSaveIntent(e.target)) return;
    removeSuggestion(); // the autofill dropdown must not outlive the submit
    maybeOfferSave(e.target);
  },
  true,
);
document.addEventListener(
  "pointerdown",
  (e) => {
    if (!e.isTrusted || !hasUserActivation() || !(e.target instanceof Element)) return;
    const ctrl = e.target.closest('button, input[type=submit], input[type=button], [role="button"], a');
    if (isSubmitControl(ctrl)) armSaveIntent(ctrl.form || document);
  },
  true,
);
// A real form is handled by submit. For a formless SPA control, click is the only signal.
document.addEventListener(
  "click",
  (e) => {
    if (!e.isTrusted || !hasUserActivation() || !(e.target instanceof Element)) return;
    const ctrl = e.target.closest('button, input[type=button], [role="button"], a');
    if (isSubmitControl(ctrl) && !ctrl.form) {
      consumeSaveIntent(document);
      maybeOfferSave(document);
    }
  },
  true,
);
// Enter inside a login field submits a form or activates a formless SPA login.
document.addEventListener(
  "keydown",
  (e) => {
    if (!e.isTrusted || !hasUserActivation() || !["Enter", " "].includes(e.key)) return;
    const t = e.target;
    if (t instanceof Element) {
      const ctrl = t.closest('button, input[type=submit], input[type=button], [role="button"], a');
      if (isSubmitControl(ctrl)) {
        armSaveIntent(ctrl.form || document);
        if (!ctrl.form) maybeOfferSave(document);
        return;
      }
    }
    if (t instanceof HTMLInputElement && (isPasswordField(t) || isUsernameField(t))) {
      armSaveIntent(t.form || document);
      if (!t.form) {
        removeSuggestion();
        maybeOfferSave(document);
      }
    }
  },
  true,
);
