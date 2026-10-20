// Tests for the glTF reader, on a tiny model built in code (gltf-fixture.mjs).
// Run with:
//   node --test gltf.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGLTF, sample, clipRange, transformPoint } from './gltf.js';
import { fixture, toGLB, toGLTFText } from './gltf-fixture.mjs';

const near = (got, want, what, tol = 1e-6) => {
  [want].flat().forEach((w, i) => assert.ok(Math.abs([got].flat()[i] - w) <= tol, `${what}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`));
};

test('a .glb: nodes, parents, and accessors - strided, and normalized integers as floats', async () => {
  const f = fixture();
  const g = await readGLTF(toGLB(f));
  assert.deepEqual(g.nodes.map((n) => n.name), ['j0', 'j1', 'j2', 'body', 'Armature']);
  assert.deepEqual(g.parents, [4, 0, 1, 4, -1]);
  const pos = g.accessor(0);
  assert.equal(pos.size, 3);
  assert.equal(pos.length, f.positions.length * 3);
  near(Array.from(pos.slice(3, 6)), f.positions[1], 'the second position, past the first one\'s padding');
  const weights = g.accessor(2);
  assert.ok(weights instanceof Float32Array, 'normalized bytes come back as floats');
  near(Array.from(weights.slice(0, 4)), [1, 0, 0, 0], 'weights');
  assert.ok(g.accessor(1) instanceof Uint8Array, 'joint indices stay integers');
  assert.equal(g.accessor(3).length, 48, 'three MAT4s');
});

test('world matrices compose each node\'s own transform down from the root', async () => {
  const g = await readGLTF(toGLB(fixture()));
  near(transformPoint(g.worldMatrices()[2], [0, 0, 0]), [0, 2, 0], 'j2 at rest');
  // j1 turned 90 degrees about z: j2, one up from j1, swings to -x.
  const s = Math.SQRT1_2;
  const world = g.worldMatrices((i) => (i === 1 ? { ...g.rest(1), rotation: [0, 0, s, s] } : g.rest(i)));
  near(transformPoint(world[2], [0, 0, 0]), [-1, 1, 0], 'j2, j1 bent');
});

test('sample(): LINEAR slerps, STEP holds, CUBICSPLINE follows its tangents, and time is clamped', async () => {
  const g = await readGLTF(toGLB(fixture()));
  const bend = g.json.animations[0];
  assert.deepEqual(clipRange(g, bend), [0, 1]);
  const at = (t) => sample(g, bend, t);
  const half = Math.sin(Math.PI / 8);
  near(at(0.5).get(1).rotation, [0, 0, half, Math.cos(Math.PI / 8)], 'j1 halfway: 45 degrees');
  near(at(1).get(1).rotation, [0, 0, Math.SQRT1_2, Math.SQRT1_2], 'j1 at the end');
  near(at(0.5).get(0).translation, [0, 0, 0], 'STEP holds the first key until the second');
  near(at(1).get(0).translation, [1, 0, 0], 'and then the second');
  // Hermite in y, p0 = 1, p1 = 2, m0 = 2, m1 = 0, at u = 1/2, where the
  // basis is h00 = 1/2, h10 = 1/8, h01 = 1/2: 1/2 + 2/8 + 2/2 = 1.75.
  near(at(0.5).get(2).translation, [0, 1.75, 0], 'CUBICSPLINE halfway');
  near(at(0).get(2).translation, [0, 1, 0], 'CUBICSPLINE at a key: its value');
  near(at(5).get(1).rotation, at(1).get(1).rotation, 'after the end: the end');
  near(at(-1).get(0).translation, [0, 0, 0], 'before the start: the start');
  assert.deepEqual(at(0.5).get(1).translation, [0, 1, 0], 'what a node\'s channels don\'t drive stays at its rest');
  assert.equal(at(0.5).has(3), false, 'nodes the clip doesn\'t move aren\'t in it');
});

test('a .gltf with its buffer in a data: URI reads the same', async () => {
  const f = fixture();
  const a = await readGLTF(toGLB(f)), b = await readGLTF(toGLTFText(f));
  assert.deepEqual(Array.from(b.accessor(0)), Array.from(a.accessor(0)));
  assert.deepEqual(sample(b, b.json.animations[0], 0.3).get(1), sample(a, a.json.animations[0], 0.3).get(1));
  // A buffer in a file beside it, read through readBytes.
  const c = await readGLTF(JSON.stringify({ ...f.json, buffers: [{ byteLength: f.bin.length, uri: 'model%20data.bin' }] }),
                           { base: 'models/model.gltf', readBytes: async (p) => { assert.equal(p, 'models/model data.bin'); return f.bin; } });
  assert.deepEqual(Array.from(c.accessor(0)), Array.from(a.accessor(0)));
});

test('what it can\'t read, it says', async () => {
  const f = fixture();
  await assert.rejects(readGLTF(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), /neither a \.glb.*nor \.gltf JSON/);
  await assert.rejects(readGLTF(toGLB({ ...f, json: { ...f.json, asset: { version: '1.0' } } })), /version 1\.0; only 2\.x/);
  await assert.rejects(readGLTF(toGLB({ ...f, json: { ...f.json, extensionsRequired: ['KHR_draco_mesh_compression'] } })),
                       /requires extensions this reader lacks: KHR_draco_mesh_compression/);
  const sparse = structuredClone(f.json);
  sparse.accessors[0].sparse = { count: 1 };
  const g = await readGLTF(toGLB({ ...f, json: sparse }));
  assert.throws(() => g.accessor(0), /accessor 0 is sparse/);
  await assert.rejects(readGLTF(JSON.stringify({ ...f.json, buffers: [{ byteLength: 4, uri: 'x.bin' }] })), /give readBytes/);
});
