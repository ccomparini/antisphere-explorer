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

// -- by scale --------------------------------------------------------------------

import { quadricAt } from './quadric.js';

test('the trumpet by scaling: a flare shrinks round its waist to the tube\'s radius', () => {
  const flare = { hyperboloid: { center: [0, 0, 2.2], axis: [0, 0, 1], radius: 0.4, semiAxial: 0.35, sheets: 1 }, material: 'stone',
                  tangentTo: { to: 'tube', by: 'scale' } };
  const tube = { cylinder: { center: [0, 0, 0], axis: [0, 0, 1], radius: 0.3 }, material: 'stone' };
  const { result, warned } = quietly(() => compileScene(scene({ group: ['tube', flare] }, { tube })));
  assert.equal(warned.length, 0, `flush, no warning: ${warned}`);
  const h = result.nodes.find((n) => n?.prim && n.prim.k_par < 0 && n.prim.k_perp > 0).prim;
  const centre = -h.linear[2] / h.k_par;
  near(centre, 2.2, 'its centre unmoved');
  // At the centre's height, H = k_perp rho^2 + (what is left): rho where it vanishes.
  const rest = quadricAt(h, [0, 0, centre]);
  near(Math.sqrt(-rest / h.k_perp), 0.3, 'its waist the tube\'s radius');
});

test('a ball scaled about a point above it until it touches the floor', () => {
  // About [0, 0, 4], a ball of 1 at height 3 scaled by l has its centre at
  // 4 - l and radius l: touching the floor at l = 2.
  const built = compileScene(scene({ group: ['floor', ball([0, 0, 3], 1, { tangentTo: { to: 'floor', facing: 'touching', by: 'scale', pivot: [0, 0, 4] } })] }, OBJECTS));
  const c = centreOf(built, 2);
  near(c[2], 2, 'its centre, a radius of 2 above the floor');
});

test('scaling folds into a node\'s own scale, rotate and translate: the same shape, scaled about the pivot', () => {
  const p = [0.3, -0.2, 5];
  for (const rotate of [{ axis: [1, 1, 0], degrees: 35, pivot: [1, 0, 0] }, { degrees: [20, -40, 70], pivot: [0, 2, 1] }]) {
    const own = { spheroid: { center: [0, 0, 1], axis: [0, 0, 1], height: 3, radius: 1 }, material: 'stone',
                  scale: { factor: 1.3, pivot: [0.5, 0, 0] }, rotate, translate: [0.2, 0.4, 3] };
    const before = compileScene(scene({ group: [own] })).nodes.find((n) => n?.prim?.k_par > 0).prim;
    const { result } = quietly(() => compileScene(scene({ group: ['floor', { ...own, tangentTo: { to: 'floor', facing: 'touching', by: 'scale', pivot: p } }] }, OBJECTS)));
    const after = result.nodes.find((n) => n?.prim?.k_par > 0 && n.prim.k_perp > 0 && n.prim.k_par !== n.prim.k_perp).prim;
    // Whatever the factor found, `after` must be `before` scaled by it about
    // p: H_after(x) a constant positive multiple of H_before(p + (x - p) / l).
    // l is read off the curvatures, which the compiler's scalePrim() divides
    // by the factor; then every point is checked against it.
    const l = before.k_perp / after.k_perp;
    assert.ok(Math.abs(before.k_par / after.k_par - l) < 1e-9 * l, 'both curvatures by the same factor');
    let ratio = null;
    for (const x of [[0, 0, 0], [1, 2, 3], [-2, 1, 4], [0.5, -1, 6], [3, 3, 3]]) {
      const y = x.map((v, i) => p[i] + (v - p[i]) / l);
      const r = quadricAt(after, x) / quadricAt(before, y);
      ratio ??= r;
      assert.ok(r > 0 && Math.abs(r - ratio) < 1e-6 * Math.abs(ratio), `the same shape scaled about p (${JSON.stringify(rotate)}): ${r} vs ${ratio}`);
    }
  }
});

test('scaling that changes nothing, or would need too much, stays put and says so', () => {
  const cone = { cone: { apex: [0, 0, 0], axis: [0, 0, 1], slope: 1 }, material: 'stone', tangentTo: { to: 'big', by: 'scale', pivot: [0, 0, 0] } };
  const { result, warned } = quietly(() => compileScene(scene({ group: [cone] }, OBJECTS)));
  assert.match(warned.join('\n'), /scaling about this point changes nothing/);
  const plain = compileScene(scene({ group: [{ ...cone, tangentTo: undefined }] }, OBJECTS));
  assert.deepEqual(result.nodes.map((n) => n.prim), plain.nodes.map((n) => n.prim), 'unmoved');
  // A speck far above the floor, scaled about a point beside it: it would
  // have to grow by thousands to reach.
  const far = quietly(() => compileScene(scene({ group: ['floor', ball([0, 0, 500], 0.01, { tangentTo: { to: 'floor', facing: 'touching', by: 'scale', pivot: [0, 0, 500] } })] }, OBJECTS)));
  assert.match(far.warned.join('\n'), /would need scaling by|never meet/);
});

test('what scaling can\'t take, it says', () => {
  assert.throws(() => compileScene(scene({ group: ['floor', ball([0, 0, 3], 1, { tangentTo: { to: 'floor', by: 'scale', along: [0, 0, 1] } })] }, OBJECTS)), /along: is for sliding/);
  assert.throws(() => compileScene(scene({ group: ['floor', ball([0, 0, 3], 1, { tangentTo: { to: 'floor', pivot: [0, 0, 0] } })] }, OBJECTS)), /pivot: is for scaling/);
  assert.throws(() => compileScene(scene({ group: ['floor', ball([0, 0, 3], 1, { tangentTo: { to: 'floor', by: 'stretch' } })] }, OBJECTS)), /"slide" or "scale"/);
});
