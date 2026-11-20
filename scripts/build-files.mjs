import { lstat, mkdir, readdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

// Do not delete stale files: a browser may still be using this directory.
export async function verifyArtifact(directory, allowed, { allowMissing = false } = {}) {
  const missing = new Set(allowed);
  const dirs = new Set(["."]);
  for (const path of missing) for (let d = dirname(path); d !== "."; d = dirname(d)) dirs.add(d);
  async function visit(relative) {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory() && dirs.has(path)) await visit(path);
      else if (!entry.isFile() || !missing.delete(path)) throw new Error(`Unexpected build entry: ${join(directory, path)}. Move it out before rebuilding.`);
    }
  }
  try { if (!(await lstat(directory)).isDirectory()) throw new Error(`Not a build directory: ${directory}`); }
  catch (error) { if (allowMissing && error.code === "ENOENT") return; throw error; }
  await visit(".");
  if (!allowMissing && missing.size) throw new Error(`Missing build entries: ${[...missing].join(", ")}`);
}

// A browser may read any installed file during a rebuild. Never truncate or unlink it.
// Unchanged files retain their inode and timestamps.
export async function writeAtomic(path, bytes, timestamp) {
  try { if ((await readFile(path)).equals(Buffer.from(bytes))) return false; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    if (timestamp) await utimes(temporary, timestamp, timestamp);
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return true;
}
