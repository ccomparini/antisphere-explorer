// Tests for the animation importer, on the tiny model in
// public/gltf-fixture.mjs: its one clip, "Bend", turns j1 (LINEAR), steps
// j0 (STEP) and moves j2 (CUBICSPLINE). Run with:
//   node --test tools/import-animations.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGLTF } from '../public/gltf.js';
import { fixture, toGLB } from '../public/gltf-fixture.mjs';
import { clipsFromGLTF } from './import-animations.mjs';

const script = fileURLToPath(new URL('./import-animations.mjs', import.meta.url));
const clipsOf = async (options = {}) => clipsFromGLTF(await readGLTF(toGLB(fixture())), options);

test('each clip by bone name, every bone it moves - even one a model might fold away - with its own keys and mode', async () => {
  const { Bend } = await clipsOf();
  assert.equal(Bend.duration, 1);
  assert.equal(Bend.loop, undefined, 'not named _Loop: plays once');
  assert.deepEqual(Object.keys(Bend.channels).sort(), ['j0', 'j1', 'j2'], 'j2, thin, kept: a clip doesn\'t know the model');
  assert.deepEqual(Bend.channels.j1.rotation.times, [0, 1]);
  assert.equal(Bend.channels.j1.rotation.interpolation, undefined, 'linear: the default, not written');
  assert.equal(Bend.channels.j0.translation.interpolation, 'step');
  assert.equal(Bend.channels.j2.translation.interpolation, 'cubic');
  assert.equal(Bend.channels.j2.translation.values[0].length, 3, 'cubic keys: in-tangent, value, out-tangent');
});

test('reduction and resampling', async () => {
  assert.deepEqual((await clipsOf({ fps: 30 })).Bend.channels.j1.rotation.times, [0, 1], 'a resampled slerp reduces to its ends');
  assert.equal((await clipsOf({ fps: 30, rotationTolerance: 0 })).Bend.channels.j1.rotation.times.length, 31);
  assert.equal((await clipsOf({ fps: 30 })).Bend.channels.j2.translation.interpolation, undefined, 'resampled, linear');
  await assert.rejects(clipsOf({ clips: ['Dance'] }), /no animation "Dance"/);
});

test('from the command line: clips alone, no skeleton; how they were made recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-animations-'));
  try {
    writeFileSync(join(dir, 'chain.glb'), toGLB(fixture()));
    const run = (...args) => spawnSync('node', [script, 'chain.glb', ...args], { cwd: dir, encoding: 'utf8' });
    const ok = run('-o', 'anim.json');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stderr, /1 clips, moving 3 bones/);
    const out = JSON.parse(readFileSync(join(dir, 'anim.json'), 'utf8'));
    assert.deepEqual(Object.keys(out), ['_meta', 'clips']);
    assert.deepEqual(out._meta.generatedBy.slice(2), ['chain.glb', '-o', 'anim.json']);
    assert.match(run('--clips', 'Dance').stderr, /import-animations: no animation "Dance"/);
    assert.match(run('--fps', '0').stderr, /--fps needs a positive number/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
