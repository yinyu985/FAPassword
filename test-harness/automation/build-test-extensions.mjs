import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { checkBackground } from "../../scripts/bundle-background.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const out = join(here, ".builds");
const source = process.env.FAPASSWORD_BUILD_SOURCE || root;
if (source === root) await checkBackground(root);
await rm(out, { recursive: true, force: true });
for (const kind of ["unlocked", "multi", "locked", "privacy"]) {
  const destination = join(out, kind);
  await mkdir(destination, { recursive: true });
  for (const item of ["manifest.json", "src", "icons", "_locales"]) await cp(join(source, item), join(destination, item), { recursive: true });
  const mock = (await readFile(join(here, "mock-native.js"), "utf8")).replace("__FAPASSWORD_MOCK_KIND__", kind);
  const manifest = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));
  if (manifest.background.type) throw new Error("Browser regressions require the actual classic worker entry");
  const worker = manifest.background.service_worker.replace(/^src\//, "");
  await build({ stdin: { contents: mock, resolveDir: here }, outfile: join(destination, "src/test-worker.js"),
    bundle: true, format: "iife", platform: "browser", target: "chrome123", footer: { js: `importScripts(${JSON.stringify(worker)});` } });
  manifest.background = { service_worker: "src/test-worker.js" };
  await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (kind !== "privacy") {
    const path = join(destination, "src/content.js");
    const source = (await readFile(path, "utf8"))
      .replace('attachShadow({ mode: "closed" })', 'attachShadow({ mode: "open" })')
      .replace('box.setAttribute("role", "listbox");', 'box.setAttribute("role", "listbox"); box.setAttribute("data-fapassword", "suggestions");');
    await writeFile(path, source);
  }
}
console.log("Built test extensions: production worker with simulated native transport.");
