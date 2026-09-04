(() => {
  const otpAutocomplete = /one-time-code/i;
  const otpHint = /\b(otp|one[\s-]?time|verification|2fa|mfa|sms[\s-]?code|auth[\s-]?code|security[\s-]?code|passcode)\b/i;
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

  const isPasswordField = (element) => element instanceof HTMLInputElement && element.type === "password";

  function isPasswordish(element) {
    if (!(element instanceof HTMLInputElement)) return false;
    if (element.type === "password" || everPassword.has(element)) return true;
    if (!["text", ""].includes((element.type || "text").toLowerCase())) return false;
    if ((element.getAttribute("autocomplete") || "").toLowerCase().includes("password")) return true;
    return /passw|pwd/i.test(attrBlob(element));
  }

  function isSearchOrComboField(element) {
    const role = (element.getAttribute("role") || "").toLowerCase();
    if (role === "searchbox" || role === "combobox") return true;
    if ((element.type || "").toLowerCase() === "search") return true;
    if ((element.getAttribute("enterkeyhint") || "").toLowerCase() === "search") return true;
    return ["list", "both", "inline"].includes((element.getAttribute("aria-autocomplete") || "").toLowerCase());
  }

  function isVisible(element) {
    if (!element.isConnected) return false;
    const style = getComputedStyle(element);
    if (element.offsetParent === null && style.position !== "fixed") return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    return style.visibility !== "hidden" && style.display !== "none" && Number.parseFloat(style.opacity) >= 0.1;
  }

  function isFillable(element) {
    if (!isVisible(element)) return false;
    const rect = element.getBoundingClientRect();
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    return rect.right > 0 && rect.bottom > 0 && rect.left < width && rect.top < height;
  }

  function hasStrongIdentitySignal(element) {
    const type = (element.type || "text").toLowerCase();
    const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
    if (autocomplete.includes("username") || autocomplete.includes("email") || autocomplete.includes("webauthn")) return true;
    if (type === "email") return true;
    return /\b(e[\s-]?mail|sign[\s-]?in[\s-]?id|log[\s-]?in[\s-]?id|user[\s-]?id|username|passkey)\b/i.test(attrBlob(element));
  }

  function formLooksLikeAddress(element) {
    if (!element.form) return false;
    return Array.from(element.form.querySelectorAll("input")).some((input) =>
      /\b(shipping|billing|address-line|address-level|postal-code|given-name|family-name|cc-)\b/i.test(
        input.getAttribute("autocomplete") || "",
      ),
    );
  }

  function isUsernameField(element) {
    if (!(element instanceof HTMLInputElement) || isOtpField(element) || isSearchOrComboField(element)) return false;
    if (!["text", "email", "tel", ""].includes((element.type || "text").toLowerCase())) return false;
    const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
    if (autocomplete.includes("username") || autocomplete.includes("webauthn")) return true;
    if (formLooksLikeAddress(element) || nonLoginHint.test(attrBlob(element))) return false;
    return hasStrongIdentitySignal(element) || /\b(user|login|signin|sign[\s-]?in|loginid)\b/i.test(attrBlob(element));
  }

  function pageHasVisiblePassword(field) {
    if (Array.from(document.querySelectorAll('input[type="password"]')).some(isVisible)) return true;
    const root = field?.getRootNode?.();
    return !!(root && root !== document && root.querySelectorAll &&
      Array.from(root.querySelectorAll('input[type="password"]')).some(isVisible));
  }

  function loginishContext(element) {
    if (loginContextHint.test(location.hostname + location.pathname)) return true;
    if (element.form && loginContextHint.test(element.form.getAttribute("action") || "")) return true;
    return Array.from((element.form || document).querySelectorAll("button, input[type=submit]")).some((button) =>
      /\b(sign[\s-]?in|log[\s-]?in|continue|next)\b/i.test(button.textContent || button.value || ""),
    );
  }

  function isLoginField(element) {
    if (!isVisible(element)) return false;
    if (isPasswordField(element)) return true;
    if (!isUsernameField(element)) return false;
    const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
    if (autocomplete.includes("username")) return true;
    if (element.form && Array.from(element.form.querySelectorAll("input")).some(isPasswordField)) return true;
    if (element.form && (element.form.getAttribute("autocomplete") || "").toLowerCase() === "off") return false;
    if (pageHasVisiblePassword(element)) return true;
    return hasStrongIdentitySignal(element) && loginishContext(element);
  }

  globalThis.FAPASSWORD_FIELDS = Object.freeze({
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
    nonLoginHint,
  });
})();
