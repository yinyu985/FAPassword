import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const artifactName = `fapassword-${manifest.version}`;
const distDir = join(root, "dist");
const artifactDir = join(distDir, artifactName);
const zipPath = join(distDir, `${artifactName}.zip`);

await rm(artifactDir, { recursive: true, force: true });
await rm(zipPath, { force: true });
await mkdir(artifactDir, { recursive: true });

for (const entry of ["manifest.json", "src", "icons", "fonts", "LICENSE", "NOTICE"]) {
  await cp(join(root, entry), join(artifactDir, entry), { recursive: true });
}

execFileSync("zip", ["-qr", zipPath, artifactName], {
  cwd: distDir,
  stdio: "inherit",
});

console.log(`Extension directory: ${artifactDir}`);
console.log(`ZIP package: ${zipPath}`);
