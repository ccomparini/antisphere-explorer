// Tests for "tangentTo": a primitive slid along an axis until its surface
// sits flush against another's (or touching it), or as near as it comes.
// Run with:
//   node --test tangent.test.mjs
//
// Where things end up is read off the compiled nodes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene } from './antisphere-scene.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const MATERIALS = { stone: { albedo: [0.6, 0.6, 0.6] } };
const scene = (root, objects = {}) => ({ materials: MATERIALS, lights: [], objects, root });
const ball = (center, radius, extra = {}) => ({ sphere: { center, radius }, material: 'stone', ...extra });
const near = (got, want, what, tol = 1e-6) => assert.ok(Math.abs(got - want) <= tol, `${what}: ${got}, not ${want}`);
const quietly = (fn) => {
  const warned = [], warn = console.warn;
  console.warn = (msg) => warned.push(msg);
  try { return { result: fn(), warned }; } finally { console.warn = warn; }
};
/** Every sphere's centre, by radius. */
const centreOf = (built, radius) => {
  const n = built.nodes.find((x) => x?.prim && x.prim.k_par > 0 && x.prim.k_par === x.prim.k_perp
    && Math.abs(Math.sqrt(dot(x.prim.linear, x.prim.linear) / (x.prim.k_perp ** 2) - x.prim.constant / x.prim.k_perp) - radius) < 1e-9);
  return n.prim.linear.map((v) => -v / n.prim.k_perp);
};
const OBJECTS = {
  floor: { plane: { normal: [0, 0, 1], offset: 0 }, material: 'stone' },
  cone: { cone: { apex: [0, 0, 0], axis: [0, 0, 1], slope: 1 }, material: 'stone' },
  big: ball([0, 0, 0], 2),
  tube: { cylinder: { center: [0, 0, 0], axis: [0, 0, 1], radius: 1 }, material: 'stone' },
};

test('a ball, touching, comes to rest on a floor: slid along the floor\'s normal, its own axis having none', () => {
  const built = compileScene(scene({ group: ['floor', ball([1, 2, 5], 1, { tangentTo: { to: 'floor', facing: 'touching' } })] }, OBJECTS));
  const c = centreOf(built, 1);
  near(c[0], 1, 'x'); near(c[1], 2, 'y'); near(c[2], 1, 'resting on the floor');
});

test('a ball seated flush in a cone, slid down its axis', () => {
  // (The ball first in the group: where members overlap the earlier claim
  // stands, and the cone would swallow a ball seated inside it.)
  const built = compileScene(scene({ group: [ball([0, 0, 5], 1, { tangentTo: 'cone' }), 'cone'] }, OBJECTS));
  near(centreOf(built, 1)[2], Math.SQRT2, 'where a ball of radius 1 meets a cone of slope 1');
});

test('two balls touching, along the line between their centres', () => {
  const built = compileScene(scene({ group: ['big', ball([3, 4, 0], 0.5, { tangentTo: { to: 'big', facing: 'touching' } })] }, OBJECTS));
  const c = centreOf(built, 0.5);
  near(Math.hypot(...c), 2.5, 'centres r1 + r2 apart');
  near(c[0] / c[1], 3 / 4, 'on the line they were on');
});

test('a ceiling slid down its normal until it touches a ball', () => {
  // Solid above z = 5, its outward normal down: brought down onto the ball's top.
  const built = compileScene(scene({ group: ['big', { plane: { normal: [0, 0, -1], offset: -5 }, material: 'stone',
                                                      tangentTo: { to: 'big', facing: 'touching' } }] }, OBJECTS));
  const plane = built.nodes.find((n) => n?.prim && n.prim.k_par === 0 && n.prim.k_perp === 0 && n.prim.axis[2] < 0);
  const z = -plane.prim.constant / (2 * plane.prim.linear[2]);   // where n.R = offset: 2 c.R + d = 0 on the axis
  near(z, 2, 'at the ball\'s top');
});

test('a flare whose waist matches the tube is already flush, and stays put', () => {
  const flare = { hyperboloid: { center: [0, 0, 3], axis: [0, 0, 1], radius: 1, semiAxial: 1, sheets: 1 }, material: 'stone', tangentTo: 'tube' };
  const { result, warned } = quietly(() => compileScene(scene({ group: ['tube', flare] }, OBJECTS)));
  assert.equal(warned.length, 0, `no warning: ${warned}`);
  const plain = compileScene(scene({ group: ['tube', { ...flare, tangentTo: undefined }] }, OBJECTS));
  assert.deepEqual(result.nodes.map((n) => n.prim), plain.nodes.map((n) => n.prim), 'unmoved');
});

test('best effort: where it can\'t be flush, as near as sliding brings it, with a warning', () => {
  // A small ball (0.25) sliding past a big one (2), its centre 2 off the
  // big one's axis: to sit flush inside it, it would need to be 1.75 from
  // the big one's centre, which no slide reaches - but they do meet.
  // Nearest at the big one's middle.
  const { result, warned } = quietly(() => compileScene(scene({ group: [ball([0, 2, 3], 0.25, { tangentTo: { to: 'big', along: [0, 0, 1] } }), 'big'] }, OBJECTS)));
  assert.match(warned.join('\n'), /tangentTo: best effort: the normals are left [0-9.]+ degrees apart/);
  near(centreOf(result, 0.25)[2], 0, 'level with the big ball\'s centre', 1e-4);
});

test('where sliding changes nothing, or they never meet, it stays put and says so', () => {
  const cases = [
    // A tube slid along its own axis.
    [{ cylinder: { center: [0, 0, 0], axis: [0, 0, 1], radius: 0.5 }, material: 'stone', tangentTo: 'big' }, /sliding along this axis changes nothing/],
    // A flare wider than the tube: they never meet.
    [{ hyperboloid: { center: [0, 0, 3], axis: [0, 0, 1], radius: 1.2, semiAxial: 1, sheets: 1 }, material: 'stone', tangentTo: 'tube' }, /they never meet/],
    // A narrower one meets it, but at the same angle wherever it is.
    [{ hyperboloid: { center: [0, 0, 3], axis: [0, 0, 1], radius: 0.8, semiAxial: 1, sheets: 1 }, material: 'stone', tangentTo: 'tube' }, /changes nothing/],
  ];
  for (const [mover, why] of cases) {
    const { result, warned } = quietly(() => compileScene(scene({ group: [mover] }, OBJECTS)));
    assert.match(warned.join('\n'), why);
    const plain = compileScene(scene({ group: [{ ...mover, tangentTo: undefined }] }, OBJECTS));
    assert.deepEqual(result.nodes.map((n) => n.prim), plain.nodes.map((n) => n.prim), 'unmoved');
  }
});

test('a primitive written in place, and the axis given', () => {
  const built = compileScene(scene({ group: [ball([4, 0, 0], 1, { tangentTo: { to: { sphere: { center: [0, 0, 0], radius: 1 } }, facing: 'touching', along: [1, 0, 0] } })] }));
  near(centreOf(built, 1)[0], 2, 'touching, along x');
});

test('what tangentTo can\'t be, it says; and the scene given is left as it was', () => {
  const tries = [
    [ball([0, 0, 3], 1, { tangentTo: 'nowhere' }), /no object "nowhere"/],
    [ball([0, 0, 3], 1, { tangentTo: { to: 'floor', facing: 'sideways' } }), /"flush" or "touching"/],
    [ball([0, 0, 3], 1, { tangentTo: { to: 'floor', along: [0, 0, 0] } }), /a direction/],
    [{ union: [ball([0, 0, 3], 1)], tangentTo: 'floor' }, /a single primitive/],
    [ball([0, 0, 3], 1, { tangentTo: 7 }), /an object's name/],
  ];
  for (const [mover, why] of tries) assert.throws(() => compileScene(scene({ group: ['floor', mover] }, OBJECTS)), why);
  assert.throws(() => compileScene(scene({ group: ['floor', { translate: [1, 0, 0], group: [ball([0, 0, 3], 1, { tangentTo: 'floor' })] }] }, OBJECTS)),
                /within a subtree that is itself moved/);
  const spec = scene({ group: ['floor', ball([0, 0, 3], 1, { tangentTo: { to: 'floor', facing: 'touching' } })] }, OBJECTS);
  const before = JSON.stringify(spec);
  compileScene(spec);
  assert.equal(JSON.stringify(spec), before);
});
