import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
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
      const ownedDirectory = await mkdtemp(join(tmpdir(), "fapassword-browser-"));
      let context;
      try {
      context = await target.launchPersistentContext(ownedDirectory, {
        ...options,
        ...(options.headless ? { args: [...(options.args || []), "--headless=new"] } : {}),
        ...(executablePath ? { executablePath } : {}),
      });
      const close = context.close.bind(context);
      let closed = false;
      context.close = async () => {
        if (closed) return;
        closed = true;
        try {
          await close();
        } finally {
          await rm(ownedDirectory, { recursive: true, force: true });
        }
      };
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
      const kind = await worker.evaluate(() => globalThis.testNative?.kind);
      if (!kind) throw new Error("Browser regression requires a simulated native transport; refusing a live vault");
      if (kind !== "locked") {
        const popup = await context.newPage();
        await popup.goto(new URL("popup.html", worker.url()).href);
        await popup.locator("#view-pin:not([hidden]) #pin:enabled").waitFor({ state: "visible" });
        await popup.fill("#pin", "123456");
        // Without an active website this section is empty and has zero height.
        // Authentication is complete when it is unhidden, even without account rows.
        await popup.waitForSelector("#view-unlocked:not([hidden])", { state: "attached" });
        await popup.close();
      }
      return context;
      } catch (error) {
        if (context) await context.close();
        await rm(ownedDirectory, { recursive: true, force: true });
        throw error;
      }
    };
  },
});
