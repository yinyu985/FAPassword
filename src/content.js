// Credential access is tied to a document, a user action and immutable field references.
const tr = (name, substitutions) => chrome.i18n?.getMessage(name, substitutions) || name;
const F = globalThis.FAPASSWORD_FIELDS;
const { isFillable, isReadable, isExposed, isVisible, isLoginField, isPasswordish, isUsernameField,
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
const autofilledFields = new WeakSet();
const observedSubmissionRoots = new WeakSet();
const generatedNewFields = new WeakSet();
const generatedDrafts = new WeakMap();
const draftUpdateTimers = new WeakMap();
const saveSnapshots = new WeakMap();
let usernameContext = null;
const fieldShape = (input) => [input.tagName, input.type, input.id, input.name, input.autocomplete].join("\u0000");
function scopeDescriptor(scope) {
  return { scope, parent: scope.parentNode, previous: scope.previousSibling, next: scope.nextSibling,
    root: scope.getRootNode(), tagName: scope.tagName, inputs: classify(scope).inputs.map((input) => ({ input, shape: fieldShape(input) })) };
}
function replacementAtSlot(descriptor) {
  const { parent, previous, next, root } = descriptor;
  if (!parent?.isConnected || parent.getRootNode() !== root ||
      (previous && previous.parentNode !== parent) || (next && next.parentNode !== parent)) return null;
  const candidate = next ? next.previousSibling : parent.lastChild;
  return candidate instanceof Element && candidate.previousSibling === previous ? candidate : null;
}
function recoverSameScope(descriptor) {
  const scope = descriptor.scope.isConnected ? descriptor.scope : replacementAtSlot(descriptor);
  if (!scope || scope.tagName !== descriptor.tagName || scope.getRootNode() !== descriptor.root) return null;
  const inputs = classify(scope).inputs;
  if (inputs.length !== descriptor.inputs.length || inputs.some((input, index) => fieldShape(input) !== descriptor.inputs[index].shape)) return null;
  descriptor.inputs.forEach(({ input }, index) => {
    if (generatedNewFields.has(input) && isReadable(inputs[index])) generatedNewFields.add(inputs[index]);
  });
  return scope;
}
function rememberUsernameContext(username, scope, allowNext = false) {
  usernameContext = { username, scope, at: Date.now(), allowNext, descriptor: scopeDescriptor(scope) };
}
function observeSubmissionRoot(element) {
  const root = element?.getRootNode?.();
  if (root instanceof ShadowRoot && !observedSubmissionRoots.has(root)) {
    observedSubmissionRoots.add(root);
    // Native submit events do not cross a shadow boundary.
    root.addEventListener("submit", onSubmit, true);
    root.addEventListener("reset", onReset, true);
    root.addEventListener("formdata", onFormData, true);
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
  if (fields.username) rememberUsernameContext(message.username, request.scope, request.stage === "username");
  preparedFill = null;
  return { ok: filled, filled, fields, stage: request.stage, errorKey: filled ? undefined : "errorPartialFill" };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === "fill") { respond(fillCredentials(message)); return false; }
  if (message?.type === "saveStatus") {
    // A recovery draft belongs in the toolbar, not in a popover covering the
    // site's Register button immediately after generating a password.
    if (message.messageKey === "saveReview") { respond({ ok: true }); return false; }
    if (message.documentKey === documentKey && lastFocused?.isConnected) {
      const unlock = ["saveWaitingUnlock", "saveNoAccount", "saveReview", "saveFailed", "saveUncertain"].includes(message.messageKey) ? () => requestUnlock(lastFocused) : null;
      showStatus(lastFocused, tr(message.messageKey), unlock,
        ["saveFailed", "saveUncertain", "saveExpired", "saveNoAccount"].includes(message.messageKey), tr("openToUnlock"));
    }
    else if (message.documentKey === documentKey && ["saveFailed", "saveUncertain", "saveExpired", "saveNoAccount"].includes(message.messageKey)) {
      notifySaveFailure(message.messageKey);
    }
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
  if (event.type === "click") rowPressAt = 0;
  if (!event.isTrusted || !surfaceValid()) { removeSuggestion(); return; }
  const item = navItems[index];
  if (!item) return;
  if (event.type === "click") {
    if (event.button !== 0) return;
    const hit = suggestionRoot.elementFromPoint(event.clientX, event.clientY);
    if (!hit || !(hit === item.el || item.el.contains(hit))) return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  item.onActivate();
}

// Keep the offer in place through mouseup/click. Acting on mousedown removes it
// early enough for the browser's click to land on a page control underneath.
let rowPressAt = 0;
function registerRow(row, onActivate) {
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", "false");
  row.tabIndex = -1;
  const index = navItems.length;
  navItems.push({ el: row, onActivate });
  row.addEventListener("mousedown", (event) => {
    if (!event.isTrusted || event.button !== 0) return;
    rowPressAt = Date.now();
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!surfaceValid()) { removeSuggestion(); return; }
    const hit = suggestionRoot.elementFromPoint(event.clientX, event.clientY);
    if (!hit || !(hit === row || row.contains(hit))) removeSuggestion();
  });
  row.addEventListener("click", (event) => activate(index, event));
}

// A focus/layout change can still tear down the offer between press and click.
// Consume that one click before the page underneath can act on it.
document.addEventListener("click", (event) => {
  if (!rowPressAt || Date.now() - rowPressAt > 700) return;
  if (suggestionEl && (event.target === suggestionEl || suggestionEl.contains(event.target))) return;
  rowPressAt = 0;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

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

const UI_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif';
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

function showStatus(field, text, retry, failed = false, actionLabel = tr("retry")) {
  if (!field?.isConnected || !isVisible(field) || !documentActive) return;
  const box = buildSuggestionBox(field);
  if (!box) return;
  const status = document.createElement("p");
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  status.textContent = text; status.style.cssText = `margin:0;padding:8px 0;font:650 12px/1.45 ${UI_FONT};overflow-wrap:anywhere;color:${failed ? "light-dark(#a2342f, #f19a94)" : "light-dark(#171a18, #f1f2ef)"}`;
  box.style.padding = "0 10px";
  box.appendChild(status);
  if (retry) appendRow(box, actionLabel, retry);
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
  catch (error) { showStatus(field, tr(error.message), null, true); return; }
  showStatus(field, tr("filling"));
  try {
    const response = await send({ type: "inlineFill", loginName: login, ...preparation });
    if (response?.ok && response.filled) removeSuggestion();
    else showStatus(field, tr(response?.errorKey || "fillFailed"), () => buildOfferSuggestion(field), true);
  } catch { showStatus(field, tr("errorConnection"), () => buildOfferSuggestion(field), true); }
}

async function requestUnlock(field) {
  showStatus(field, tr("requestingCode"));
  const reply = await send({ type: "beginUnlock" }).catch(() => null);
  if (reply?.popupOpened) removeSuggestion();
  else showStatus(field, tr(reply?.challengeReady ? "codeReadyClickToolbar" : reply?.errorKey || "unlockFailed"), null, !reply?.challengeReady);
}

function fillGeneratedPassword(field, password) {
  removeSuggestion(true);
  if (!isNewPasswordField(field) || !isFillable(field)) return;
  const scope = scopeFor(field);
  const descriptor = scopeDescriptor(scope);
  const candidates = classify(scope).passwords.filter((input) => input === field ||
    (!input.value && isNewPasswordField(input) && !/current-password/i.test(input.autocomplete)));
  const targets = candidates.map((input) => ({ input, type: input.type, form: input.form }));
  for (const target of targets) {
    const input = target.input;
    if (input.type !== target.type || input.form !== target.form || !input.isConnected ||
        scopeFor(input) !== scope || !isNewPasswordField(input) || !isFillable(input)) continue;
    setValue(input, password); everPassword.add(input);
    generatedNewFields.add(input);
  }
  // A generated password has an explicit recovery path even if a custom page's
  // submission cannot be observed. This draft never auto-sends to Apple.
  const currentScope = recoverSameScope(descriptor);
  if (!currentScope) { notifySaveFailure("errorPageChanged"); return; }
  const generatedTarget = classify(currentScope).inputs[descriptor.inputs.findIndex(({ input }) => input === field)];
  if (!generatedTarget || !isReadable(generatedTarget) || !isExposed(generatedTarget) || !generatedTarget.value) {
    notifySaveFailure("errorPageChanged"); return;
  }
  const draftId = generatedDrafts.get(scope) || newRequestId();
  generatedDrafts.set(currentScope, draftId);
  const credential = collectSubmittedCredentials(currentScope);
  if (credential?.password) send({ type: "resolveSave", ...credential, review: true,
    submissionId: newRequestId(), draftId }).then((reply) => {
      if (!reply?.ok) notifySaveFailure(reply?.errorKey || "saveFailed");
    }).catch(() => notifySaveFailure("saveFailed"));
  rememberSaveSnapshot(currentScope);
}

async function buildOfferSuggestion(field) {
  const seq = ++offerSeq;
  let result;
  try { result = await send({ type: "inlineLogins" }); } catch {}
  if (seq !== offerSeq || field !== deepActiveElement() || !isFillable(field)) return;
  const generator = isNewPasswordField(field);
  if (!result?.ok) { showStatus(field, tr(result?.errorKey || "errorConnection"), () => buildOfferSuggestion(field), true); return; }
  const logins = result.locked ? [] : result.logins || [];
  if (!result.locked && !logins.length && !generator) return;
  const box = buildSuggestionBox(field);
  if (!box) return;
  if (result.locked) appendRow(box, tr("openToUnlock"), () => requestUnlock(field));
  for (const login of logins) appendAccountRow(box, login, () => fillLogin(field, login));
  if (generator) for (const option of [
    { label: tr("strongPassword"), value: globalThis.FAPASSWORD_PASSWORDS.custom() },
    { label: tr("includeSpecialCharacters"), value: globalThis.FAPASSWORD_PASSWORDS.custom(16, true) },
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
window.addEventListener("pagehide", () => {
  const intent = lastSaveIntent;
  if (intent && Date.now() - intent.at < SAVE_INTENT_TTL && (intent.submitted ||
    (intent.strong && intent.activated && intent.validBefore && intent.activationEvent?.type === "click" &&
      !intent.activationEvent.defaultPrevented && Date.now() - intent.at < 150))) {
    if (!intent.submitted && !intent.resetObserved) intent.snapshot = collectSubmittedCredentials(intent.scope) || intent.snapshot;
    finishSaveIntent(intent);
  }
  clearSaveIntent();
  documentActive = false; usernameContext = null; cancelFill(); removeSuggestion();
});
window.addEventListener("pageshow", () => { documentActive = true; frameReady().catch(() => {}); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { cancelFill(); removeSuggestion(); }
});

let lastSaveIntent = null;
const SAVE_INTENT_TTL = 3000;
// Next/Continue and arbitrary links are not evidence of credential submission.
const submitLabel = /\b(sign[\s-]?in|sign[\s-]?up|log[\s-]?in|register|create[\s-]?account|(?:save|update|reset|change)[\s-]?(?:password|credentials?))\b|登录|登入|登錄|注册|註冊|(?:保存|储存|儲存|更新|重置|修改)(?:密码|密碼|凭据|憑據)|ログイン/i;
const controlLabel = (element) => `${element?.textContent || element?.value || ""} ${element?.getAttribute?.("aria-label") || ""}`;
const isNextControl = (element) => /\b(next|continue)\b|下一步|继续|繼續/i.test(controlLabel(element));
const isCancelControl = (element) => /\b(cancel|abort|back|forgot|delete)\b|取消|返回|忘记|忘記|删除|刪除/i.test(controlLabel(element));
function isSubmitControl(element) {
  if (!(element instanceof Element) || element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") return false;
  if (isCancelControl(element) || isNextControl(element)) return false;
  if ((element.tagName === "BUTTON" || element.tagName === "INPUT") && element.type === "submit") return true;
  return submitLabel.test(controlLabel(element)) ||
    /(?:^|[\s_-])(?:login|signin|signup|register|savepassword|updatepassword|resetpassword)(?:$|[\s_-])/i.test(`${element.id} ${element.getAttribute("name") || ""}`);
}
const controlFor = (event) => eventElement(event)?.closest?.('button, input[type=submit], input[type=button], [role="button"]');
const submissionScope = (control) => control.form || control.closest("form") || scopeFor(control);
const invalidSubmission = (scope, control) => scope.tagName === "FORM" && !scope.noValidate &&
  !control?.formNoValidate && scope.matches(":invalid");
function armIntent(scope, control) {
  clearSaveIntent();
  const current = collectSubmittedCredentials(scope);
  const cached = saveSnapshots.get(scope);
  const snapshot = current?.password ? current : cached && Date.now() - cached.at < 3000 ? cached.credential : null;
  lastSaveIntent = { scope, control, snapshot, at: Date.now(), id: newRequestId(),
    strong: !!control && isSubmitControl(control), validBefore: !invalidSubmission(scope, control) &&
      !Array.from(scope.querySelectorAll('[aria-invalid="true"]')).some(isVisible),
    descriptor: scopeDescriptor(scope), passwords: classify(scope).passwords.filter(isReadable) };
  const intent = lastSaveIntent;
  intent.timer = setTimeout(() => clearSaveIntent(intent), SAVE_INTENT_TTL);
  intent.observer = new MutationObserver(() => {
    if (intent.activated && intent.strong && credentialsRemoved(intent)) finishSaveIntent(intent);
  });
  intent.observer.observe(scope.getRootNode(), { childList: true, subtree: true });
  return lastSaveIntent;
}
function clearSaveIntent(intent = lastSaveIntent) {
  if (!intent) return;
  clearTimeout(intent.timer); intent.observer?.disconnect();
  if (lastSaveIntent === intent) lastSaveIntent = null;
}
function credentialsRemoved(intent) {
  if (!intent.passwords.length || intent.passwords.some((input) => input.isConnected && scopeFor(input) === intent.scope)) return false;
  const currentScope = intent.scope.isConnected ? intent.scope : replacementAtSlot(intent.descriptor);
  // Replacing credential inputs with other credential inputs is a rerender, not
  // evidence that the page completed login/registration.
  return !currentScope || !classify(currentScope).passwords.length;
}
function rememberSaveSnapshot(scope) {
  const credential = collectSubmittedCredentials(scope);
  if (credential?.password || credential?.errorKey) saveSnapshots.set(scope, { credential, at: Date.now() });
}
function rememberUsername(scope, allowNext = false) {
  const fields = classify(scope);
  if (fields.passwords.length) return;
  const users = fields.usernames.filter((input) => input.value && isVisible(input) && !input.disabled);
  if (users.length === 1) rememberUsernameContext(users[0].value, scope, allowNext);
}

function collectSubmittedCredentials(scope) {
  const fields = classify(scope);
  const eligiblePasswords = fields.passwords.filter(isReadable);
  const passwords = eligiblePasswords.filter((input) => input.value);
  if (!passwords.length) return null;
  const isNew = (input) => generatedNewFields.has(input) || isNewPasswordField(input);
  const newPasswords = eligiblePasswords.filter(isNew);
  let errorKey;
  if (newPasswords.length > 1 && new Set(newPasswords.map((input) => input.value)).size !== 1) errorKey = "errorPasswordConfirmation";
  if (!newPasswords.length && passwords.length > 1) errorKey = "errorChooseField";
  const passwordField = newPasswords[0] || passwords[0];
  if (!passwordField.value) errorKey = "errorPasswordConfirmation";
  // A third password in an old/new/confirm form cannot be silently ignored.
  const unexplained = passwords.filter((input) => input !== passwordField && !isNew(input) &&
    !/current-password/i.test(input.autocomplete) && !/\b(old|current)[\s_-]*(?:pass|pwd)|旧密码|舊密碼|当前密码/i.test(attrBlob(input)));
  if (newPasswords.length && unexplained.some((input) => input.value !== passwordField.value)) {
    errorKey = "errorPasswordConfirmation";
  }
  const saveKind = newPasswords.length ?
    (eligiblePasswords.some((input) => !isNew(input) && (/current-password/i.test(input.autocomplete) ||
      /\b(old|current)[\s_-]*(?:pass|pwd)|旧密码|舊密碼|当前密码/i.test(attrBlob(input)))) ? "change" : "new") : "login";
  // Reading a visible, readonly account is safe; writing to it is still forbidden.
  const users = fields.usernames.filter((input) => input !== passwordField && input.value && isReadable(input));
  const contextMatches = usernameContext && (usernameContext.scope === scope ||
    (usernameContext.allowNext && !usernameContext.scope.isConnected && replacementAtSlot(usernameContext.descriptor) === scope));
  const hiddenIdentity = fields.inputs.some((input) => input.type === "hidden" &&
    /(?:^|[\s_-])(?:username|user|account|email|login)(?:$|[\s_-])/i.test(attrBlob(input)));
  const contextual = !fields.usernames.length && !hiddenIdentity && contextMatches && Date.now() - usernameContext.at < 300000 ? usernameContext.username : "";
  return { username: users.length === 1 ? users[0].value : users.length > 1 ? "" : contextual,
    password: passwordField.value, saveKind, newPwCtx: newPasswords.length > 0,
    needsAccount: users.length > 1, ...(errorKey ? { errorKey } : {}) };
}
let saveFailureHost = null;
function notifySaveFailure(messageKey) {
  if (lastFocused?.isConnected && isVisible(lastFocused)) {
    showStatus(lastFocused, tr(messageKey), () => send({ type: "beginUnlock" }).catch(() => {}), true, tr("openToUnlock"));
    return;
  }
  saveFailureHost?.remove();
  const host = document.createElement("div");
  host.setAttribute("data-fapassword-notice", "");
  host.style.cssText = "position:fixed!important;right:16px!important;bottom:16px!important;z-index:2147483647!important";
  const root = host.attachShadow({ mode: "closed" });
  const notice = document.createElement("div"); notice.setAttribute("role", "alert");
  notice.style.cssText = "background:#fff;color:#b42318;border:1px solid #ddd;border-radius:8px;padding:12px;max-width:360px;font:13px/1.5 system-ui;box-shadow:0 2px 12px #0003";
  notice.textContent = tr(messageKey);
  const close = document.createElement("button"); close.textContent = tr("dismiss");
  close.addEventListener("click", () => host.remove()); notice.appendChild(close); root.appendChild(notice);
  (document.body || document.documentElement).appendChild(host); saveFailureHost = host;
}
function reportSaveProblem(key, intent) {
  notifySaveFailure(key);
  send({ type: "saveNotice", messageKey: key, submissionId: intent.id }).catch(() => {});
}
function finishSaveIntent(intent) {
  if (!frameIsSafe() || !intent || intent.sent || Date.now() - intent.at > SAVE_INTENT_TTL) return;
  // Native constraint validation already succeeded before the trusted submit.
  // Rechecking after its handler reset the form validates a different state.
  if ((!intent.submitted && !intent.validBefore) || (intent.scope.isConnected &&
      Array.from(intent.scope.querySelectorAll('[aria-invalid="true"]')).some(isVisible))) return;
  const credential = intent.formDataCredential || intent.submitCredential || intent.snapshot;
  if (!credential) return;
  if (credential.errorKey) { intent.sent = true; reportSaveProblem(credential.errorKey, intent); return; }
  intent.sent = true;
  clearSaveIntent(intent);
  usernameContext = null;
  send({ type: "resolveSave", ...credential, submissionId: intent.id, draftId: generatedDrafts.get(intent.scope)}).then((reply) => {
    if (!reply?.ok) { intent.sent = false; reportSaveProblem(reply?.errorKey || "saveFailed", intent); }
  }).catch(() => { intent.sent = false; reportSaveProblem("saveFailed", intent); });
}
function scheduleSaveIntent(intent, event) {
  intent.activeEvent = event;
  setTimeout(() => {
    if (lastSaveIntent !== intent || intent.sent) return;
    if (!intent.submitted && !intent.resetObserved && intent.scope.isConnected) {
      intent.snapshot = collectSubmittedCredentials(intent.scope) || intent.snapshot;
    }
    if (intent.submitted || (intent.strong && intent.activated && credentialsRemoved(intent))) finishSaveIntent(intent);
    intent.activeEvent = null;
  }, 0);
}
function onSubmit(event) {
  if (!event.isTrusted) return;
  const form = eventElement(event);
  const intent = lastSaveIntent;
  if (!intent || intent.scope !== form || Date.now() - intent.at > SAVE_INTENT_TTL) return;
  if (event.submitter && (isNextControl(event.submitter) || isCancelControl(event.submitter))) {
    if (isNextControl(event.submitter)) rememberUsername(form, true);
    else usernameContext = null;
    clearSaveIntent(intent); return;
  }
  rememberUsername(form, true);
  // Click handlers have completed, but submit handlers have not yet cleared or
  // reset these fields. Never replace this boundary snapshot with reset defaults.
  intent.submitCredential = collectSubmittedCredentials(form) || intent.snapshot;
  intent.submitted = true;
  removeSuggestion();
  scheduleSaveIntent(intent, event);
}
document.addEventListener("submit", onSubmit, true);
function onReset(event) {
  const intent = lastSaveIntent;
  if (!event.isTrusted || !intent || eventElement(event) !== intent.scope || intent.sent) return;
  intent.snapshot = collectSubmittedCredentials(intent.scope) || intent.snapshot;
  intent.resetObserved = true;
}
function onFormData(event) {
  const intent = lastSaveIntent;
  if (!event.isTrusted || !intent || eventElement(event) !== intent.scope || intent.sent) return;
  const credential = collectSubmittedCredentials(intent.scope) || intent.submitCredential || intent.snapshot;
  if (!credential || credential.errorKey) return;
  const fields = classify(intent.scope);
  const passwords = fields.passwords.filter(isReadable);
  const password = passwords.find((input) => generatedNewFields.has(input) || isNewPasswordField(input)) || passwords[0];
  const values = password?.name ? event.formData.getAll(password.name) : [];
  if (values.length !== 1 || typeof values[0] !== "string") return;
  const users = fields.usernames.filter((input) => input.value && isReadable(input));
  const usernames = users.length === 1 && users[0].name ? event.formData.getAll(users[0].name) : [];
  intent.formDataCredential = { ...credential, password: values[0],
    ...(usernames.length === 1 && typeof usernames[0] === "string" ? { username: usernames[0] } : {}) };
}
document.addEventListener("reset", onReset, true);
document.addEventListener("formdata", onFormData, true);
document.addEventListener("input", (event) => {
  const field = eventElement(event);
  if (!event.isTrusted || !(field instanceof HTMLInputElement) || !isLoginField(field)) return;
  observeSubmissionRoot(field);
  const scope = scopeFor(field);
  const draftId = generatedDrafts.get(scope);
  const descriptor = scopeDescriptor(scope);
  clearTimeout(draftUpdateTimers.get(scope));
  draftUpdateTimers.set(scope, setTimeout(() => {
    const currentScope = recoverSameScope(descriptor);
    if (!currentScope) {
      if (draftId) send({ type: "updateSaveDraft", draftId, credential: { errorKey: "errorChooseField" } }).catch(() => notifySaveFailure("saveFailed"));
      return;
    }
    rememberSaveSnapshot(currentScope);
    if (!draftId) return;
    generatedDrafts.set(currentScope, draftId);
    const credential = collectSubmittedCredentials(currentScope);
    send({ type: "updateSaveDraft", draftId, credential }).then((reply) => {
      if (!reply?.ok) notifySaveFailure(reply?.errorKey || "saveFailed");
    }).catch(() => notifySaveFailure("saveFailed"));
  }, 0));
}, true);
document.addEventListener("pointerdown", (event) => {
  if (!event.isTrusted || event.button !== 0) return;
  clearSaveIntent();
  const control = controlFor(event);
  if (isCancelControl(control)) usernameContext = null;
  if (control && (isSubmitControl(control) || isNextControl(control))) rememberUsername(submissionScope(control), true);
  if (isSubmitControl(control)) {
    observeSubmissionRoot(control);
    // Some sites complete their custom action on pointerdown and remove the
    // button before a click can occur. Removal is still required as evidence.
    armIntent(submissionScope(control), control).activated = true;
  }
}, true);
document.addEventListener("click", (event) => {
  if (!event.isTrusted || event.button !== 0) return;
  const control = controlFor(event);
  if (isCancelControl(control)) { usernameContext = null; clearSaveIntent(); return; }
  if (control && isNextControl(control)) { rememberUsername(submissionScope(control), true); clearSaveIntent(); return; }
  if (!isSubmitControl(control)) return;
  const scope = submissionScope(control);
  rememberUsername(scope, true);
  const intent = lastSaveIntent?.scope === scope && Date.now() - lastSaveIntent.at < SAVE_INTENT_TTL ? lastSaveIntent : armIntent(scope, control);
  intent.strong = true;
  intent.activated = true;
  intent.activationEvent = event;
  removeSuggestion();
  // Native controls must actually submit. Do not save just because their click
  // was cancelled, or Enter did not cause implicit submission.
  scheduleSaveIntent(intent, event);
}, true);
document.addEventListener("keydown", (event) => {
  if (!event.isTrusted || event.defaultPrevented || event.isComposing || event.keyCode === 229 || !["Enter", " "].includes(event.key)) return;
  const control = controlFor(event);
  if (isCancelControl(control)) { usernameContext = null; clearSaveIntent(); return; }
  if (control && isNextControl(control)) { rememberUsername(submissionScope(control), true); clearSaveIntent(); return; }
  if (isSubmitControl(control)) {
    const scope = submissionScope(control);
    rememberUsername(scope, true);
    observeSubmissionRoot(control); const intent = armIntent(scope, control);
    if (control.getAttribute("role") === "button" && control.tagName !== "BUTTON") { intent.activated = true; scheduleSaveIntent(intent, event); }
    return;
  }
  const field = eventElement(event);
  if (event.key !== "Enter" || !(field instanceof HTMLInputElement) || !isLoginField(field)) return;
  const scope = scopeFor(field);
  observeSubmissionRoot(field); rememberUsername(scope, true);
  const intent = armIntent(scope);
  // A password-only Enter handler that removes its form is an observable SPA
  // transition. Composing Enter and unchanged forms remain excluded.
  intent.strong = true;
  intent.activated = true;
  scheduleSaveIntent(intent, event);
  // The browser or application must subsequently dispatch a trusted submit.
}, true);
