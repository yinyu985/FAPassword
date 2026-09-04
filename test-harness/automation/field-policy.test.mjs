globalThis.HTMLInputElement = class HTMLInputElement {};
globalThis.window = { innerWidth: 1200, innerHeight: 800 };
globalThis.document = { documentElement: { clientWidth: 1200, clientHeight: 800 }, querySelectorAll: () => [] };
globalThis.location = { hostname: "example.com", pathname: "/checkout" };
globalThis.getComputedStyle = (element) => element.computedStyle || {
  position: "static",
  display: "block",
  visibility: "visible",
  opacity: "1",
};

class Input extends HTMLInputElement {
  constructor(attributes = {}) {
    super();
    this.attributes = attributes;
    this.type = attributes.type || "text";
    this.name = attributes.name || "";
    this.id = attributes.id || "";
    this.placeholder = attributes.placeholder || "";
    this.inputMode = attributes.inputmode || "";
    this.isConnected = true;
    this.offsetParent = {};
    this.ownerDocument = { getElementById: () => null };
    this.form = null;
    this.rect = { left: 10, top: 10, right: 210, bottom: 50, width: 200, height: 40 };
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  getBoundingClientRect() {
    return this.rect;
  }
}

await import("../../src/field-policy.js");
const policy = globalThis.FAPASSWORD_FIELDS;
const results = [];
function check(name, condition) {
  results.push(condition);
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
}

const email = new Input({ type: "email", name: "email", autocomplete: "email" });
const address = new Input({ name: "address", autocomplete: "shipping address-line1" });
const checkout = { querySelectorAll: () => [email, address], getAttribute: () => "" };
email.form = checkout;
address.form = checkout;
check("checkout contact email is not a username field", !policy.isUsernameField(email));

const username = new Input({ name: "identity", autocomplete: "username" });
check("explicit two-step username remains eligible", policy.isUsernameField(username));
check("single-character numeric OTP is excluded", !policy.isUsernameField(new Input({ name: "code", inputmode: "numeric", maxlength: "1" })));
check("search boxes are excluded", !policy.isUsernameField(new Input({ type: "search", name: "username-search" })));

const visiblePassword = new Input({ type: "password" });
check("visible in-viewport password is fillable", policy.isFillable(visiblePassword));
const displayNone = new Input({ type: "password" });
displayNone.computedStyle = { position: "static", display: "none", visibility: "visible", opacity: "1" };
displayNone.offsetParent = null;
check("display:none password is never fillable", !policy.isFillable(displayNone));
const offscreen = new Input({ type: "password" });
offscreen.rect = { left: -9999, top: 0, right: -9900, bottom: 40, width: 99, height: 40 };
check("offscreen password is never fillable", !policy.isFillable(offscreen));

const passed = results.filter(Boolean).length;
console.log(`\n==== ${passed}/${results.length} PASS ====`);
process.exit(passed === results.length ? 0 : 1);
