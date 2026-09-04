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
      origin: url.origin.toLowerCase(),
      secure: url.protocol === "https:",
    };
  } catch {
    return null;
  }
}

export function isLocalDevHost(host) {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host?.endsWith(".localhost") ||
    host?.endsWith(".test")
  );
}

export async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
