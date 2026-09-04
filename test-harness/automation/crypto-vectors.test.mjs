import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { GROUP_PRIME, GROUP_PRIME_BYTES, SRPSession } = await import("../../src/srp.js");
const { bigIntToBytes, concatBytes, hexToBytes, sha256, bytesToHex } = await import("../../src/crypto.js");
const results = [];
function check(name, condition, detail = "") {
  results.push(condition);
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` -> ${detail}`}`);
}

// Independent fingerprint of RFC 5054's canonical 3072-bit group prime. Unlike a copied
// client/server constant, this catches any single-character mutation in production.
const prime = bigIntToBytes(GROUP_PRIME);
const digest = bytesToHex(await sha256(prime));
check("RFC 5054 3072-bit prime has the expected width", prime.length === GROUP_PRIME_BYTES, `${prime.length}`);
check(
  "RFC 5054 3072-bit prime matches its independent SHA-256 fingerprint",
  digest === "48cf8b092fbce4359d9871abf74f98e25b6163379eaa15cd9087e800c6d1c55c",
  digest,
);

// Fixed AES-128-GCM vector with a 16-byte IV, matching the helper's IV-first reply framing.
const session = new SRPSession(false);
session.sharedKey = 0n;
const iv = new Uint8Array(16);
const ciphertextAndTag = hexToBytes("d89040ea26d8c19eece2e94999e98dccb1f249768c7ffb855b7b7b137bbdf345aafa");
const plaintext = await session.decrypt(concatBytes(iv, ciphertextAndTag));
check(
  "AES-GCM helper-frame vector decrypts",
  new TextDecoder().decode(plaintext) === '{"known":"vector"}',
  new TextDecoder().decode(plaintext),
);
const firstKey = await session.getEncryptionKey();
const secondKey = await session.getEncryptionKey();
check("derived AES CryptoKey is cached per SRP session", firstKey === secondKey);

const passed = results.filter(Boolean).length;
console.log(`\n==== ${passed}/${results.length} PASS ====`);
process.exit(passed === results.length ? 0 : 1);
