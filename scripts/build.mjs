import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { backgroundPath, compileBackground, languagePath, compileLanguage } from "./bundle-background.mjs";
import { verifyArtifact, writeAtomic } from "./build-files.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const artifactName = `fapassword-${manifest.version}`;
const distDir = join(root, "dist");
const artifactDir = join(distDir, artifactName);

const epoch = new Date(Number(process.env.SOURCE_DATE_EPOCH || 946684800) * 1000);
if (!Number.isFinite(epoch.getTime())) throw new Error("Invalid SOURCE_DATE_EPOCH");
// Prepare every byte first. A failed build must leave the last working worker intact.
const bundle = await compileBackground(root);
const language = await compileLanguage(root);
const files = new Map([[languagePath, language]]);

// Explicit runtime allowlist: source-only protocol/SRP/crypto modules are bundled into
// dist/src/background.js and are not duplicated in the installable extension.
const runtimeFiles = [
  "src/content.js",
  "src/page-policy.js",
  "src/field-policy.js",
  "src/iframe-hosts.js",
  "src/password-generator.js",
  "src/passwords-launch.js",
  "src/popup.css",
  "src/popup.html",
  "src/popup.js",
  "src/shared.js",
  "LICENSE",
  "NOTICE",
  "_locales/en/messages.json",
  "_locales/zh_CN/messages.json",
];
for (const relative of runtimeFiles) {
  files.set(relative, await readFile(join(root, relative)));
}

for (const icon of new Set(Object.values(manifest.icons || {}))) {
  files.set(icon, await readFile(join(root, icon)));
}

// Retain dist's existing entry path for browsers that already loaded it. Root and dist
// execute identical classic worker bytes; neither fetches source modules at startup.
files.set("src/background.js", bundle);
const installManifest = structuredClone(manifest);
installManifest.background = { service_worker: "src/background.js" };
files.set("manifest.json", Buffer.from(JSON.stringify(installManifest, null, 2) + "\n"));

await verifyArtifact(artifactDir, files.keys(), { allowMissing: true });
await writeAtomic(join(root, languagePath), language);
await writeAtomic(join(root, backgroundPath), bundle);
// Same-directory rename exposes either a complete old file or a complete new file.
// Never delete a loaded directory. Publish the manifest last; keep older versions usable.
for (const [path, bytes] of files) await writeAtomic(join(artifactDir, path), bytes, epoch);

await verifyArtifact(artifactDir, files.keys());
console.log(`Extension directory: ${artifactDir}`);
