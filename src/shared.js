export function normalizePin(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\D/g, "")
    .slice(0, 6);
}

export function pageContext(value) {
  try {
    const url = new URL(value);
    return {
      url,
      host: url.hostname.toLowerCase(),
      origin: url.origin,
      secure: url.protocol === "https:",
    };
  } catch {
    return null;
  }
}

// Chrome distinguishes a missing/forbidden host from a host that stopped running.
export function nativeHostUnavailable(message) {
  return /native (?:messaging )?host.*(?:not found|forbidden|not allowed)|(?:forbidden|not allowed).*native (?:messaging )?host/i.test(message);
}

// Stable UI messages; helper diagnostics remain available to the caller for logging.
export function errorKey(error) {
  if (error?.errorKey) return error.errorKey;
  const message = String(error?.message ?? error ?? "");
  if (/incorrect code/i.test(message)) return "errorIncorrectCode";
  if (/challenge_reissued|new code|expired code/i.test(error?.code || message)) return "errorNewCode";
  if (/timeout|timed out/i.test(message)) return "errorTimeout";
  if (/not unlocked|invalid session|session changed/i.test(message)) return "errorLocked";
  if (nativeHostUnavailable(message)) return "errorNoHelper";
  if (/connection|disconnected|not connected|native (?:messaging )?host|port.*closed/i.test(message)) return "errorConnection";
  if (/page|frame|document|target|stale|superseded/i.test(message)) return "errorPageChanged";
  if (/cancel|abort/i.test(message)) return "errorCancelled";
  if (/HTTPS|URL|unavailable/i.test(message)) return "pageUnavailable";
  if (/protocol|capabilities|HAMK|authentication|encoding|hex|base64|format|payload|message|session/i.test(message)) return "errorProtocol";
  return "errorOperation";
}

export async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
