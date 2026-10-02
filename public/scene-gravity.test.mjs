// Tests for a scene's gravity and spawn point, as the scene compiler reads
// them (scene-format.md). Run with:
//   node --test public/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene } from './antisphere-scene.js';

const scene = (extra) => ({ lights: [], root: { sphere: { center: [0, 0, 0], radius: 1 } }, ...extra });

test('gravity is uniform, 9.81 down -Z, when a scene names none', () => {
  assert.deepEqual(compileScene(scene({})).gravity, { kind: 'uniform', down: [0, 0, -1], strength: 9.81 });
});

test('uniform gravity: down need not be unit length', () => {
  const { gravity } = compileScene(scene({ gravity: { down: [0, -3, 0], strength: 1.62 } }));
  assert.deepEqual(gravity, { kind: 'uniform', down: [0, -1, 0], strength: 1.62 });
});

test('central gravity: strength at radius, so gm = strength radius^2', () => {
  const { gravity } = compileScene(scene({ gravity: { center: [1, 2, 3], strength: 9.81, radius: 500 } }));
  assert.equal(gravity.kind, 'central');
  assert.deepEqual(gravity.center, [1, 2, 3]);
  assert.equal(gravity.gm, 9.81 * 500 * 500);
});

test('bad gravity is refused, saying where', () => {
  for (const [gravity, where] of [
    [{ down: [0, 0, -1] }, /gravity\.strength/],
    [{ down: [0, 0, 0], strength: 1 }, /gravity\.down/],
    [{ down: [0, 0, -1], center: [0, 0, 0], strength: 1, radius: 1 }, /one of "down".*or "center"/],
    [{ strength: 1 }, /one of "down".*or "center"/],
    [{ center: [0, 0], strength: 1, radius: 1 }, /gravity\.center/],
    [{ center: [0, 0, 0], strength: 1 }, /gravity\.radius/],
    [{ down: [0, 0, -1], strength: -2 }, /gravity\.strength/],
  ]) assert.throws(() => compileScene(scene({ gravity })), where, JSON.stringify(gravity));
});

test('spawn: where and facing, facing +X by default; none if absent', () => {
  assert.equal(compileScene(scene({})).spawn, null);
  assert.deepEqual(compileScene(scene({ spawn: { at: [1, 2, 3] } })).spawn, { at: [1, 2, 3], facing: [1, 0, 0] });
  assert.deepEqual(compileScene(scene({ spawn: { at: [0, 0, 0], facing: [0, 1, 0] } })).spawn.facing, [0, 1, 0]);
  assert.throws(() => compileScene(scene({ spawn: { facing: [1, 0, 0] } })), /spawn\.at/);
  assert.throws(() => compileScene(scene({ spawn: { at: [0, 0, 0], facing: [0, 0, 0] } })), /spawn\.facing/);
});
