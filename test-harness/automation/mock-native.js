// Test-only native transport. Production background/protocol/SRP/cache code runs unchanged.
import { GROUP_PRIME as N } from "../../src/srp.js";
import { sha256, powmod, mod, randomBytes, bytesToBigInt, bigIntToBytes, padBytes, concatBytes,
  bytesToHex, hexToBytes, bytesToUtf8, utf8ToBytes, bytesToBase64, base64ToBytes, constantTimeEqual } from "../../src/crypto.js";
const NB = 384, g = 5n;
const kind = "__FAPASSWORD_MOCK_KIND__";
const state = globalThis.testNative = {
  kind, pin: "123456", counters: { names: 0, passwords: 0, saves: 0, challenges: 0 },
  frames: [], messageCounts: {},
  delays: { names: 0, passwords: 0, saves: 0 }, entries: null, statuses: {}, saves: [], ports: [],
  invalidate() { for (const port of state.ports) if (!port.closed) port.emit({ cmd: 10 }); },
};
chrome.runtime.onMessage.addListener((message, sender) => {
  state.messageCounts[message.type] = (state.messageCounts[message.type] || 0) + 1;
  if (message.type === "frameReady") state.frames.push({ tabId: sender.tab?.id, frameId: sender.frameId, documentId: sender.documentId, documentKey: message.documentKey, url: sender.url });
});
Object.defineProperty(globalThis, "saveRequests", { get: () => state.counters.saves });
const encode = (object) => bytesToBase64(utf8ToBytes(JSON.stringify(object)));
const decode = (text) => JSON.parse(bytesToUtf8(base64ToBytes(text)));
const serialize = (value) => "0x" + bytesToHex(value);
const entries = () => state.entries || (kind === "multi" ?
  [{ USR: "alice@example.com", PWD: "TestPass123" }, { USR: "bob@work.com", PWD: "OtherPass123" }] :
  [{ USR: "test@example.com", PWD: "TestPass123" }]);
const event = () => { const callbacks = new Set(); return { addListener: (fn) => callbacks.add(fn), removeListener: (fn) => callbacks.delete(fn), emit: (value) => { for (const fn of callbacks) fn(value); } }; };

chrome.runtime.connectNative = (host) => {
  if (host !== "com.apple.passwordmanager") throw new Error("test native host unavailable");
  const onMessage = event(), onDisconnect = event();
  let session;
  const port = { onMessage, onDisconnect, closed: false, emit: onMessage.emit,
    postMessage(message) {
      if (message.cmd === 6 && state.throwSavePost) throw new Error('test native post failed');
      queueMicrotask(() => handle(message).catch((error) => { state.error = String(error); port.disconnect(); }));
    },
    disconnect() { if (port.closed) return; port.closed = true; queueMicrotask(() => onDisconnect.emit()); },
  };
  state.ports.push(port);
  async function handle(message) {
    if (message.cmd === 0) return;
    if (message.cmd === 14) {
      if (state.capabilitiesGate) await state.capabilitiesGate;
      return onMessage.emit({ cmd: 14, capabilities: { secretSessionVersion: 1, shouldUseBase64: false } });
    }
    if (message.cmd === 2) {
      const pake = decode(message.msg.PAKE);
      if (pake.MSG === 0) {
        state.counters.challenges++;
        if (state.delays.challenges) await new Promise(resolve => setTimeout(resolve, state.delays.challenges));
        const salt = randomBytes(16), A = bytesToBigInt(hexToBytes(pake.A)), b = bytesToBigInt(randomBytes(32));
        const x = bytesToBigInt(await sha256(salt, await sha256(utf8ToBytes(pake.TID + ":" + state.pin))));
        const v = powmod(g, x, N);
        const k = bytesToBigInt(await sha256(bigIntToBytes(N), padBytes(bigIntToBytes(g), NB)));
        const B = mod(k * v + powmod(g, b, N), N);
        const u = bytesToBigInt(await sha256(padBytes(bigIntToBytes(A), NB), padBytes(bigIntToBytes(B), NB)));
        const K = await sha256(bigIntToBytes(powmod(mod(A * powmod(v, u, N), N), b, N)));
        const hN = await sha256(bigIntToBytes(N)), hg = await sha256(padBytes(bigIntToBytes(g), NB));
        const xor = hN.map((byte, index) => byte ^ hg[index]);
        const M = await sha256(xor, await sha256(utf8ToBytes(pake.TID)), salt, bigIntToBytes(A), bigIntToBytes(B), K);
        session = { TID: pake.TID, M, HAMK: await sha256(bigIntToBytes(A), M, K),
          key: await crypto.subtle.importKey("raw", K.slice(0, 16), "AES-GCM", false, ["encrypt", "decrypt"]) };
        return onMessage.emit({ cmd: 2, payload: { PAKE: encode({ TID: pake.TID, MSG: 1, PROTO: 1, B: serialize(bigIntToBytes(B)), s: serialize(salt) }) } });
      }
      const correct = session && constantTimeEqual(hexToBytes(pake.M), session.M);
      return onMessage.emit({ cmd: 2, payload: { PAKE: encode({ TID: pake.TID, MSG: 3, ErrCode: correct ? 0 : 1, HAMK: serialize(session.HAMK) }) } });
    }
    const s = session;
    const payload = typeof message.payload === 'string' ? JSON.parse(message.payload) : message.payload;
    const smsg = JSON.parse(payload.SMSG);
    const encrypted = hexToBytes(smsg.SDATA);
    const data = JSON.parse(bytesToUtf8(new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: encrypted.slice(-16) }, s.key, encrypted.slice(0, -16)))));
    let response;
    const name = message.cmd === 4 ? "names" : message.cmd === 5 ? "passwords" : "saves";
    state.counters[name]++;
    if (name === "names" && state.namesGate) await state.namesGate;
    if (state.delays[name]) await new Promise((resolve) => setTimeout(resolve, state.delays[name]));
    if (message.cmd === 6) {
      state.saves.push({ username: data.NUSR, password: data.NPWD, host: data.NURL });
      if (state.dropSaveAck) return;
      return onMessage.emit({ cmd: 6 });
    }
    const selected = message.cmd === 4 ? entries() : entries().filter((entry) => entry.USR === data.USR);
    response = { STATUS: state.statuses[name] ?? (selected.length ? 0 : 3), Entries: selected };
    const iv = randomBytes(16);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, s.key, utf8ToBytes(JSON.stringify(response))));
    onMessage.emit({ cmd: message.cmd, payload: { SMSG: JSON.stringify({ TID: s.TID, SDATA: serialize(concatBytes(iv, ciphertext)) }) } });
  }
  return port;
};
chrome.runtime.sendNativeMessage = (host, message, callback) => {
  callback(state.policyResponse || { ok: true, hidden: false, managed: false, value: true, browserName: "Test Chromium", scopeVersion: 2 });
};
