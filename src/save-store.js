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
    save(entries) {
      if (!storage) return Promise.resolve();
      // A failed recovery read must not be followed by overwriting unknown
      // pending passwords with a new, incomplete in-worker queue.
      if (!loaded) return Promise.reject(new Error("save store recovery unavailable"));
      // Snapshot immediately; never let a later mutation change an earlier write.
      const snapshot = entries.map(({ id, target, host, username, password, saveKind, submissionId,
        draftId, expiresAt, status, attempts, messageKey, completedAt }) => ({ id, target, host,
        username, password, saveKind, submissionId, draftId, expiresAt, status, attempts, messageKey, completedAt }));
      const write = tail.catch(() => {}).then(() => storage.set({ [key]: snapshot }));
      tail = write;
      return write;
    },
  };
}
