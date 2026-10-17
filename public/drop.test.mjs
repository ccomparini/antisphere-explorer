// Tests for "drop": an object moved along the scene's gravity until it
// touches something solid. Run with:
//   node --test drop.test.mjs
//
// Where things land is read off the compiled nodes: a sphere's centre, a
// slab's two planes along its axis.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene } from './antisphere-scene.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const MATERIALS = {
  stone: { albedo: [0.6, 0.6, 0.6] },
  water: { iorWater: true, solid: false, albedo: [0.6, 0.8, 0.9] },
};
const scene = (root, extra = {}) => ({ materials: MATERIALS, lights: [], root, ...extra });
const floor = (outside) => ({ plane: { normal: [0, 0, 1], offset: 0 }, material: 'stone', outside });
const ball = (center, radius = 0.5, extra = {}) => ({ sphere: { center, radius }, material: 'stone', ...extra });
const slabZ = (z0, z1) => ({ slab: { center: [0, 0, (z0 + z1) / 2], axis: [0, 0, 1], thickness: z1 - z0 } });
const column = (extra = {}) => ({ intersection: [
  { cylinder: { center: [0, 0, 0], axis: [0, 0, 1], radius: 0.5 }, material: 'stone' }, slabZ(0, 3)], ...extra });
const box = (extra = {}) => ({ intersection: [
  { slab: { center: [0, 0, 0], axis: [1, 0, 0], thickness: 2 }, material: 'stone' },
  { slab: { center: [0, 0, 0], axis: [0, 1, 0], thickness: 2 }, material: 'stone' },
  { ...slabZ(0, 1), material: 'stone' }], ...extra });

/** Every sphere's centre and radius, in node order. */
const spheres = (built) => built.nodes.slice(1)
  .filter((n) => n.prim.k_par > 0 && Math.abs(n.prim.k_par - n.prim.k_perp) < 1e-12)
  .map((n) => {
    const k = n.prim.k_perp, c = n.prim.linear.map((v) => -v / k);
    return { c, r: Math.sqrt(dot(c, c) - n.prim.constant / k) };
  });
/** Every slab along z, as [z0, z1]. */
const zSlabs = (built) => built.nodes.slice(1)
  .filter((n) => n.prim.k_perp === 0 && n.prim.k_par > 0 && Math.abs(Math.abs(n.prim.axis[2]) - 1) < 1e-12)
  .map((n) => {
    const s = Math.sign(n.prim.axis[2]), k = n.prim.k_par, c = n.prim.linear[2] * s, d = n.prim.constant;
    const q = Math.sqrt(c * c - k * d);
    return [(-c - q) / k, (-c + q) / k];
  });
const near = (got, want, what, tol = 1e-5) => assert.ok(Math.abs(got - want) <= tol, `${what}: ${got}, not ${want}`);
const quietly = (fn) => {
  const warned = [], warn = console.warn;
  console.warn = (msg) => warned.push(msg);
  try { return { result: fn(), warned }; } finally { console.warn = warn; }
};

test('a column dropped onto a floor stands on it, where it was across', () => {
  const built = compileScene(scene(floor({ group: [column({ translate: [1, 2, 5], drop: true })] })));
  const [z0, z1] = zSlabs(built).find(([a, b]) => b - a > 2.9);
  near(z0, 0, 'its base');
  near(z1, 3, 'its top');
  const cyl = built.nodes.find((n) => n?.prim && n.prim.k_par === 0 && n.prim.k_perp > 0);
  const centre = cyl.prim.linear.map((v) => -v / cyl.prim.k_perp);
  near(centre[0], 1, 'x'); near(centre[1], 2, 'y');
});

test('a ball dropped onto a box rests on its top', () => {
  const built = compileScene(scene(floor({ group: [box(), ball([0.3, -0.2, 6], 0.5, { drop: true })] })));
  const [s] = spheres(built);
  near(s.c[2], 1.5, 'its centre'); near(s.c[0], 0.3, 'x'); near(s.c[1], -0.2, 'y');
});

test('drops settle in order: each lands on the ones before it', () => {
  // A box, then a ball over it: the box lands on the floor, the ball on the box.
  const boxFirst = compileScene(scene(floor({ group: [
    box({ translate: [0, 0, 4], drop: true }), ball([0, 0, 8], 0.5, { drop: true })] })));
  near(zSlabs(boxFirst).find(([a, b]) => Math.abs(b - a - 1) < 1e-6)[0], 0, 'the box, on the floor');
  near(spheres(boxFirst)[0].c[2], 1.5, 'the ball, on the box');
  // The ball first: it lands on the floor, and the box then on the ball.
  const ballFirst = compileScene(scene(floor({ group: [
    ball([0, 0, 2], 0.5, { drop: true }), box({ translate: [0, 0, 4], drop: true })] })));
  near(spheres(ballFirst)[0].c[2], 0.5, 'the ball, on the floor');
  near(zSlabs(ballFirst).find(([a, b]) => Math.abs(b - a - 1) < 1e-6)[0], 1, 'the box, on the ball');
});

test('under central gravity, a ball falls to the planet along the line to its centre', () => {
  const planet = { sphere: { center: [0, 0, 0], radius: 10 }, material: 'stone' };
  const built = compileScene(scene({ group: [planet, ball([3, 4, 20], 1, { drop: true })] },
                                   { gravity: { center: [0, 0, 0], radius: 10, strength: 9.81 } }));
  const s = spheres(built).find((x) => Math.abs(x.r - 1) < 1e-6);
  const len = Math.hypot(3, 4, 20);
  [3, 4, 20].forEach((v, i) => near(s.c[i], (11 * v) / len, `centre ${i}`));
});

test('starting inside, it rises out; where it can\'t, or nothing is below, it stays and warns', () => {
  const sunk = compileScene(scene(floor({ group: [column({ translate: [0, 0, -1], drop: true })] })));
  near(zSlabs(sunk).find(([a, b]) => b - a > 2.9)[0], 0, 'a column sunk into the floor, raised onto it');

  const pipe = { cylinder: { center: [0, 0, 0], axis: [0, 0, 1], radius: 5 }, material: 'stone' };
  const trapped = quietly(() => compileScene(scene({ group: [ball([0, 0, 3], 0.5, { drop: true }), pipe] })));
  assert.match(trapped.warned.join('\n'), /drop: starts inside something it can't rise out of within 10 units/);
  near(spheres(trapped.result)[0].c[2], 3, 'left where it was');

  const alone = quietly(() => compileScene(scene({ group: [box(), ball([5, 5, 3], 0.5, { drop: true })] })));
  assert.match(alone.warned.join('\n'), /drop: nothing within 10 units below it/);
  near(spheres(alone.result)[0].c[2], 3, 'left where it was');
});

test('it falls through what isn\'t solid: water, onto the floor under it', () => {
  const pool = { ...slabZ(0, 2), material: 'water' };
  // (The ball first in the group: where members overlap the earlier one's
  // claim stands, and the water would hide a ball landing inside it.)
  const built = compileScene(scene(floor({ group: [ball([0, 0, 5], 0.5, { drop: true }), pool] })));
  near(spheres(built)[0].c[2], 0.5, 'on the floor, under the water');
});

test('a dropped object\'s wrap and bounds go with it', () => {
  const built = compileScene(scene(floor({ group: [column({ translate: [0, 0, 6], wrap: 'spheroid', drop: true,
                                                            bounds: { center: [0, 0, 7.5], radius: 2 } })] })));
  near(zSlabs(built).find(([a, b]) => b - a > 2.9)[0], 0, 'its base');
  const wrapper = built.nodes.find((n) => n?.prim && n.prim.k_par > 0 && n.prim.k_perp > 0 && n.prim.k_par !== n.prim.k_perp);
  const { axis, k_par, k_perp, linear: c } = wrapper.prim, ca = dot(c, axis);
  const centre = c.map((v, i) => -(v / k_perp + (1 / k_par - 1 / k_perp) * ca * axis[i]));
  near(centre[2], 1.5, 'the wrapper\'s centre, halfway up the landed column', 1e-3);
});

test('what drop can\'t be, it says; and the scene given is left as it was', () => {
  assert.throws(() => compileScene(scene(floor({ group: [ball([0, 0, 3], 0.5, { drop: 'yes' })] }))),
                /drop: true, for now/);
  assert.throws(() => compileScene({ ...scene(floor({ group: ['b'] })), objects: { b: ball([0, 0, 3], 0.5, { drop: true }) } }),
                /objects\.b: drop where the object is placed/);
  assert.throws(() => compileScene(scene(floor({ group: [{ ...box({ drop: true }), outside: ball([0, 0, 3], 0.5, { drop: true }) }] }))),
                /a drop within a dropped object/);
  const spec = scene(floor({ group: [ball([0, 0, 3], 0.5, { drop: true })] }));
  const before = JSON.stringify(spec);
  compileScene(spec);
  assert.equal(JSON.stringify(spec), before);
});

test('it falls at most 10 units: further, it stays where it is and warns', () => {
  const high = quietly(() => compileScene(scene(floor({ group: [ball([0, 0, 12], 0.5, { drop: true })] }))));
  assert.match(high.warned.join('\n'), /drop: nothing within 10 units below it/);
  near(spheres(high.result)[0].c[2], 12, 'left where it was');
  near(spheres(compileScene(scene(floor({ group: [ball([0, 0, 10], 0.5, { drop: true })] }))))[0].c[2], 0.5, 'from 10, 9.5 units: lands');
});
