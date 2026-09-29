import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rename, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { backgroundPath, checkBackground, compileBackground } from "../../scripts/bundle-background.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), "fapassword-build-test-"));
const runBuild = () => new Promise(resolve => {
  const child = spawn(process.execPath, [join(fixture, "scripts/build.mjs")], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => output += data); child.stderr.on("data", data => output += data);
  child.on("error", error => resolve({ code: -1, output: error.message }));
  child.on("close", code => resolve({ code, output }));
});
try {
  for (const path of ["scripts", "src", "icons", "_locales", "manifest.json", "package.json", "LICENSE", "NOTICE"]) {
    await cp(join(root, path), join(fixture, path), { recursive: true });
  }
  await symlink(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
  assert.equal((await runBuild()).code, 0);
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  const dist = join(fixture, "dist", `fapassword-${manifest.version}`);
  const paths = [join(fixture, backgroundPath), join(dist, "src/background.js"), join(dist, "manifest.json")];
  const before = await Promise.all(paths.map(path => readFile(path)));
  const timestamps = await Promise.all(paths.map(path => stat(path)));
  assert.equal((await runBuild()).code, 0);
  for (let i = 0; i < paths.length; i++) {
    const current = await stat(paths[i]);
    assert.equal(current.ino, timestamps[i].ino); assert.equal(current.mtimeMs, timestamps[i].mtimeMs);
    assert.deepEqual(await readFile(paths[i]), before[i]);
  }
  console.log("PASS no-op builds leave installed worker files and timestamps untouched");

  const source = join(fixture, "src/background.js");
  await writeFile(source, (await readFile(source, "utf8")) + '\nglobalThis.buildFixtureRevision = "updated";\n');
  await assert.rejects(checkBackground(fixture), /stale/);
  console.log("PASS checks reject an out-of-date root worker bundle");
  const next = Buffer.from(await compileBackground(fixture));
  let done = false, reads = 0;
  const building = runBuild().finally(() => done = true);
  while (!done) {
    const values = await Promise.all(paths.map(path => readFile(path)));
    for (let i = 0; i < values.length; i++) {
      assert.ok(values[i].equals(before[i]) || (i < 2 && values[i].equals(next)), "a reader must see a complete old or new file");
    }
    reads++;
  }
  assert.equal((await building).code, 0); assert.ok(reads > 0);
  assert.deepEqual(await readFile(paths[0]), next); assert.deepEqual(await readFile(paths[1]), next);
  await checkBackground(fixture);
  console.log(`PASS rebuilding never exposes missing or truncated scripts (${reads} concurrent read rounds)`);

  const protocol = join(fixture, "src/protocol.js");
  await rename(protocol, protocol + ".missing");
  const failed = await runBuild(); assert.notEqual(failed.code, 0);
  assert.deepEqual(await readFile(paths[0]), next); assert.deepEqual(await readFile(paths[1]), next);
  assert.deepEqual(await readFile(paths[2]), before[2]);
  await rename(protocol + ".missing", protocol);
  console.log("PASS a compilation failure preserves the last loadable root and dist workers");

  const previous = join(fixture, "dist/fapassword-previous");
  await mkdir(previous); await writeFile(join(previous, "keep.txt"), "loaded by another profile");
  assert.equal((await runBuild()).code, 0);
  assert.equal(await readFile(join(previous, "keep.txt"), "utf8"), "loaded by another profile");
  console.log("PASS rebuilding preserves other installed version directories");
} finally { await rm(fixture, { recursive: true, force: true }); }
