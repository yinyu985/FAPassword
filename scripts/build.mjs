import { cp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const artifactName = `fapassword-${manifest.version}`;
const distDir = join(root, "dist");
const artifactDir = join(distDir, artifactName);

// dist contains exactly one installable directory and nothing else.
await rm(distDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

// Explicit runtime allowlist: source-only protocol/SRP/crypto modules are bundled into
// dist/src/background.js and are not duplicated in the installable extension.
const runtimeFiles = [
  "src/content.js",
  "src/field-policy.js",
  "src/iframe-hosts.js",
  "src/password-generator.js",
  "src/popup.css",
  "src/popup.html",
  "src/popup.js",
  "src/shared.js",
  "LICENSE",
  "NOTICE",
];
for (const relative of runtimeFiles) {
  const destination = join(artifactDir, relative);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(root, relative), destination);
}

await cp(join(root, "_locales"), join(artifactDir, "_locales"), { recursive: true });
await mkdir(join(artifactDir, "icons"));
for (const icon of new Set(Object.values(manifest.icons || {}))) {
  await cp(join(root, icon), join(artifactDir, icon));
}

// Keep the editable source manifest modular. The installable manifest points to the
// single classic worker produced below, at the same unsurprising background.js path.
const installManifest = structuredClone(manifest);
installManifest.background = { service_worker: "src/background.js" };
await writeFile(join(artifactDir, "manifest.json"), `${JSON.stringify(installManifest, null, 2)}\n`);

await build({
  entryPoints: [join(root, "src", "background.js")],
  outfile: join(artifactDir, "src", "background.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome123"],
  charset: "utf8",
  legalComments: "none",
  logLevel: "silent",
  banner: {
    js: "// Built from src/background.js and its local modules. Do not edit this generated copy.",
  },
});

// Normalize timestamps so two builds produce byte-identical runtime files.
const epoch = new Date(Number(process.env.SOURCE_DATE_EPOCH || 946684800) * 1000);
async function normalizeTimes(path) {
  if ((await stat(path)).isDirectory()) {
    for (const entry of await readdir(path)) await normalizeTimes(join(path, entry));
  }
  await utimes(path, epoch, epoch);
}
await normalizeTimes(artifactDir);

console.log(`Extension directory: ${artifactDir}`);
