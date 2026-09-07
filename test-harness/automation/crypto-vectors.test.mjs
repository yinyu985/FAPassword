import assert from "node:assert/strict";
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

for (const bad of ["gg", "0x12zz", "12 34", "-1", null]) assert.throws(() => hexToBytes(bad));
const { base64ToBytes } = await import("../../src/crypto.js");
for (const bad of ["!abc", "a", "a===", "AA=A", "AAAA\n", "AB==", null]) assert.throws(() => base64ToBytes(bad));
check("malformed hex and Base64 are rejected", true);
for (const B of [0n, -1n, GROUP_PRIME, GROUP_PRIME+1n]) assert.throws(() => session.setServerPublicKey(B, new Uint8Array([1])));
assert.throws(() => session.setServerPublicKey(1n, new Uint8Array()));
check("invalid SRP public keys and empty salts are rejected", true);
const altered = concatBytes(iv, ciphertextAndTag); altered[altered.length-1] ^= 1;
await assert.rejects(session.decrypt(altered));
for (const size of [0, 1, 15, 16, 31, 32]) await assert.rejects(session.decrypt(new Uint8Array(size)));
check("wrong authentication tags and truncated frames are rejected", true);
const { bytesToUtf8 } = await import("../../src/crypto.js");
assert.throws(() => bytesToUtf8(new Uint8Array([0xc0,0xaf])));
check("malformed UTF-8 cannot silently change credential identity", true);
const base64Session = new SRPSession(true);
assert.deepEqual(base64Session.deserialize(base64Session.serialize(prime)), prime);
check("Base64 session serialization preserves every byte", true);

const passed = results.filter(Boolean).length;
console.log(`\n==== ${passed}/${results.length} PASS ====`);
process.exit(passed === results.length ? 0 : 1);
