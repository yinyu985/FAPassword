import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const listeners = () => {
  const values = [];
  return { values, api: { addListener: (fn) => values.push(fn) } };
};

function fakePort({ capabilities = {}, autoCapabilities = true } = {}) {
  const messages = listeners();
  const disconnects = listeners();
  const port = {
    onMessage: messages.api,
    onDisconnect: disconnects.api,
    postMessage(message) {
      if (message.cmd === 14 && autoCapabilities) {
        queueMicrotask(() => messages.values.forEach((fn) => fn({ cmd: 14, capabilities })));
      }
    },
    disconnect() {
      queueMicrotask(() => disconnects.values.forEach((fn) => fn()));
    },
    drop() {
      disconnects.values.forEach((fn) => fn());
    },
    replyCapabilities() {
      messages.values.forEach((fn) => fn({ cmd: 14, capabilities }));
    },
  };
  return port;
}

const ports = [];
globalThis.chrome = {
  runtime: {
    lastError: undefined,
    connectNative() {
      const port = ports.shift();
      if (!port) throw new Error("no fake port queued");
      return port;
    },
  },
};

const { ApplePasswords, Command } = await import("../../src/protocol.js");
const results = [];
function check(name, condition, detail = "") {
  results.push(condition);
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` -> ${detail}`}`);
}

// Focusing a field while startup connection is still negotiating used to observe a port,
// return early, and then fail requestChallenge with no session. Every caller must await the
// same capabilities exchange instead.
{
  const slow = fakePort({ autoCapabilities: false });
  ports.push(slow);
  const client = new ApplePasswords();
  let firstDone = false;
  const first = client.connect().then(() => {
    firstDone = true;
  });
  const second = client.connect();
  await Promise.resolve();
  check("concurrent connect callers share one negotiation", !firstDone && client.session === undefined);
  slow.replyCapabilities();
  await Promise.all([first, second]);
  check("concurrent connect callers all wait for a usable session", !!client.session && client.state === "needs_pin");
  client.disconnect();
}

// A capabilities failure must release the port so a later retry can connect.
{
  const bad = fakePort({ capabilities: { secretSessionVersion: 99 } });
  const good = fakePort();
  ports.push(bad, good);
  const client = new ApplePasswords();
  let rejected = false;
  await client.connect().catch(() => (rejected = true));
  check("capabilities failure rejects", rejected);
  check("capabilities failure clears the port", client.port === undefined);
  await client.connect();
  check("connection can retry after capabilities failure", client.port === good && client.state === "needs_pin");
  client.disconnect();
}

// Any in-flight native request must reject on disconnect, even if its caller supplied no timer.
{
  const first = fakePort();
  const second = fakePort();
  ports.push(first, second);
  const client = new ApplePasswords();
  await client.connect();
  const request = client._withLock(() => client._send(Command.GET_PASSWORD_FOR_LOGIN_NAME, {}, null));
  first.drop();
  const outcome = await Promise.race([
    request.then(() => "resolved", () => "rejected"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 100)),
  ]);
  check("disconnect rejects a no-timeout waiter", outcome === "rejected", outcome);
  const lockOutcome = await Promise.race([
    client._withLock(() => "continued"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
  ]);
  check("disconnect releases the serialized request queue", lockOutcome === "continued", lockOutcome);
  await client.connect();
  check("disconnect permits a fresh connection", client.port === second);
  client.disconnect();
}

// A helper that neither replies nor disconnects must not own the correlation-less queue
// forever. A password-read timeout tears down the port before allowing another request.
{
  const client = new ApplePasswords();
  client.port = {};
  client.session = { sharedKey: new Uint8Array([1]) };
  client.state = "unlocked";
  client._encryptedQuery = async () => {
    throw new Error("timeout waiting for response");
  };
  let disconnected = false;
  client.disconnect = () => {
    disconnected = true;
  };
  const message = await client
    .getPasswordForLoginName(1, "https://example.test/login", { username: "test" })
    .then(() => "resolved", (error) => error.message);
  check("password timeout tears down the ambiguous native stream", disconnected);
  check("password timeout returns an actionable error", message === "Password request timed out; try again", message);
}

const passed = results.filter(Boolean).length;
console.log(`\n==== ${passed}/${results.length} PASS ====`);
process.exit(passed === results.length ? 0 : 1);
