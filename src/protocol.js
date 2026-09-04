// client for the macOS PasswordManagerBrowserExtensionHelper over
// chrome.runtime.connectNative("com.apple.passwordmanager").
// flow: GET_CAPABILITIES -> handshake m0 (challenge / PIN prompt) -> user enters
// PIN -> handshake m2 (verify) -> encrypted queries.
// ported from au2001/icloud-passwords-firefox (Apache-2.0). see NOTICE

import { SRPSession, SecretSessionVersion, MSGType } from "./srp.js";
import {
  bytesToBase64,
  base64ToBytes,
  bytesToUtf8,
  bigIntToBytes,
  bytesToBigInt,
  constantTimeEqual,
  QueryStatus,
  queryStatusError,
} from "./crypto.js";

const NATIVE_HOST = "com.apple.passwordmanager";
const BROWSER_NAME = "Chrome";
const VERSION = "1.0";
const PASSWORD_READ_TIMEOUT_MS = 2 * 60_000;
// how long we still trust a code the Mac put on screen. past this we re-prompt rather than
// verify against a challenge the user has probably lost track of
const CHALLENGE_TTL_MS = 3 * 60_000;

// the typed code was for a challenge that no longer exists. callers show "new code" wording
// instead of "incorrect", because retyping the old code can never work
function challengeError(message) {
  const e = new Error(message);
  e.code = "challenge_reissued";
  return e;
}

export const Command = {
  END: 0,
  HANDSHAKE: 2,
  GET_LOGIN_NAMES_FOR_URL: 4,
  GET_PASSWORD_FOR_LOGIN_NAME: 5,
  SET_PASSWORD_FOR_LOGIN_NAME_URL: 6, // save or update a login
  TAB_EVENT: 8,
  PASSWORDS_DISABLED: 9,
  RELOGIN_NEEDED: 10,
  GET_CAPABILITIES: 14,
};

const Action = { UPDATE: 1, SEARCH: 2, ADD_NEW: 3, MAYBE_ADD: 4, GHOST_SEARCH: 5 };

export const State = {
  Disconnected: "disconnected",
  NeedsPin: "needs_pin", // challenge issued, waiting for the user's PIN
  Unlocked: "unlocked", // session key established
  NoHelper: "no_helper", // native host missing
};

function jsonToBase64(obj) {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(obj)));
}

export class ApplePasswords {
  constructor() {
    this.port = undefined;
    this.session = undefined;
    this.capabilities = undefined;
    this.state = State.Disconnected;
    this._waiters = new Map(); // cmd -> {resolve, reject, timer}
    this._onState = () => {};
    this._challengeAt = 0; // when the current code went up on the Mac
    this._challengeGen = 0; // bumped per challenge, so a queued verify can spot a stale one
    this._challengePending = undefined; // in-flight requestChallenge, shared by callers
    this._connectPending = undefined; // all callers await the same capabilities negotiation
    // native protocol echoes the same cmd on replies with no correlation id, so two
    // in-flight requests with the same cmd collide. serialize all exchanges here
    this._lock = Promise.resolve();
  }

  _rejectWaiters(error = new Error("connection closed")) {
    for (const waiter of this._waiters.values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this._waiters.clear();
  }

  _dropConnection(port, state = State.Disconnected, error = new Error("connection closed")) {
    // Ignore a late disconnect event from a port that has already been replaced.
    if (port && port !== this.port) return;
    this.port = undefined;
    this.session = undefined;
    this.capabilities = undefined;
    this._challengeAt = 0;
    this._challengePending = undefined;
    this._challengeGen++;
    this._rejectWaiters(error);
    this._setState(state);
  }

  _withLock(fn) {
    const run = this._lock.then(fn, fn);
    // keep chain alive even if fn rejects, so the next caller still runs
    this._lock = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  onStateChange(fn) {
    this._onState = fn;
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    try {
      this._onState(s);
    } catch (_) {}
  }

  get ready() {
    return (
      this.port !== undefined &&
      this.session !== undefined &&
      this.session.sharedKey !== undefined &&
      this.state === State.Unlocked
    );
  }

  _send(cmd, body = {}, timeoutMs = 5000) {
    if (!this.port) throw new Error("connection closed");
    // replies carry no correlation id, so a second request on the same cmd would steal the
    // first one's reply. refuse instead of overwriting the waiter
    if (this._waiters.has(cmd)) return Promise.reject(new Error("another request is already in flight"));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer =
        timeoutMs == null
          ? null
          : setTimeout(() => {
              // only drop our own entry, never a newer request's
              if (this._waiters.get(cmd) === entry) this._waiters.delete(cmd);
              reject(new Error("timeout waiting for response"));
            }, timeoutMs);
      this._waiters.set(cmd, entry);
      try {
        this.port.postMessage({ cmd, ...body });
      } catch (e) {
        if (entry.timer) clearTimeout(entry.timer);
        if (this._waiters.get(cmd) === entry) this._waiters.delete(cmd);
        reject(e);
      }
    });
  }

  _dispatch(message) {
    const w = this._waiters.get(message.cmd);
    if (w) {
      this._waiters.delete(message.cmd);
      if (w.timer) clearTimeout(w.timer);
      w.resolve(message);
    }
    // unsolicited session-invalidation signals from the helper
    if (message.cmd === Command.PASSWORDS_DISABLED || message.cmd === Command.RELOGIN_NEEDED) {
      this.session = new SRPSession(this.capabilities?.shouldUseBase64);
      this._challengeAt = 0;
      this._challengeGen++;
      this._setState(State.NeedsPin);
    }
  }

  // does NOT reset an existing unlocked session (core fix vs Apple's extension,
  // which re-pairs on every connect)
  connect() {
    if (this.ready || (this.port && this.session)) return Promise.resolve();
    if (this._connectPending) return this._connectPending;

    // A port without a session and without an in-flight negotiation is unusable. This
    // should not normally survive _dropConnection(), but recovering here avoids recreating
    // the historical half-connected state if Chromium delivers an unusual callback order.
    if (this.port) {
      const stale = this.port;
      try {
        stale.disconnect();
      } catch (_) {}
      this._dropConnection(stale);
    }

    const pending = new Promise((resolve, reject) => {
      let port;
      try {
        port = chrome.runtime.connectNative(NATIVE_HOST);
      } catch (e) {
        this._setState(State.NoHelper);
        return reject(e);
      }
      this.port = port;

      port.onMessage.addListener((msg) => this._dispatch(msg));
      port.onDisconnect.addListener(() => {
        const message = chrome.runtime.lastError?.message || "native helper disconnected";
        const state = /not found|forbidden|host/i.test(message) ? State.NoHelper : State.Disconnected;
        this._dropConnection(port, state, new Error(message));
      });

      this._send(Command.GET_CAPABILITIES)
        .then((reply) => {
          this.capabilities = reply.capabilities ?? {};
          // capabilities flag may be absent or default to "old"; real helper
          // negotiates per-handshake via PROTO (we send + verify RFC there). only
          // reject if capabilities explicitly demand a non-RFC version
          if (
            this.capabilities.secretSessionVersion !== undefined &&
            this.capabilities.secretSessionVersion !== SecretSessionVersion.SRPWithRFCVerification
          ) {
            throw new Error("unsupported capabilities (expected SRP RFC verification)");
          }
          this.session = new SRPSession(this.capabilities.shouldUseBase64);
          this._setState(State.NeedsPin);
          resolve();
        })
        .catch((error) => {
          // A failed capabilities exchange must not leave a zombie port behind: the
          // next ensureConnected() call needs to be able to establish a fresh one.
          if (this.port === port) {
            try {
              port.disconnect();
            } catch (_) {}
            this._dropConnection(port, State.Disconnected, error);
          }
          reject(error);
        });
    });
    const wrapped = pending.finally(() => {
      if (this._connectPending === wrapped) this._connectPending = undefined;
    });
    this._connectPending = wrapped;
    return wrapped;
  }

  // is there a challenge the user can still answer? the code on the Mac only belongs to
  // the newest challenge, so anything else must be re-issued before we verify
  get hasChallenge() {
    return (
      this.state === State.NeedsPin &&
      this.session !== undefined &&
      this.session.serverPublicKey !== undefined &&
      this.session.salt !== undefined &&
      Date.now() - this._challengeAt < CHALLENGE_TTL_MS
    );
  }

  // ask the helper for a challenge. macOS shows the 6-digit PIN access prompt.
  // ifNeeded keeps a live prompt alive instead of putting a second code on screen and
  // silently invalidating the one the user is reading
  requestChallenge({ ifNeeded = false } = {}) {
    if (!this.session) return Promise.reject(new Error("not connected"));
    if (ifNeeded && (this.hasChallenge || this.state === State.Unlocked)) return Promise.resolve(false);
    // collapse concurrent requests: two prompts would race and only the last code works
    if (this._challengePending) return this._challengePending;
    const p = this._withLock(() => this._issueChallenge());
    this._challengePending = p;
    const clear = () => {
      if (this._challengePending === p) this._challengePending = undefined;
    };
    p.then(clear, clear);
    return p;
  }

  async _issueChallenge() {
    // A new code is a new SRP handshake, not a retry of the old one. Reusing the old
    // TID/private key can make the real helper treat m0 as the already-issued challenge.
    const session = new SRPSession(this.capabilities?.shouldUseBase64);
    this.session = session;
    this._challengeAt = 0;
    this._challengeGen++;

    const reply = await this._send(Command.HANDSHAKE, {
      msg: {
        QID: "m0",
        PAKE: jsonToBase64({
          TID: session.username,
          MSG: MSGType.ClientKeyExchange,
          A: session.serialize(session.clientPublicKeyBytes),
          VER: VERSION,
          PROTO: [SecretSessionVersion.SRPWithRFCVerification],
        }),
        HSTBRSR: BROWSER_NAME,
      },
    });

    if (this.session !== session) throw challengeError("Challenge was superseded; request another code");
    const pake = JSON.parse(bytesToUtf8(base64ToBytes(reply.payload.PAKE)));
    if (pake.TID !== session.username) throw new Error("challenge for another session");
    if (pake.ErrCode !== undefined) throw new Error(`server hello error ${pake.ErrCode}`);
    if (pake.MSG.toString() !== MSGType.ServerKeyExchange.toString()) throw new Error("unexpected server message");
    if (pake.PROTO !== SecretSessionVersion.SRPWithRFCVerification) throw new Error("unsupported protocol");

    const B = bytesToBigInt(session.deserialize(pake.B));
    const s = session.deserialize(pake.s); // raw bytes, see setServerPublicKey
    session.setServerPublicKey(B, s);
    this._challengeAt = Date.now();
    this._setState(State.NeedsPin);
    return true;
  }

  // a PIN is only valid for the challenge it was displayed for. verifying it against any
  // other challenge always fails, so never quietly swap the challenge underneath the user -
  // issue a fresh one and tell the caller to ask for the NEW code
  async verifyPin(pin) {
    if (!this.session) throw new Error("not connected");
    if (!this.hasChallenge) {
      await this.requestChallenge();
      throw challengeError("Enter the new code your Mac is showing now");
    }
    const gen = this._challengeGen;
    return this._withLock(async () => {
      // something re-issued while we queued: the typed code is for the old prompt
      if (gen !== this._challengeGen) throw challengeError("Enter the new code your Mac is showing now");
      try {
        await this.session.setSharedKey(pin);
        const m = await this.session.computeM();

        const reply = await this._send(Command.HANDSHAKE, {
          msg: {
            QID: "m2",
            PAKE: jsonToBase64({
              TID: this.session.username,
              MSG: MSGType.ClientVerification,
              M: this.session.serialize(m, false),
            }),
          },
        });

        const pake = JSON.parse(bytesToUtf8(base64ToBytes(reply.payload.PAKE)));
        if (pake.TID !== this.session.username) throw new Error("verification for another session");
        if (pake.MSG.toString() !== MSGType.ServerVerification.toString()) throw new Error("unexpected server message");
        if (pake.ErrCode === 1) throw new Error("Incorrect code");
        if (pake.ErrCode !== 0 && pake.ErrCode !== undefined) throw new Error(`verification error ${pake.ErrCode}`);

        const hamk = await this.session.computeHMAC(m);
        if (!constantTimeEqual(this.session.deserialize(pake.HAMK), hamk))
          throw new Error("server HAMK mismatch");

        this._setState(State.Unlocked);
      } catch (e) {
        // the helper burns the challenge on a failed verify, so this code is dead now.
        // drop it - hasChallenge goes false and the next attempt gets a fresh prompt.
        // the session itself can be gone already if the port dropped mid-verify
        if (this.session) {
          this.session.sharedKey = undefined;
          this.session._encryptionKey = undefined;
          this.session.serverPublicKey = undefined;
          this.session.salt = undefined;
        }
        this._challengeAt = 0;
        throw e;
      }
    });
  }

  async _encryptedQuery(cmd, tabId, hostname, payloadBody, timeoutMs) {
    const sdata = this.session.serialize(await this.session.encrypt(payloadBody));
    const reply = await this._send(
      cmd,
      {
        tabId,
        frameId: 0,
        url: hostname,
        payload: { QID: cmd === Command.GET_LOGIN_NAMES_FOR_URL ? "CmdGetLoginNames4URL" : "CmdGetPassword4LoginName", SMSG: JSON.stringify({ TID: this.session.username, SDATA: sdata }) },
      },
      timeoutMs,
    );

    let smsg = reply.payload.SMSG;
    if (typeof smsg === "string") smsg = JSON.parse(smsg);
    if (smsg.TID !== this.session.username) throw new Error("response for another session");
    const data = await this.session.decrypt(this.session.deserialize(smsg.SDATA));
    return JSON.parse(bytesToUtf8(data));
  }

  async getLoginNamesForURL(tabId, url) {
    if (!this.ready) throw new Error("not unlocked");
    const { hostname } = new URL(url);
    return this._withLock(async () => {
      const res = await this._encryptedQuery(
        Command.GET_LOGIN_NAMES_FOR_URL,
        tabId,
        hostname,
        { ACT: Action.GHOST_SEARCH, URL: hostname },
        5000,
      );
      if (res.STATUS === QueryStatus.Success)
        return (res.Entries ?? []).map((e) => ({ username: e.USR, sites: e.sites }));
      if (res.STATUS === QueryStatus.NoResults) return [];
      throw queryStatusError(res.STATUS);
    });
  }

  async getPasswordForLoginName(tabId, url, loginName) {
    if (!this.ready) throw new Error("not unlocked");
    const { hostname } = new URL(url);
    return this._withLock(async () => {
      let res;
      try {
        res = await this._encryptedQuery(
          Command.GET_PASSWORD_FOR_LOGIN_NAME,
          tabId,
          // Query by trusted frame hostname, never caller-supplied loginName.sites,
          // which a page could use to request another origin's password.
          hostname,
          { ACT: Action.SEARCH, URL: hostname, USR: loginName.username },
          PASSWORD_READ_TIMEOUT_MS,
        );
      } catch (error) {
        if (/timeout waiting for response/i.test(String(error?.message ?? error))) {
          // Replies have no correlation ID. Drop the port so a late reply cannot be
          // mistaken for a later password request after this timeout releases the lock.
          this.disconnect();
          throw new Error("Password request timed out; try again");
        }
        throw error;
      }
      if (res.STATUS === QueryStatus.Success) {
        const e = (res.Entries ?? [])[0];
        if (!e) return undefined;
        // apple's reply is USR/PWD/customTitle/highLevelDomain/sites - no note or OTP seed (verified), cant surface those
        return { username: e.USR, password: e.PWD, sites: e.sites };
      }
      if (res.STATUS === QueryStatus.NoResults) return undefined;
      throw queryStatusError(res.STATUS);
    });
  }

  // save or update a login in Apple Passwords. cmd 6 with ACT maybeAdd lets the helper
  // decide add-vs-update and drive the native macOS save prompt (with Touch ID). the
  // helper's cmd-6 reply carries no decryptable body so we dont parse one - a page can
  // only ever trigger the OS prompt, never write to the vault silently
  async saveLogin(tabId, url, username, password) {
    if (!this.ready) throw new Error("not unlocked");
    if (!password) throw new Error("no password to save");
    const { hostname } = new URL(url);
    return this._withLock(async () => {
      const sdata = this.session.serialize(
        await this.session.encrypt({
          ACT: Action.MAYBE_ADD,
          URL: "",
          USR: "",
          PWD: "",
          NURL: hostname,
          NUSR: username ?? "",
          NPWD: password,
        }),
      );
      const body = {
        tabId,
        frameId: 0,
        payload: {
          QID: "CmdNewAccount4URL",
          SMSG: JSON.stringify({ TID: this.session.username, SDATA: sdata }),
        },
      };
      // the ack is empty and user confirmation happens in the native prompt, so a
      // missing or slow ack is not an error
      try {
        await this._send(Command.SET_PASSWORD_FOR_LOGIN_NAME_URL, body, 3000);
      } catch (e) {
        if (!/timeout/i.test(String(e?.message ?? e))) throw e;
      }
      return true;
    });
  }

  disconnect() {
    const port = this.port;
    if (!port) {
      this._dropConnection(undefined, State.Disconnected);
      return;
    }
    try {
      port.postMessage({ cmd: Command.END });
    } catch (_) {}
    try {
      port.disconnect();
    } catch (_) {}
    this._dropConnection(port, State.Disconnected);
  }
}
