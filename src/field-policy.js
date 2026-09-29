(() => {
  const otpAutocomplete = /one-time-code/i;
  const otpHint = /\b(otp|one[\s-]?time|verification|2fa|mfa|sms[\s-]?code|auth[\s-]?code|security[\s-]?code|passcode)\b|验证码|驗證碼|动态码|動態碼|認証コード/i;
  const nonLoginHint =
    /\b(search|find|filter|query|lookup|tag|tags|mention|comment|reply|message|chat|post|caption|note|subject|topic|recipient|address|street|city|state|zip|postal|country|first[\s-]?name|last[\s-]?name|full[\s-]?name|company|title|url|website|coupon|promo|voucher|gift[\s-]?card|amount|quantity|qty|price|card[\s-]?number|cvv|cvc|expiry|account[\s-]?(?:number|no|holder)|routing|iban|invoice|order|tracking|keyword)\b/i;
  const loginContextHint = /log[\s_-]?in|sign[\s_-]?in|auth|session|sso|oauth|account|idp|passport/i;
  const everPassword = new WeakSet();

  function attrBlob(element) {
    let labelText = "";
    try {
      if (element.labels?.length) labelText = Array.from(element.labels, (label) => label.textContent).join(" ");
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        labelText += " " + labelledBy.split(/\s+/).map((id) => element.ownerDocument.getElementById(id)?.textContent || "").join(" ");
      }
    } catch {}
    return [
      element.name,
      element.id,
      element.getAttribute("aria-label"),
      element.placeholder,
      element.getAttribute("autocomplete"),
      labelText,
    ].filter(Boolean).join(" ");
  }

  function isOtpField(element) {
    if (otpAutocomplete.test(element.getAttribute("autocomplete") || "")) return true;
    const max = Number.parseInt(element.getAttribute("maxlength") || "0", 10);
    if (element.inputMode === "numeric" && max === 1) return true;
    return otpHint.test(attrBlob(element));
  }

  const isPasswordField = (element) => element instanceof HTMLInputElement && element.type === "password" && !isOtpField(element);

  function isPasswordish(element) {
    if (!(element instanceof HTMLInputElement) || isOtpField(element)) return false;
    if (element.type === "password") return true;
    if (!["text", ""].includes((element.type || "text").toLowerCase())) return false;
    if (everPassword.has(element)) return true;
    if ((element.getAttribute("autocomplete") || "").toLowerCase().includes("password")) return true;
    return /passw|pwd|密码|密碼|パスワード/i.test(attrBlob(element));
  }

  function isSearchOrComboField(element) {
    const role = (element.getAttribute("role") || "").toLowerCase();
    if (role === "searchbox" || role === "combobox") return true;
    if ((element.type || "").toLowerCase() === "search") return true;
    if ((element.getAttribute("enterkeyhint") || "").toLowerCase() === "search") return true;
    return ["list", "both", "inline"].includes((element.getAttribute("aria-autocomplete") || "").toLowerCase());
  }

  function parentElement(element) {
    return element.parentElement || element.getRootNode?.()?.host || null;
  }

  function isVisible(element) {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    let opacity = 1;
    for (let node = element; node; node = parentElement(node)) {
      const style = (node.ownerDocument?.defaultView || window).getComputedStyle?.(node) || getComputedStyle(node);
      opacity *= Number.parseFloat(style.opacity || "1");
      if (style.visibility === "hidden" || style.visibility === "collapse" || style.display === "none" ||
          style.contentVisibility === "hidden" || opacity < 0.1 || node.inert ||
          /inset\(100%|circle\(0(?:px|%)?(?:\s|\))|ellipse\(0(?:px|%)?\s+0(?:px|%)?(?:\s|\))/.test(style.clipPath || "") ||
          /opacity\(0(?:%|\.0*)?\)/.test(style.filter || "")) return false;
    }
    return true;
  }

  // Hit-testing includes clipping, covering elements and open/known shadow roots.
  // The viewport centre and enough of the field must actually be exposed.
  function isExposed(element) {
    if (!isVisible(element)) return false;
    const doc = element.ownerDocument || document;
    const view = doc.defaultView || window;
    const rect = element.getBoundingClientRect();
    const width = view.innerWidth || doc.documentElement.clientWidth;
    const height = view.innerHeight || doc.documentElement.clientHeight;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const root = element.getRootNode?.();
    const hit = (px, py) => {
      let top = doc.elementFromPoint(px, py);
      while (top && top !== element && !element.contains(top)) {
        const shadow = top.shadowRoot || (root?.host === top ? root : null);
        if (!shadow?.elementFromPoint) break;
        const next = shadow.elementFromPoint(px, py);
        if (next === top) break;
        top = next;
      }
      return top === element || !!(top && element.contains(top));
    };
    if (!hit(x, y)) return false;
    const dx = Math.max(1, rect.width / 2 - 3), dy = Math.max(1, rect.height / 2 - 3);
    if ([[x-dx,y-dy],[x+dx,y-dy],[x-dx,y+dy],[x+dx,y+dy]].filter(([px,py]) => hit(px,py)).length < 2) return false;
    try {
      if (view.frameElement && !isExposed(view.frameElement)) return false;
    } catch { /* Cross-origin ancestors cannot be inspected by this frame. */ }
    return true;
  }

  function isEditable(element) {
    return element instanceof HTMLInputElement && !element.disabled && !element.readOnly &&
      !element.matches?.(":disabled") && !isOtpField(element) && isVisible(element);
  }

  function isFillable(element) {
    return isEditable(element) && isExposed(element);
  }

  function hasStrongIdentitySignal(element) {
    const type = (element.type || "text").toLowerCase();
    const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
    if (autocomplete.includes("username") || autocomplete.includes("email") || autocomplete.includes("webauthn")) return true;
    if (type === "email") return true;
    return /\b(e[\s-]?mail|sign[\s-]?in[\s-]?id|log[\s-]?in[\s-]?id|user[\s-]?id|username|passkey)\b|用户名|使用者名稱|邮箱|郵箱|电子邮件|電子郵件|手机号|手機號|アカウント/i.test(attrBlob(element));
  }

  function formLooksLikeAddress(element, context) {
    if (!element.form) return false;
    if (context?.addressForms?.has(element.form)) return context.addressForms.get(element.form);
    const result = Array.from(element.form.querySelectorAll("input")).some((input) =>
      /\b(shipping|billing|address-line|address-level|postal-code|given-name|family-name|cc-)\b/i.test(
        input.getAttribute("autocomplete") || "",
      ),
    );
    context?.addressForms?.set(element.form, result);
    return result;
  }

  function isUsernameField(element, context) {
    if (!(element instanceof HTMLInputElement) || isOtpField(element) || isSearchOrComboField(element)) return false;
    if (!["text", "email", "tel", ""].includes((element.type || "text").toLowerCase())) return false;
    const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
    if (autocomplete.includes("username") || autocomplete.includes("webauthn")) return true;
    if (isPasswordish(element) || nonLoginHint.test(attrBlob(element))) return false;
    if (!hasStrongIdentitySignal(element) && !/\b(user|login|signin|sign[\s-]?in|loginid)\b/i.test(attrBlob(element))) return false;
    return !formLooksLikeAddress(element, context);
  }

  function pageHasVisiblePassword(field, context) {
    const root = field?.getRootNode?.();
    if (context?.visiblePasswords?.has(root)) return context.visiblePasswords.get(root);
    const visible = Array.from(document.querySelectorAll('input[type="password"]')).some(isVisible) ||
      !!(root && root !== document && root.querySelectorAll &&
        Array.from(root.querySelectorAll('input[type="password"]')).some(isVisible));
    context?.visiblePasswords?.set(root, visible);
    return visible;
  }

  function loginishContext(element) {
    if (loginContextHint.test(location.hostname + location.pathname)) return true;
    if (element.form && loginContextHint.test(element.form.getAttribute("action") || "")) return true;
    return Array.from((element.form || document).querySelectorAll("button, input[type=submit]")).some((button) =>
      /\b(sign[\s-]?in|log[\s-]?in|continue|next)\b|登录|登入|登錄|下一步|继续|繼續|ログイン/i.test(button.textContent || button.value || ""),
    );
  }

  function isLoginField(element, context) {
    if (!isEditable(element)) return false;
    if (isPasswordish(element)) return true;
    if (!isUsernameField(element, context)) return false;
    const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
    if (autocomplete.includes("username")) return true;
    if (element.form) {
      let hasPassword = context?.formPasswords?.get(element.form);
      if (hasPassword === undefined) {
        hasPassword = Array.from(element.form.querySelectorAll("input")).some(isPasswordField);
        context?.formPasswords?.set(element.form, hasPassword);
      }
      if (hasPassword) return true;
    }
    if (element.form && (element.form.getAttribute("autocomplete") || "").toLowerCase() === "off") return false;
    if (pageHasVisiblePassword(element, context)) return true;
    return hasStrongIdentitySignal(element) && loginishContext(element);
  }

  function inputsIn(scope) {
    const all = scope?.tagName === "FORM" && scope.elements ? Array.from(scope.elements) : Array.from(scope.querySelectorAll("input"));
    return all.filter((el) => el instanceof HTMLInputElement &&
      (scope.nodeType === 9 || !el.form || el.form === scope || !scope.querySelector?.("form")));
  }

  function scopeFor(element) {
    if (element?.form) return element.form;
    const explicit = element?.closest?.('[role="form"], fieldset, section, dialog, article');
    if (explicit) return explicit;
    const root = element?.getRootNode?.() || document;
    const fallback = element?.parentElement || root;
    for (let node = element?.parentElement; node && node !== root; node = node.parentElement) {
      const inputs = inputsIn(node);
      const context = { addressForms: new Map() };
      const users = inputs.filter((input) => isUsernameField(input, context));
      const passwords = inputs.filter(isPasswordish);
      if (users.length > 1 || passwords.length > 3 || node.querySelectorAll("form").length) break;
      if (passwords.length && (users.length === 1 || passwords.length >= 2)) return node;
    }
    return fallback;
  }

  function classify(scope) {
    const inputs = inputsIn(scope);
    const context = { addressForms: new Map() };
    return {
      inputs,
      passwords: inputs.filter(isPasswordish),
      usernames: inputs.filter((input) => isUsernameField(input, context)),
    };
  }

  function isNewPasswordField(element) {
    if (!isPasswordish(element)) return false;
    const ac = element.autocomplete || "";
    const current = (input) => /current-password/i.test(input.autocomplete || "") ||
      /\b(old|current)[\s_-]*(?:pass|pwd)|旧密码|舊密碼|当前密码|目前密碼/i.test(attrBlob(input));
    if (current(element)) return false;
    if (/new-password/i.test(ac)) return true;
    const scope = scopeFor(element);
    const passwords = classify(scope).passwords.filter(isEditable);
    if (passwords.some(current)) {
      return /new|confirm|repeat|新密码|新密碼|确认|確認/i.test(attrBlob(element));
    }
    if (passwords.length === 2 && passwords.some((p) => /new-password/i.test(p.autocomplete || "") ||
      /confirm|repeat|确认|確認/i.test(attrBlob(p)))) return true;
    return Array.from(scope.querySelectorAll('button, input[type="submit"]')).some((b) =>
      /sign[\s-]?up|register|create[\s-]?account|注册|註冊|创建账号|建立帳戶/i.test(b.textContent || b.value || ""));
  }

  globalThis.FAPASSWORD_FIELDS = Object.freeze({
    attrBlob,
    everPassword,
    isFillable,
    isEditable,
    isExposed,
    isLoginField,
    isOtpField,
    isPasswordField,
    isPasswordish,
    isSearchOrComboField,
    isUsernameField,
    isVisible,
    scopeFor,
    classify,
    isNewPasswordField,
    nonLoginHint,
  });
})();
