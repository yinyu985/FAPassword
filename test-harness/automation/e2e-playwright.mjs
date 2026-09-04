import { rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { tmpdir } from "node:os";

const configured = process.env.FAPASSWORD_PLAYWRIGHT;

let module;
try {
  module = configured ? await import(configured) : await import("playwright");
} catch {
  throw new Error(
    "Playwright is not installed. Browser tests never download it automatically; set " +
      "FAPASSWORD_PLAYWRIGHT to an existing playwright/index.js, or install it explicitly.",
  );
}

const rawChromium = (module.default || module).chromium;
export const chromium = new Proxy(rawChromium, {
  get(target, property) {
    if (property !== "launchPersistentContext") return Reflect.get(target, property);
    return async (userDataDir, options = {}) => {
      const executablePath = process.env.FAPASSWORD_BROWSER_EXECUTABLE;
      const context = await target.launchPersistentContext(userDataDir, {
        ...options,
        ...(executablePath ? { executablePath } : {}),
      });
      const close = context.close.bind(context);
      context.close = async () => {
        try {
          await close();
        } finally {
          const path = resolve(userDataDir);
          const safePrefix = ["op-", "fapassword-"].some((prefix) => basename(path).startsWith(prefix));
          if (safePrefix && path.startsWith(resolve(tmpdir()) + "/")) await rm(path, { recursive: true, force: true });
        }
      };
      return context;
    };
  },
});
