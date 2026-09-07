// A remembered SRP challenge does not prove that its macOS code window is still open.
// An explicit inline unlock starts a fresh challenge before handing off to the popup.
export async function beginInlineUnlock(client, ensureConnected, openPopup) {
  await ensureConnected();
  if (!client.ready) await client.requestChallenge();
  const challengeReady = client.hasChallenge;
  if (!client.ready && !challengeReady) throw new Error("No verification challenge received");
  let popupOpened = false;
  try { await openPopup(); popupOpened = true; } catch {}
  return { ok: true, popupOpened, state: client.state, challengeReady };
}
