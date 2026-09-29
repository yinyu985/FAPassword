// Only a successfully unlocked session is ready; every other state stays red.
const icons = { 16: "icons/icon16.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };
const titleKeys = {
  connecting: "toolbarConnecting", disconnected: "toolbarDisconnected",
  no_helper: "toolbarNoHelper", needs_pin: "toolbarLocked", unlocked: "toolbarUnlocked",
};

async function disconnectedIcon(runtime) {
  const entries = await Promise.all(Object.entries(icons).map(async ([size, path]) => {
    const response = await fetch(runtime.getURL(path));
    if (!response.ok) throw new Error("Toolbar icon unavailable");
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const canvas = new OffscreenCanvas(Number(size), Number(size));
      const context = canvas.getContext("2d");
      context.fillStyle = "#ef5350";
      context.fillRect(0, 0, canvas.width, canvas.height);
      // Existing artwork is opaque black on white. Multiply preserves the black
      // silhouette and its antialiasing while replacing the white background.
      context.globalCompositeOperation = "multiply";
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return [size, context.getImageData(0, 0, canvas.width, canvas.height)];
    } finally { bitmap.close(); }
  }));
  return Object.fromEntries(entries);
}

export function createToolbarStatus(api, loadFailureIcon = () => disconnectedIcon(api.runtime)) {
  // setIcon resolves paths relative to the calling worker, which lives in src/.
  // Use extension-root URLs, just as the red-image loader does above.
  const normalIcons = Object.fromEntries(Object.entries(icons).map(([size, path]) => [size, api.runtime.getURL(path)]));
  let desired = null;
  let applied = null;
  let running = null;
  let failureIcon = null;
  async function render() {
    while (desired !== applied) {
      const status = desired;
      const notReady = status !== "unlocked";
      let details = { path: normalIcons };
      if (notReady) {
        failureIcon ||= await loadFailureIcon();
        // Recovery may have happened while the bitmap was being decoded.
        if (status !== desired) continue;
        details = { imageData: failureIcon };
      }
      const title = api.i18n.getMessage(titleKeys[status]);
      // Serialize writes so a slow failed-state update cannot overwrite recovery.
      const results = await Promise.allSettled([
        api.action.setIcon(details), api.action.setTitle({ title }),
      ]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
      applied = status;
    }
  }
  return {
    update(state, connecting = false) {
      if (!api.action?.setIcon || !api.action?.setTitle) return Promise.resolve();
      desired = connecting ? "connecting" : state;
      if (!running) {
        let completed = false;
        running = render().then(() => { completed = true; }).catch(() => {
          // A toolbar API failure must never interrupt native messaging or filling.
          console.warn("FAPassword toolbar status could not be updated");
        }).finally(() => {
          running = null;
          if (completed && desired !== applied) this.update(desired);
        });
      }
      return running;
    },
  };
}
