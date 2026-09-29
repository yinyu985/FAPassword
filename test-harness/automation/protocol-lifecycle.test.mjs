import assert from "node:assert/strict";
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
    emit(message) { messages.values.forEach(fn => fn(message)); },
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


// Every correlation-less command tears down its stream on timeout. Old port events
// cannot complete a new request, even when the command number is identical.
for (const cmd of [2, 4, 5, 6, 14]) {
  const old = fakePort(), next = fakePort(); ports.push(old, next);
  const c = new ApplePasswords(); await c.connect();
  // Capabilities normally auto-reply; disable them just for this pending operation.
  if (cmd === 14) old.postMessage = () => {};
  await assert.rejects(c._send(cmd, {}, 8), /timeout/);
  assert.equal(c.port, undefined);
  await c.connect();
  if (cmd === 14) next.postMessage = () => {};
  let done = false;
  const request = c._send(cmd, {}, 1000).then(value => { done = true; return value; });
  old.emit({cmd, value:'old'}); await Promise.resolve(); assert.equal(done, false);
  next.emit({cmd, value:'new'}); assert.equal((await request).value, 'new');
  check(`command ${cmd}: timeout drops stream and late replies cannot cross connections`, true);
  c.disconnect();
}
{
  const port = fakePort(); ports.push(port); const c = new ApplePasswords(); await c.connect();
  const first = c._withLock(() => c._send(4, {}, null));
  await new Promise(resolve => setTimeout(resolve, 0));
  let queuedRan = false;
  const queued = c._withLock(() => { queuedRan = true; });
  port.emit({cmd:10});
  await assert.rejects(first); await assert.rejects(queued);
  assert.equal(queuedRan, false); assert.equal(c._waiters.size,0);assert.equal(c.ready,false);
  check('RELOGIN_NEEDED cancels waiters and prevents queued operations from starting',true);
}
{
  const c = new ApplePasswords(); let finish;
  const first = c._withLock(() => new Promise(resolve => finish = resolve));
  const controller = new AbortController();
  const second = c._withLock(() => { throw new Error('cancelled queued function ran'); }, {signal:controller.signal});
  controller.abort(); await assert.rejects(second);
  let thirdRan = false;
  const third = c._withLock(() => { thirdRan = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(thirdRan,false);
  finish(); await Promise.all([first,third]);
  check('cancelling a queued caller never lets its successor overtake the active request',true);
}
{
  const port = fakePort(); ports.push(port); const c = new ApplePasswords(); await c.connect();
  c.session.sharedKey=1n;c.state='unlocked'; c._encryptedQuery=async()=>({STATUS:9});
  const states=[];c.onStateChange(state=>states.push(state));
  await assert.rejects(c.getLoginNamesForURL(1,'https://a.test'));
  assert.equal(c.ready,false);assert.equal(c.session,undefined);assert.deepEqual(states,['disconnected']);
  check('InvalidSession drops the session and publishes a cache-clearing state transition',true);
}
{
  const c = new ApplePasswords();let finish;
  const first=c._withLock(()=>new Promise(resolve=>finish=resolve));
  let ran=false;const expired=c._withLock(()=>{ran=true;},{timeoutMs:5});
  await assert.rejects(expired,/timed out/);finish();await first;
  assert.equal(ran,false);check('queue time counts toward the request deadline',true);
}

for (const mode of ['wrong-TID', 'bad-tag', 'truncated', 'invalid-encoding']) {
  const port = fakePort();ports.push(port);const c=new ApplePasswords();await c.connect();
  const session=c.session;session.sharedKey=1n;c.state='unlocked';
  c._send=async()=>({payload:{SMSG:{TID:mode==='wrong-TID'?'other-session':session.username,
    SDATA:mode==='bad-tag'?'00'.repeat(48):mode==='truncated'?'00':'not hex'}}});
  await assert.rejects(c._encryptedQuery(4,1,'example.com',{},100));
  assert.equal(c.ready,false);assert.equal(c.session,undefined);
  check(`${mode} encrypted response fails closed and invalidates the session`,true);
}
{
  const port=fakePort();ports.push(port);const c=new ApplePasswords();await c.connect();
  const session=c.session;session.sharedKey=1n;c.state='unlocked';
  let finish;session.encrypt=async()=>new Uint8Array();session.decrypt=()=>new Promise(resolve=>finish=resolve);
  c._send=async()=>({payload:{SMSG:{TID:session.username,SDATA:'00'}}});
  const query=c._encryptedQuery(4,1,'example.com',{},100);
  await new Promise(resolve=>setTimeout(resolve,0));port.emit({cmd:10});
  finish(new TextEncoder().encode('{"STATUS":0,"Entries":[]}'));
  await assert.rejects(query,/session changed/);assert.equal(c.ready,false);
  check('invalidation during asynchronous decryption rejects the stale result',true);
}

const passed = results.filter(Boolean).length;
console.log(`\n==== ${passed}/${results.length} PASS ====`);
process.exit(passed === results.length ? 0 : 1);
