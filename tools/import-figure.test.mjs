// Tests for the figure importer, on the tiny model in public/gltf-fixture.mjs:
// three joints up +y, rings of points on the first two, a thin tip on the
// third, and a clip that bends the middle joint 90 degrees and steps the
// whole one to +x. Run with:
//   node --test tools/import-figure.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGLTF } from '../public/gltf.js';
import { fixture, toGLB } from '../public/gltf-fixture.mjs';
import { poseFigure } from '../public/figure.js';
import { compileScene } from '../public/antisphere-scene.js';
import { figureFromGLTF, fitSpheroid } from './import-figure.mjs';

const script = fileURLToPath(new URL('./import-figure.mjs', import.meta.url));
const near = (got, want, what, tol = 1e-5) => {
  [want].flat().forEach((w, i) => assert.ok(Math.abs([got].flat()[i] - w) <= tol, `${what}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`));
};
const figureOf = async (options = {}) => figureFromGLTF(await readGLTF(toGLB(fixture())), { percentile: 1, ...options });
const centreOf = (object, i) => object.group[i].spheroid.center;

test('a spheroid fitted to a cylinder of points: along it, round it', () => {
  const points = [];
  for (let i = 0; i <= 10; i++) for (let a = 0; a < 12; a++) points.push([3 + 0.5 * Math.cos(a * Math.PI / 6), 1 + 0.5 * Math.sin(a * Math.PI / 6), -1 + 0.2 * i]);
  const s = fitSpheroid(points, 1);
  near(s.axis, [0, 0, 1], 'axis');
  near(s.center, [3, 1, 0], 'centre');
  near(s.height, 2, 'height');
  near(s.radius, 0.5, 'radius');
});

test('a part per bone, in the bone\'s frame; a bone too thin gives its points to its parent', async () => {
  const figure = await figureOf();
  assert.deepEqual(figure.skeleton.map((b) => b.name), ['j0', 'j1'], 'j2, the thin tip, is folded into j1, and has no part');
  assert.deepEqual(figure.parts.map((p) => [p.bone, p.material]), [['j0', 'figure-skin'], ['j1', 'figure-skin']]);
  const [p0, p1] = figure.parts.map((p) => p.spheroid);
  near(p0.center, [0, 0.5, 0], 'j0\'s part, in j0\'s frame');
  near(p0.axis, [0, 1, 0], 'along the bone');
  near(p0.height, 0.8, 'j0\'s part\'s height');
  near(p0.radius, 0.2, 'radius');
  near(p1.height, 1.0, 'j1\'s part reaches over j2\'s tip: 1.1 to 2.1');
  const all = await figureOf({ minThickness: 0 });
  assert.deepEqual(all.parts.map((p) => p.bone), ['j0', 'j1', 'j2'], 'with --min-thickness 0, every bone keeps its own');
  assert.deepEqual((await figureOf({ prefix: 'robot' })).parts[0].material, 'robot-skin');
});

test('posed: y up becomes z up, and the clip bends and moves it', async () => {
  const figure = await figureOf();
  near(figure.base.rotation, [Math.SQRT1_2, 0, 0, Math.SQRT1_2], 'the base turns y up to z up');
  const rest = poseFigure(figure);
  near(centreOf(rest, 0), [0, 0, 0.5], 'j0\'s part, half a unit up');
  near(centreOf(rest, 1), [0, 0, 1.6], 'j1\'s, above it');
  near(rest.group[1].spheroid.axis, [0, 0, 1], 'upright');
  // At the end of Bend: j1 turned 90 degrees about glTF's z (the scene's -y),
  // so its part points to -x from j1; and the whole stepped to +1 x.
  const bent = poseFigure(figure, 'Bend', 1);
  near(centreOf(bent, 0), [1, 0, 0.5], 'j0\'s part, stepped');
  near(centreOf(bent, 1), [1 - 0.6, 0, 1], 'j1\'s, bent over');
  near(bent.group[1].spheroid.axis.map(Math.abs), [1, 0, 0], 'lying along x');
  near(centreOf(poseFigure(figure, 'Bend', 0.5), 0), [0, 0, 0.5], 'halfway: the STEP not taken yet');
  // The source's own keys, its own interpolation kept: only the bones the clip
  // moves, only the properties it changes.
  const bend = figure.clips.Bend;
  assert.equal(bend.duration, 1);
  assert.equal(bend.loop, undefined, 'not named _Loop: plays once');
  assert.deepEqual(Object.keys(bend.channels).sort(), ['j0', 'j1']);
  assert.deepEqual(Object.keys(bend.channels.j1), ['rotation']);
  assert.deepEqual(bend.channels.j1.rotation.times, [0, 1], 'two keys: linear, the default, not written');
  assert.equal(bend.channels.j1.rotation.interpolation, undefined);
  assert.deepEqual(Object.keys(bend.channels.j0), ['translation']);
  assert.equal(bend.channels.j0.translation.interpolation, 'step', 'STEP kept');
  // Resampled at 30 fps, a slerp reduces back to its two keys.
  const resampled = await figureOf({ fps: 30 });
  assert.deepEqual(resampled.clips.Bend.channels.j1.rotation.times, [0, 1]);
  const kept = await figureOf({ fps: 30, rotationTolerance: 0 });
  assert.equal(kept.clips.Bend.channels.j1.rotation.times.length, 31, 'tolerance 0: every resampled key');
  // An unknown clip plays on, warned of once, at rest.
  const warned = [];
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(poseFigure(figure, 'Dance', 0.5, { warn: (msg) => warned.push(msg) }), rest);
  }
  assert.deepEqual(warned, ['figure: no clip "Dance" (has Bend): at rest']);
  const built = compileScene({ materials: { 'figure-skin': {} }, lights: [], root: bent });
  assert.ok(built.nodes.length > 2, 'the posed object compiles');
});

test('from the command line: a figure written, its object posed, how it was made recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-figure-'));
  try {
    writeFileSync(join(dir, 'model.glb'), toGLB(fixture()));
    const run = (...args) => spawnSync('node', [script, 'model.glb', ...args], { cwd: dir, encoding: 'utf8' });
    const ok = run('-o', 'figure.json', '--pose', 'Bend@1');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stderr, /2 bones, 2 parts \(figure-skin\), 1 clips/);
    const figure = JSON.parse(readFileSync(join(dir, 'figure.json'), 'utf8'));
    assert.deepEqual(figure._meta.generatedBy.slice(2), ['model.glb', '-o', 'figure.json', '--pose', 'Bend@1']);
    assert.match(figure._meta.generatedBy[1], /import-figure\.mjs$/);
    assert.equal(figure._meta.source, 'model.glb');
    assert.deepEqual(Object.keys(figure.objects), ['figure'], 'named for its file');
    near(centreOf(figure.objects.figure, 1), [0.4, 0, 1], 'the object, posed as asked', 1e-4);
    // Placed in a scene by reference, as a part.
    writeFileSync(join(dir, 'scene.json'), JSON.stringify({ materials: { 'figure-skin': {} }, lights: [],
                                                             root: { use: '@figure.json#/objects/figure' } }));
    const scene = JSON.parse(readFileSync(join(dir, 'scene.json'), 'utf8'));
    const built = compileScene(scene, { files: { [join(dir, 'figure.json')]: figure }, path: join(dir, 'scene.json') });
    assert.ok(built.nodes.length > 2, 'a scene places it by reference');
    const named = run('-o', 'walker.json.gz', '--name', 'bob');
    assert.equal(named.status, 0, named.stderr);
    assert.match(named.stderr, /posed as objects\.bob/);
    assert.match(run('--name', 'a/b').stderr, /--name "a\/b": a name, with no/);
    assert.match(spawnSync('node', [script, 'model.glb'], { cwd: dir, encoding: 'utf8' }).stdout, /"objects":\{"figure":/, 'on stdout, "figure"');
    assert.match(run('--clips', 'Dance').stderr, /import-figure: no animation "Dance"/);
    assert.match(run('--pose', 'Dance@1').stderr, /import-figure: --pose Dance@1: no clip "Dance" \(has Bend\)/);
    assert.match(run('--min-thickness=-1').stderr, /--min-thickness needs a number, 0 or more/);
    assert.match(run('--pose', 'Bend@soon').stderr, /--pose Bend@soon: the time after @ needs to be a number/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
