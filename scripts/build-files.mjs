import { mkdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";

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
