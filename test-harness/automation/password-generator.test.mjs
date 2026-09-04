import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
await import("../../src/password-generator.js");

const { appleStyle, alphanumeric } = globalThis.FAPASSWORD_PASSWORDS;
const generated = Array.from({ length: 500 }, () => appleStyle());
const applePattern = /^(?=.{20}$)(?=(?:.*[A-Z]){1})(?=(?:.*\d){1})[A-Za-z0-9]{6}-[A-Za-z0-9]{6}-[A-Za-z0-9]{6}$/;
const appleValid = generated.every((password) => applePattern.test(password));
const plain = Array.from({ length: 500 }, () => alphanumeric());
const plainValid = plain.every(
  (password) => password.length === 15 && /^[A-Za-z0-9]+$/.test(password) && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password),
);

console.log(appleValid ? "PASS Apple-style password shape" : "FAIL Apple-style password shape");
console.log(plainValid ? "PASS alphanumeric password shape" : "FAIL alphanumeric password shape");
process.exit(appleValid && plainValid ? 0 : 1);
