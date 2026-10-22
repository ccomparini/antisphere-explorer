// Tests for skins: the skeleton, the rest pose and weights, and the three
// ways of making a model's parts, on the tiny model in gltf-fixture.mjs -
// three joints up glTF's +y, a tube of triangles on each (j2's thin), j0's
// top ring blended 0.6 j0, 0.4 j1. Run with:
//   node --test public/skin.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGLTF } from './gltf.js';
import { fixture, toGLB } from './gltf-fixture.mjs';
import { skinOf, splitByBone, meshParts, spheroidParts, boneParts, fitSpheroid, Y_UP_TO_Z_UP } from './skin.js';

const near = (got, want, what, tol = 1e-6) => {
  [want].flat().forEach((w, i) => assert.ok(Math.abs([got].flat()[i] - w) <= tol, `${what}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`));
};
const skin = async () => skinOf(await readGLTF(toGLB(fixture())));

test('the skeleton: every joint, parents first, its rest in its parent\'s frame, z up in its base', async () => {
  const { skeleton, worldOf } = await skin();
  assert.deepEqual(skeleton.bones.map((b) => [b.name, b.parent]), [['j0', -1], ['j1', 0], ['j2', 1]]);
  near(skeleton.bones[1].translation, [0, 1, 0], 'j1, a unit up its parent\'s (y-up) frame');
  near(skeleton.base.rotation, Y_UP_TO_Z_UP, 'the base: y up turned z up');
  near([worldOf(2)[12], worldOf(2)[13], worldOf(2)[14]], [0, 0, 2], 'j2 in the scene: two up z');
});

test('vertices at rest in scene coordinates, each with its weights, heaviest first', async () => {
  const [prim] = (await skin()).primitives;
  assert.equal(prim.material, 'M_Skin');
  near(prim.points[0], [0.2, 0, 0.1], 'the first vertex: glTF (0.2, 0.1, 0), z up');
  assert.deepEqual(prim.weights[0], [[0, 1]]);
  const blended = prim.weights[32];                          // j0's top ring
  assert.deepEqual(blended.map(([bone]) => bone), [0, 1]);
  near(blended.map(([, w]) => w), [0.6, 0.4], 'blended weights', 1e-6);
  assert.equal(prim.triangles.length, 3 * 64, 'three tubes of 64 triangles');
});

test('splitting among bones: each triangle to its dominant bone; with overlap, to every bone weighing that much', async () => {
  const [prim] = (await skin()).primitives;
  const dominant = splitByBone(prim);
  assert.deepEqual([...dominant].map(([bone, tris]) => [bone, tris.length]), [[0, 64], [1, 64], [2, 64]]);
  const overlapping = splitByBone(prim, { overlap: 0.3 });
  assert.equal(overlapping.get(1).length, 64 + 16, 'j1 also gets the band touching the blended ring');
  assert.equal(overlapping.get(0).length, 64);
  assert.equal(splitByBone(prim, { overlap: 0.5 }).get(1).length, 64, '0.4 is under 0.5');
});

test('mesh parts: each bone\'s triangles a tree, of the source\'s material', async () => {
  const parts = meshParts(await skin());
  assert.deepEqual([...parts.keys()], [0, 1, 2]);
  for (const def of parts.values()) {
    assert.equal(def.material, 'M_Skin');
    assert.ok(def.spheroid || def.sphere, 'a tree, wrapped in its bounding volume');
  }
});

test('spheroid parts: fitted, thin bones folded into their parents, of <prefix>-<material>', async () => {
  const parts = spheroidParts(await skin(), { percentile: 1, prefix: 'robot' });
  assert.deepEqual([...parts.keys()], [0, 1], 'j2, the thin tip, folded into j1');
  const [p0, p1] = [parts.get(0), parts.get(1)];
  assert.equal(p0.material, 'robot-skin');
  near(p0.spheroid.center, [0, 0, 0.5], 'j0\'s, in the scene');
  near(p0.spheroid.axis, [0, 0, 1], 'up');
  near(p0.spheroid.height, 0.8, 'j0\'s height');
  near(p1.spheroid.height, 1.0, 'j1\'s reaches over j2\'s tip: 1.1 to 2.1');
  assert.deepEqual([...spheroidParts(await skin(), { minThickness: 0 }).keys()], [0, 1, 2], 'with 0, every bone its own');
});

test('bone parts: spheroids joint to joint, a ball at the end, needing no geometry', async () => {
  const s = await skin();
  const parts = boneParts({ ...s, primitives: [] }, { prefix: 'stick' });
  near(parts.get(0).spheroid.center, [0, 0, 0.5], 'j0 to j1');
  near(parts.get(0).spheroid.height, 1, 'its length');
  near(parts.get(0).spheroid.radius, 0.1, 'a fifth as thick: radius a tenth');
  near(parts.get(2).sphere.center, [0, 0, 2], 'j2, the end: a ball');
  near(parts.get(2).sphere.radius, 0.5, 'half the bone to it');
  assert.equal(parts.get(1).material, 'stick-bone');
});

test('a spheroid fitted in any frame is the same spheroid', () => {
  const points = Array.from({ length: 101 }, (_, i) => [Math.sin(i * 1.7) * 0.2, i / 100 + 0.03 * Math.cos(i), Math.cos(i * 2.3) * 0.1]);
  const turn = ([x, y, z]) => [-y, x, z];
  const a = fitSpheroid(points), b = fitSpheroid(points.map(turn));
  near(b.height, a.height, 'height', 1e-12);
  near(b.radius, a.radius, 'radius', 1e-12);
  near(b.center, turn(a.center), 'centre', 1e-12);
});
