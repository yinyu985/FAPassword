// chrome.storage.session is browser memory, not local/sync storage. Content
// scripts must not get access to pending passwords. Browser shutdown clears it.
export function createSaveStore(storage) {
  const key = "pendingCredentialSavesV1";
  let tail = Promise.resolve();
  let loading = null;
  let loaded = !storage;
  return {
    load() {
      if (!storage) return Promise.resolve([]);
      if (loading) return loading;
      loading = (async () => {
        await tail.catch(() => {});
        await storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
        const entries = (await storage.get(key))[key];
        loaded = true;
        // Recovery can merge an unread old queue with recently captured intents.
        // Admission limits must not truncate already accepted pending passwords.
        return Array.isArray(entries) ? entries.slice() : [];
      })().finally(() => { loading = null; });
      return loading;
    },
    save(getEntries, didStore) {
      if (!storage) return Promise.reject(new Error("save store unavailable"));
      // A failed recovery read must not be followed by overwriting unknown
      // pending passwords with a new, incomplete in-worker queue.
      if (!loaded) return Promise.reject(new Error("save store recovery unavailable"));
      // Build each snapshot after the preceding write has committed (or failed).
      // A concurrent write must neither include a rejected change nor undo a successful one.
      const write = tail.catch(() => {}).then(async () => {
        const snapshot = getEntries().map(({ id, target, host, username, password, saveKind, submissionId,
          draftId, expiresAt, status, attempts, messageKey, completedAt, manual, priorDeliveryUnknown }) => ({ id, target, host,
          username, password, saveKind, submissionId, draftId, expiresAt, status, attempts, messageKey, completedAt, manual, priorDeliveryUnknown }));
        await storage.set({ [key]: snapshot });
        didStore?.();
      });
      tail = write;
      return write;
    },
  };
}
