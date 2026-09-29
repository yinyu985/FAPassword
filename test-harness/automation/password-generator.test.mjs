import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
await import("../../src/password-generator.js");

const { appleStyle, alphanumeric, custom } = globalThis.FAPASSWORD_PASSWORDS;
const defaults = Array.from({ length: 500 }, () => custom());
const defaultsValid = defaults.every(password => /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9]{16}$/.test(password));
console.log(defaultsValid ? "PASS default passwords are 16 alphanumeric characters" : "FAIL default password format");
const generated = Array.from({ length: 500 }, () => appleStyle());
const applePattern = /^(?=.{20}$)(?=(?:.*[A-Z]){1})(?=(?:.*\d){1})[A-Za-z0-9]{6}-[A-Za-z0-9]{6}-[A-Za-z0-9]{6}$/;
const appleValid = generated.every((password) => applePattern.test(password));
const plain = Array.from({ length: 500 }, () => alphanumeric());
const plainValid = plain.every(
  (password) => password.length === 15 && /^[A-Za-z0-9]+$/.test(password) && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password),
);
const configurable = Array.from({ length: 500 }, () => custom(24, true));
const configurableValid = configurable.every(
  (password) => password.length === 24 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password),
);
const noSpecial = Array.from({ length: 100 }, () => custom(12, false));
const noSpecialValid = noSpecial.every((password) => password.length === 12 && /^[A-Za-z0-9]+$/.test(password));
let invalidLengthRejected = false;
try { custom(7, true); } catch { invalidLengthRejected = true; }

console.log(appleValid ? "PASS Apple-style password shape" : "FAIL Apple-style password shape");
console.log(plainValid ? "PASS alphanumeric password shape" : "FAIL alphanumeric password shape");
console.log(configurableValid ? "PASS configurable password includes requested character classes" : "FAIL configurable password includes requested character classes");
console.log(noSpecialValid ? "PASS configurable password can omit special characters" : "FAIL configurable password can omit special characters");
console.log(invalidLengthRejected ? "PASS configurable password rejects short lengths" : "FAIL configurable password rejects short lengths");
process.exit(defaultsValid && appleValid && plainValid && configurableValid && noSpecialValid && invalidLengthRejected ? 0 : 1);
