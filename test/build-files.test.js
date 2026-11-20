import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyArtifact } from '../scripts/build-files.mjs';

test('a dirty same-version directory is rejected without deleting unexpected files', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'fap-build-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dir = join(temp, 'dist'), allowed = ['manifest.json', 'src/worker.js'];
  await verifyArtifact(dir, allowed, { allowMissing: true });
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), '{}');
  await assert.rejects(verifyArtifact(dir, allowed), /Missing build entries/);
  await writeFile(join(dir, 'src/worker.js'), '// fixture');
  await verifyArtifact(dir, allowed);
  const stale = join(dir, 'src/removed.js'); await writeFile(stale, '// stale');
  await assert.rejects(verifyArtifact(dir, allowed, { allowMissing: true }), /Unexpected build entry/);
  assert.equal(await readFile(stale, 'utf8'), '// stale');
});
