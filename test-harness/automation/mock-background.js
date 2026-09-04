// Test-only service worker copied into generated mock extension builds.
const kind = "__FAPASSWORD_MOCK_KIND__";
let unlocked = kind !== "locked";
globalThis.saveRequests = 0;
const state = () => (unlocked ? "unlocked" : "needs_pin");

function logins() {
  if (kind === "multi") return [{ username: "alice@example.com" }, { username: "bob@work.com" }];
  return [{ username: "test@example.com" }];
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "fapassword-popup") port.postMessage({ type: "state", state: state() });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "inlineLogins":
        sendResponse({ ok: true, locked: !unlocked, logins: unlocked ? logins() : [] });
        break;
      case "inlineFill": {
        const frameUrl = sender.url;
        const origin = frameUrl ? new URL(frameUrl).origin.toLowerCase() : "";
        const response = await chrome.tabs.sendMessage(
          sender.tab.id,
          {
            type: "fill",
            username: msg.loginName?.username || "test@example.com",
            password: "TestPass123",
            expectedOrigin: origin,
          },
          { frameId: sender.frameId },
        );
        sendResponse({ ok: true, filled: !!response?.filled });
        break;
      }
      case "getState":
      case "connect":
        sendResponse({ ok: true, state: state(), hasChallenge: !unlocked });
        break;
      case "requestChallenge":
        sendResponse({ ok: true, state: state(), hasChallenge: true });
        break;
      case "verifyPin":
        if (msg.pin === "123456") {
          unlocked = true;
          sendResponse({ ok: true, state: state() });
        } else {
          sendResponse({ ok: false, error: "Incorrect code", newCode: true, state: state() });
        }
        break;
      case "getLogins":
        sendResponse({ ok: true, logins: unlocked ? logins() : [] });
        break;
      case "fillOnPage": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const origin = new URL(tab.url).origin.toLowerCase();
        const response = await chrome.tabs.sendMessage(
          tab.id,
          {
            type: "fill",
            username: msg.loginName?.username || "test@example.com",
            password: "TestPass123",
            expectedOrigin: origin,
          },
          { frameId: 0 },
        );
        sendResponse({ ok: true, filled: !!response?.filled });
        break;
      }
      case "refreshAndRefill":
        sendResponse({ ok: true, refilled: false });
        break;
      case "clearCache":
        sendResponse({ ok: true });
        break;
      case "resolveSave":
        globalThis.saveRequests++;
        sendResponse({ ok: true });
        break;
      case "beginUnlock":
        sendResponse({ ok: true, popupOpened: false, state: state(), challengeReady: !unlocked });
        break;
      default:
        sendResponse({ ok: false, error: "unknown test message" });
    }
  })().catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});
