// Credential access is tied to a document, a user action and immutable field references.
const tr = (name, substitutions) => chrome.i18n?.getMessage(name, substitutions) || name;
const F = globalThis.FAPASSWORD_FIELDS;
const { isFillable, isEditable, isExposed, isVisible, isLoginField, isPasswordish, isUsernameField,
  isNewPasswordField, scopeFor, classify, everPassword, attrBlob } = F;
// Content scripts also start on HTTP pages, where randomUUID may be absent.
// These opaque 128-bit IDs still use cryptographic randomness in every context.
function newRequestId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
const documentKey = newRequestId();
let documentActive = true;
let lastFocused = null;
let preparedFill = null;
let recentAutofill = null;
let generatedId = null;
const autofilledFields = new WeakSet();
const observedSubmissionRoots = new WeakSet();
function observeSubmissionRoot(element) {
  const root = element?.getRootNode?.();
  if (root instanceof ShadowRoot && !observedSubmissionRoots.has(root)) {
    observedSubmissionRoots.add(root);
    // Native submit events do not cross a shadow boundary.
    root.addEventListener("submit", onSubmit, true);
  }
}
const send = (message) => chrome.runtime.sendMessage({ ...message, documentKey });
const eventElement = (event) => event.composedPath?.()[0] || event.target;
const frameReady = () => send({ type: "frameReady" });
frameReady().catch(() => {});

function deepActiveElement() {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

function cancelFill() {
  const request = preparedFill;
  preparedFill = null;
  if (request) send({ type: "cancelFill", requestId: request.id }).catch(() => {});
}

function setValue(element, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

function prepareFill(anchor = lastFocused) {
  cancelFill();
  // Our own offer must not count as an obstruction of the target password field.
  removeSuggestion();
  if (!documentActive || document.visibilityState === "hidden") throw new Error("errorPageChanged");
  if (!anchor) {
    const context = { addressForms: new Map(), formPasswords: new Map(), visiblePasswords: new Map() };
    const candidates = classify(document).inputs.filter((field) => isLoginField(field, context) && isFillable(field));
    const scopes = new Set(candidates.map(scopeFor));
    if (scopes.size !== 1) throw new Error("errorChooseField");
    anchor = candidates[0];
  }
  if (!anchor?.isConnected || !isLoginField(anchor) || !isFillable(anchor)) throw new Error("errorChooseField");
  const scope = scopeFor(anchor);
  const fields = classify(scope);
  const users = fields.usernames.filter(isFillable);
  const passwords = fields.passwords.filter(isFillable);
  const password = isPasswordish(anchor) ? anchor :
    passwords.find((field) => /current-password/i.test(field.autocomplete)) || passwords[0];
  const username = isUsernameField(anchor) ? anchor : users.length === 1 ? users[0] : null;
  if (users.length > 1 && !username) throw new Error("errorChooseField");
  const snapshot = (field) => field ? { field, type: field.type, form: field.form, root: field.getRootNode() } : null;
  preparedFill = {
    id: newRequestId(), anchor, scope, at: Date.now(),
    username: snapshot(username), password: snapshot(password),
    stage: fields.passwords.length ? "password" : "username",
  };
  return { requestId: preparedFill.id, stage: preparedFill.stage };
}

function validTarget(target, request, kind) {
  if (!target || preparedFill !== request || !documentActive || Date.now() - request.at > 130000) return false;
  const { field } = target;
  return field.type === target.type && field.form === target.form && field.getRootNode() === target.root &&
    request.anchor.isConnected && (request.scope.contains(field) || field.form === request.scope) &&
    (kind === "password" ? isPasswordish(field) : isUsernameField(field)) && isFillable(field);
}

function fillCredentials(message) {
  const request = preparedFill;
  if (!request || request.id !== message.requestId || message.documentKey !== documentKey ||
      message.expectedOrigin !== location.origin || document.visibilityState === "hidden") {
    return { ok: false, filled: false, errorKey: "errorPageChanged" };
  }
  removeSuggestion();
  const fields = { username: false, password: false };
  if (message.username !== undefined && validTarget(request.username, request, "username")) {
    setValue(request.username.field, message.username);
    autofilledFields.add(request.username.field);
    fields.username = true;
  }
  // Page input/change handlers run synchronously above. Never reuse a previous visibility,
  // type, form or document decision when writing the password.
  if (message.password && validTarget(request.password, request, "password")) {
    setValue(request.password.field, message.password);
    everPassword.add(request.password.field);
    autofilledFields.add(request.password.field);
    fields.password = true;
  }
  const filled = request.stage === "username" ? fields.username :
    fields.password && (!request.username || fields.username);
  recentAutofill = { username: message.username, at: Date.now() };
  preparedFill = null;
  return { ok: filled, filled, fields, stage: request.stage, errorKey: filled ? undefined : "errorPartialFill" };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === "fill") { respond(fillCredentials(message)); return false; }
  if (message?.type === "saveStatus") {
    if (message.documentKey === documentKey && lastFocused?.isConnected) showStatus(lastFocused, tr(message.messageKey));
    respond({ ok: true }); return false;
  }
  if (!["describeFrame", "prepareFill"].includes(message?.type)) return false;
  (async () => {
    try {
      if (message.documentKey && message.documentKey !== documentKey) throw new Error("errorPageChanged");
      if (!documentActive || document.visibilityState === "hidden") throw new Error("errorPageChanged");
      await frameReady();
      const preparation = message.type === "prepareFill" ? prepareFill() : {};
      respond({ ok: true, documentKey, ...preparation });
    } catch (error) { respond({ ok: false, errorKey: error.message }); }
  })();
  return true;
});

let suggestionEl = null;
let suggestionRoot = null;
let suggestionBox = null;
let suggestionList = null;
let anchorField = null;
let navItems = [];
let navIndex = -1;
let offerSeq = 0;
let surfaceStyle = "";
let surfaceRect = null;
let hostObserver = null;
let positionFrame = 0;
let restoringFocus = false;

function removeSuggestion(restoreFocus = false) {
  const anchor = anchorField;
  const host = suggestionEl;
  hostObserver?.disconnect();
  hostObserver = null;
  // Removing a focused option can synchronously dispatch focusout. Clear ownership
  // first so that event cannot recursively remove the same host.
  suggestionEl = suggestionRoot = suggestionBox = suggestionList = anchorField = null;
  surfaceStyle = ""; surfaceRect = null;
  navItems = []; navIndex = -1;
  host?.remove();
  if (anchor) {
    const previous = anchorAria.get(anchor);
    if (previous) for (const [name, value] of Object.entries(previous)) {
      if (value == null) anchor.removeAttribute(name); else anchor.setAttribute(name, value);
    }
    anchorAria.delete(anchor);
  }
  if (restoreFocus && anchor?.isConnected) {
    restoringFocus = true;
    anchor.focus({ preventScroll: true });
    restoringFocus = false;
  }
}
const anchorAria = new WeakMap();

function setActiveNav(index) {
  navIndex = index;
  navItems.forEach((item, i) => {
    const active = i === index;
    item.el.style.background = active ? "light-dark(#202421, #f4f5f2)" : "transparent";
    item.el.style.color = active ? "light-dark(#f4f5f2, #101211)" : "inherit";
    item.el.setAttribute("aria-selected", String(active));
  });
  const row = navItems[index]?.el;
  if (row) {
    // Actual focus stays inside the same shadow tree as the options. No cross-root ARIA IDREF.
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
  }
}

function surfaceValid() {
  if (!suggestionEl || !anchorField || !surfaceRect || !document.hasFocus() ||
      suggestionEl.getAttribute("style") !== surfaceStyle || hostObserver?.takeRecords().length ||
      !suggestionEl.matches(":popover-open") || !isExposed(suggestionEl) || !isFillable(anchorField)) return false;
  const style = getComputedStyle(suggestionEl);
  const rect = suggestionEl.getBoundingClientRect();
  return Number(style.opacity) === 1 && style.transform === "none" && style.filter === "none" &&
    style.clipPath === "none" && Math.abs(rect.left - surfaceRect.left) < 2 &&
    Math.abs(rect.top - surfaceRect.top) < 2 && Math.abs(rect.width - surfaceRect.width) < 2;
}

function activate(index, event) {
  if (!event.isTrusted || !surfaceValid()) { removeSuggestion(); return; }
  const item = navItems[index];
  if (!item) return;
  if (event.type === "mousedown") {
    if (event.button !== 0) return;
    const hit = suggestionRoot.elementFromPoint(event.clientX, event.clientY);
    if (!hit || !(hit === item.el || item.el.contains(hit))) return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  item.onActivate();
}

function registerRow(row, onActivate) {
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", "false");
  row.tabIndex = -1;
  const index = navItems.length;
  navItems.push({ el: row, onActivate });
  row.addEventListener("mousedown", (event) => activate(index, event));
}

function onSuggestionKeydown(event) {
  if (!event.isTrusted || !suggestionEl) return;
  const element = eventElement(event);
  const inBox = document.activeElement === suggestionEl || suggestionRoot.activeElement;
  if (element !== anchorField && !inBox) return;
  if (event.key === "Escape") {
    removeSuggestion(true);
    event.preventDefault(); event.stopImmediatePropagation();
  } else if (["ArrowDown", "ArrowUp"].includes(event.key) && navItems.length) {
    if (!surfaceValid()) { removeSuggestion(); return; }
    const direction = event.key === "ArrowDown" ? 1 : -1;
    setActiveNav(navIndex < 0 ? (direction === 1 ? 0 : navItems.length - 1) :
      (navIndex + direction + navItems.length) % navItems.length);
    event.preventDefault(); event.stopImmediatePropagation();
  } else if (event.key === "Enter" && navIndex >= 0) activate(navIndex, event);
  else if (event.key === "Tab") removeSuggestion(true);
}

function positionBox() {
  positionFrame = 0;
  if (!suggestionEl || !anchorField) return;
  if ((surfaceStyle && suggestionEl.getAttribute("style") !== surfaceStyle) || !isVisible(anchorField)) {
    removeSuggestion(); return;
  }
  const rect = anchorField.getBoundingClientRect();
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
  const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
  if (rect.bottom <= top || rect.top >= top + height) { removeSuggestion(); return; }
  // Measure the full list, not its previously constrained height. The footer stays visible
  // while wheel, touch and keyboard scrolling reach every account without a scrollbar.
  const desiredHeight = suggestionList.scrollHeight + suggestionList.nextElementSibling.offsetHeight + 2;
  const spaceBelow = top + height - rect.bottom - 6;
  const spaceAbove = rect.top - top - 6;
  const above = spaceBelow < Math.min(Math.max(desiredHeight, 64), 180) && spaceAbove > spaceBelow;
  const maxHeight = Math.max(0, Math.min(300, above ? spaceAbove : spaceBelow));
  if (maxHeight < 64 || width < 60) { removeSuggestion(); return; }
  const boxHeight = Math.min(desiredHeight, maxHeight);
  const boxWidth = Math.max(40, Math.min(Math.max(rect.width, 200), width - 12));
  const x = Math.max(left + 6, Math.min(rect.left, left + width - boxWidth - 6));
  const y = Math.max(top + 6, above ? rect.top - boxHeight - 3 : rect.bottom + 3);
  suggestionBox.style.maxHeight = `${maxHeight}px`;
  for (const [name, value] of Object.entries({ left: `${x}px`, top: `${y}px`, width: `${boxWidth}px` })) {
    suggestionEl.style.setProperty(name, value, "important");
  }
  surfaceStyle = suggestionEl.getAttribute("style");
  surfaceRect = { left: x, top: y, width: boxWidth };
  hostObserver?.takeRecords();
}
function schedulePosition() {
  if (suggestionEl && !positionFrame) positionFrame = requestAnimationFrame(positionBox);
}

const UI_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
function buildSuggestionBox(field) {
  removeSuggestion();
  anchorField = field;
  const host = document.createElement("div");
  host.setAttribute("data-fapassword-host", "");
  host.setAttribute("popover", "manual");
  for (const [key, value] of Object.entries({ all: "initial", position: "fixed", margin: "0", padding: "0", border: "0",
    opacity: "1", transform: "none", filter: "none", "clip-path": "none", overflow: "visible", "z-index": "2147483647",
    "color-scheme": "light dark", "box-sizing": "border-box", "pointer-events": "auto", "writing-mode": "horizontal-tb" })) {
    host.style.setProperty(key, value, "important");
  }
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    [role="listbox"] { scrollbar-width: none; }
    [role="listbox"]::-webkit-scrollbar { display: none; width: 0; height: 0; }
    .account-fill:hover {
      color: light-dark(#f4f5f2, #101211) !important;
      border-color: light-dark(#202421, #f4f5f2) !important;
      background: light-dark(#202421, #f4f5f2) !important;
    }
  `;
  const card = document.createElement("div");
  Object.assign(card.style, { background: "light-dark(#f4f5f2, #070808)", color: "light-dark(#171a18, #f1f2ef)",
    colorScheme: "light dark", border: "1px solid light-dark(#aeb4af, #3a3d3b)", borderRadius: "2px",
    boxShadow: "0 14px 36px rgba(0,0,0,.30)", overflow: "hidden", display: "flex", flexDirection: "column",
    width: "100%", boxSizing: "border-box", font: `13px/1.4 ${UI_FONT}` });
  const box = document.createElement("div");
  box.setAttribute("role", "listbox");
  box.setAttribute("aria-label", tr("suggestionsLabel"));
  Object.assign(box.style, { overflowX: "hidden", overflowY: "auto", scrollbarWidth: "none",
    overscrollBehavior: "contain", minHeight: "0" });
  const footer = document.createElement("div");
  footer.textContent = "FAPassword";
  Object.assign(footer.style, { padding: "2px 8px", flexShrink: "0", textAlign: "right", fontSize: "10px", lineHeight: "1.2", fontWeight: "600",
    color: "light-dark(#59615b, #9ca19d)", background: "light-dark(#e8ebe6, #171a18)",
    borderTop: "1px solid light-dark(#aeb4af, #3a3d3b)",
    pointerEvents: "none", overflowWrap: "anywhere" });
  card.append(box, footer); shadow.append(style, card); document.documentElement.appendChild(host);
  suggestionEl = host; suggestionRoot = shadow; suggestionBox = card; suggestionList = box;
  host.showPopover();
  const previous = {};
  for (const name of ["aria-haspopup", "aria-expanded"]) previous[name] = field.getAttribute(name);
  anchorAria.set(field, previous);
  field.setAttribute("aria-haspopup", "listbox"); field.setAttribute("aria-expanded", "true");
  hostObserver = new MutationObserver(() => {
    if (suggestionEl === host && host.getAttribute("style") !== surfaceStyle) removeSuggestion();
  });
  hostObserver.observe(host, { attributes: true });
  positionBox();
  return suggestionEl === host ? box : null;
}

function appendRow(box, text, action) {
  const row = document.createElement("div");
  row.textContent = text;
  Object.assign(row.style, { padding: "9px 10px", cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden",
    textOverflow: "ellipsis", outlineOffset: "-2px" });
  registerRow(row, action); box.appendChild(row);
  return row;
}

function appendAccountRow(box, login, action) {
  const name = login.username || tr("noUsername");
  const row = appendRow(box, "", action);
  row.setAttribute("aria-label", name);
  Object.assign(row.style, { display: "flex", alignItems: "center", gap: "8px", minHeight: "36px",
    boxSizing: "border-box", padding: "4px 6px 4px 9px" });
  const username = document.createElement("span");
  username.textContent = name; username.title = name;
  Object.assign(username.style, { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", fontWeight: "520" });
  const fill = document.createElement("button");
  fill.type = "button"; fill.className = "account-fill"; fill.tabIndex = -1;
  fill.textContent = tr("fill"); fill.setAttribute("aria-label", tr("fillAccount", name));
  Object.assign(fill.style, { flexShrink: "0", minHeight: "25px", padding: "0 12px", boxSizing: "border-box",
    border: "1px solid light-dark(#aeb4af, #3a3d3b)", borderRadius: "2px", cursor: "pointer",
    color: "light-dark(#171a18, #f1f2ef)", background: "light-dark(#f4f5f2, #070808)",
    font: `650 11px/1.45 ${UI_FONT}`, letterSpacing: ".04em", boxShadow: "none" });
  // Button presses bubble to the row's trusted hit-test; keyboard selection uses
  // the same roving option focus. Do not add a second, unvalidated fill handler.
  row.append(username, fill);
  return row;
}

function showStatus(field, text, retry) {
  if (!field?.isConnected || !isVisible(field) || !documentActive) return;
  const box = buildSuggestionBox(field);
  if (!box) return;
  const status = document.createElement("p");
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  status.textContent = text; status.style.cssText = "margin:0;padding:9px 10px;overflow-wrap:anywhere";
  box.appendChild(status);
  if (retry) appendRow(box, tr("retry"), retry);
  else {
    suggestionEl.style.setProperty("pointer-events", "none", "important");
    surfaceStyle = suggestionEl.getAttribute("style");
  }
  positionBox();
}

async function fillLogin(field, login) {
  removeSuggestion(true);
  let preparation;
  try { preparation = prepareFill(field); }
  catch (error) { showStatus(field, tr(error.message)); return; }
  showStatus(field, tr("filling"));
  try {
    const response = await send({ type: "inlineFill", loginName: login, ...preparation });
    if (response?.ok && response.filled) removeSuggestion();
    else showStatus(field, tr(response?.errorKey || "fillFailed"), () => buildOfferSuggestion(field));
  } catch { showStatus(field, tr("errorConnection"), () => buildOfferSuggestion(field)); }
}

function fillGeneratedPassword(field, password) {
  removeSuggestion(true);
  if (!isNewPasswordField(field) || !isFillable(field)) return;
  const scope = scopeFor(field);
  const candidates = classify(scope).passwords.filter((input) => input === field ||
    (!input.value && isNewPasswordField(input) && !/current-password/i.test(input.autocomplete)));
  const targets = candidates.map((input) => ({ input, type: input.type, form: input.form }));
  generatedId = newRequestId();
  // The background records a digest; the content script retains only this opaque marker.
  send({ type: "rememberGenerated", generatedId, password }).catch(() => {});
  for (const target of targets) {
    const input = target.input;
    if (input.type !== target.type || input.form !== target.form || !input.isConnected ||
        scopeFor(input) !== scope || !isNewPasswordField(input) || !isFillable(input)) continue;
    setValue(input, password); everPassword.add(input);
  }
}

async function buildOfferSuggestion(field) {
  const seq = ++offerSeq;
  let result;
  try { result = await send({ type: "inlineLogins" }); } catch {}
  if (seq !== offerSeq || field !== deepActiveElement() || !isFillable(field)) return;
  const generator = isNewPasswordField(field);
  if (!result?.ok) { showStatus(field, tr(result?.errorKey || "errorConnection"), () => buildOfferSuggestion(field)); return; }
  const logins = result.locked ? [] : result.logins || [];
  if (!result.locked && !logins.length && !generator) return;
  const box = buildSuggestionBox(field);
  if (!box) return;
  if (result.locked) appendRow(box, tr("openToUnlock"), async () => {
    showStatus(field, tr("requestingCode"));
    const reply = await send({ type: "beginUnlock" }).catch(() => null);
    if (reply?.popupOpened) removeSuggestion();
    else showStatus(field, tr(reply?.challengeReady ? "codeReadyClickToolbar" : reply?.errorKey || "unlockFailed"));
  });
  for (const login of logins) appendAccountRow(box, login, () => fillLogin(field, login));
  if (generator) for (const option of [
    { label: tr("strongPassword"), value: globalThis.FAPASSWORD_PASSWORDS.appleStyle() },
    { label: tr("noSpecialCharacters"), value: globalThis.FAPASSWORD_PASSWORDS.alphanumeric() },
  ]) {
    const row = appendRow(box, option.label, () => fillGeneratedPassword(field, option.value));
    row.setAttribute("data-op-generate", "1");
    const preview = document.createElement("div"); preview.textContent = option.value;
    preview.style.cssText = "font:12px ui-monospace,monospace;margin-top:2px";
    row.appendChild(preview);
  }
  positionBox();
}

function frameIsSafe() {
  if (window === window.top) return true;
  const host = location.hostname.toLowerCase();
  if ((globalThis.FAPASSWORD_IFRAME_LOGIN_HOSTS || []).some((domain) => host === domain || host.endsWith("." + domain))) return true;
  try { return location.origin === window.top.location.origin; } catch { return false; }
}
let lastUserInteractionAt = 0;
function recordUserInteraction(event) { if (event.isTrusted) lastUserInteractionAt = Date.now(); }
document.addEventListener("pointerdown", recordUserInteraction, true);
document.addEventListener("keydown", recordUserInteraction, true);
document.addEventListener("keydown", onSuggestionKeydown, true);
document.addEventListener("input", (event) => {
  if (!event.isTrusted) return;
  // Typing chooses manual entry. Cancel a pending offer/fill with no field scan.
  offerSeq++;
  cancelFill();
  removeSuggestion();
}, true);
document.addEventListener("focusin", (event) => {
  if (restoringFocus || event.target === suggestionEl || suggestionEl?.contains(event.target)) return;
  const field = eventElement(event);
  if (preparedFill && field !== preparedFill.anchor) cancelFill();
  if (!(field instanceof HTMLInputElement)) return;
  if (field.type === "password") everPassword.add(field);
  if (!isLoginField(field) || Date.now() - lastUserInteractionAt > 1500 || !frameIsSafe()) return;
  lastFocused = field;
  observeSubmissionRoot(field);
  send({ type: "recordFocus" }).catch(() => {});
  if (field.value && recentAutofill && Date.now() - recentAutofill.at < 8000 &&
      (field.value === recentAutofill.username || autofilledFields.has(field))) { removeSuggestion(); return; }
  buildOfferSuggestion(field);
}, true);
document.addEventListener("focusout", (event) => {
  if (!suggestionEl) return;
  const next = event.relatedTarget;
  if (next === suggestionEl || suggestionRoot?.contains(next)) return;
  if (eventElement(event) === anchorField || event.target === suggestionEl) removeSuggestion();
}, true);
document.addEventListener("mousedown", (event) => {
  if (suggestionEl && event.target !== suggestionEl && !suggestionEl.contains(event.target) && eventElement(event) !== anchorField) removeSuggestion();
}, true);
document.addEventListener("scroll", schedulePosition, true);
window.addEventListener("resize", schedulePosition);
window.visualViewport?.addEventListener("resize", schedulePosition);
window.visualViewport?.addEventListener("scroll", schedulePosition);
window.addEventListener("pagehide", () => { documentActive = false; cancelFill(); removeSuggestion(); });
window.addEventListener("pageshow", () => { documentActive = true; frameReady().catch(() => {}); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { cancelFill(); removeSuggestion(); }
});

let lastSaveIntent = null;
const submitLabel = /\b(sign[\s-]?in|sign[\s-]?up|log[\s-]?in|register|create[\s-]?account|save|update|reset|confirm|activate|enroll|finish|proceed|verify|join|change[\s-]?password|continue|next|submit)\b|登录|登入|登錄|注册|註冊|保存|储存|儲存|更新|重置|确认|確認|提交|下一步|继续|繼續|ログイン|保存する/i;
function isSubmitControl(element) {
  if (!(element instanceof Element) || element.matches(":disabled")) return false;
  if ((element.tagName === "BUTTON" || element.tagName === "INPUT") && element.type === "submit") return true;
  return submitLabel.test(element.textContent || element.value || "") || /pwd|passw|reset|submit|login|signin|confirm|continue|next|save/i.test(`${element.id} ${element.getAttribute("name") || ""}`);
}
const controlFor = (event) => eventElement(event)?.closest?.('button, input[type=submit], input[type=button], [role="button"], a');
function armIntent(scope) { lastSaveIntent = { scope, at: Date.now(), id: newRequestId() }; }
function consumeIntent(scope) {
  const intent = lastSaveIntent; lastSaveIntent = null;
  return intent && intent.scope === scope && Date.now() - intent.at < 3000 ? intent : null;
}

function collectSubmittedCredentials(scope) {
  const fields = classify(scope);
  const eligiblePasswords = fields.passwords.filter(isEditable);
  const passwords = eligiblePasswords.filter((input) => input.value);
  if (!passwords.length) return null;
  const newPasswords = eligiblePasswords.filter(isNewPasswordField);
  if (newPasswords.length > 1 && new Set(newPasswords.map((input) => input.value)).size !== 1) {
    return { errorKey: "errorPasswordConfirmation" };
  }
  if (!newPasswords.length && passwords.length > 1) return { errorKey: "errorChooseField" };
  const passwordField = newPasswords[0] || passwords[0];
  const users = fields.usernames.filter((input) => input.value && isEditable(input) && input.value !== passwordField.value);
  if (users.length > 1) return { errorKey: "errorChooseField" };
  return { username: users[0]?.value || "", password: passwordField.value,
    newPwCtx: newPasswords.length > 0, generatedId, submissionId: newRequestId() };
}
function maybeOfferSave(scope, intent) {
  if (!frameIsSafe() || !intent) return;
  const credential = collectSubmittedCredentials(scope);
  if (!credential) return;
  if (credential.errorKey) { showStatus(lastFocused, tr(credential.errorKey)); return; }
  // No awaited work precedes this handoff. Navigation cannot interrupt a digest/query here.
  send({ type: "resolveSave", ...credential, submissionId: intent.id }).catch(() => {});
}
function onSubmit(event) {
  if (!event.isTrusted || event.defaultPrevented) return;
  const form = eventElement(event);
  const intent = consumeIntent(form);
  removeSuggestion();
  maybeOfferSave(form, intent);
}
document.addEventListener("submit", onSubmit, true);
document.addEventListener("pointerdown", (event) => {
  if (!event.isTrusted || event.button !== 0) return;
  const control = controlFor(event);
  if (isSubmitControl(control)) { observeSubmissionRoot(control); armIntent(control.form || scopeFor(control)); }
}, true);
document.addEventListener("click", (event) => {
  if (!event.isTrusted || event.defaultPrevented) return;
  const control = controlFor(event);
  if (isSubmitControl(control) && !control.form) {
    const scope = scopeFor(control);
    maybeOfferSave(scope, consumeIntent(scope));
  }
}, true);
document.addEventListener("keydown", (event) => {
  if (!event.isTrusted || event.defaultPrevented || !["Enter", " "].includes(event.key)) return;
  const control = controlFor(event);
  if (isSubmitControl(control)) { observeSubmissionRoot(control); armIntent(control.form || scopeFor(control)); return; }
  const field = eventElement(event);
  if (event.key !== "Enter" || !(field instanceof HTMLInputElement) || !isLoginField(field)) return;
  const scope = scopeFor(field);
  armIntent(scope);
  if (!field.form) { removeSuggestion(); maybeOfferSave(scope, consumeIntent(scope)); }
}, true);
