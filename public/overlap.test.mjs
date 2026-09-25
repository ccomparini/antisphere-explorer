// Tests for overlap detection. Run with:
//   node --test overlap.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene } from './antisphere-scene.js';
import { regionsOverlap, regionsDisjoint, separation, matrixOf,
         smallestEigenvalue, interiorPaths, subtreesApart } from './overlap.js';

const primOf = (shape) =>
  compileScene({ materials: {}, lights: [], root: shape }).nodes[1].prim;

const ball = (x, r) => ({ sphere: { center: [x, 0, 0], radius: r } });
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const H = (p, R) => {
  const a = dot(p.axis, R);
  return p.k_perp * dot(R, R) + (p.k_par - p.k_perp) * a * a + 2 * dot(p.linear, R) + p.constant;
};

// -- the eigenvalue routine the certificate rests on -------------------------------

test('smallestEigenvalue matches known spectra', () => {
  const diag = (a, b, c, d) => [[a,0,0,0],[0,b,0,0],[0,0,c,0],[0,0,0,d]];
  assert.ok(Math.abs(smallestEigenvalue(diag(3, 1, 4, 2)) - 1) < 1e-9);
  assert.ok(Math.abs(smallestEigenvalue(diag(-2, 5, 0, 7)) + 2) < 1e-9);
  // A rotation of a known spectrum keeps it.
  const s = Math.SQRT1_2;
  const turned = [[2*s*s + 6*s*s, 2*s*s - 6*s*s, 0, 0],
                  [2*s*s - 6*s*s, 2*s*s + 6*s*s, 0, 0],
                  [0, 0, 5, 0], [0, 0, 0, 9]];
  assert.ok(Math.abs(smallestEigenvalue(turned) - 2) < 1e-6);
});

// -- pairs of regions ---------------------------------------------------------------

const PAIRS = [
  ['two spheres, apart',         ball(-3,1), 1, ball(3,1), 1, true],
  ['two spheres, overlapping',   ball(-0.5,1), 1, ball(0.5,1), 1, false],
  ['sphere inside sphere',       ball(0,0.4), 1, ball(0,1), 1, false],
  ['sphere vs half-space, off',  ball(0,1), 1, { plane: { normal:[0,0,1], offset:-3 } }, 1, true],
  ['sphere vs half-space, cut',  ball(0,1), 1, { plane: { normal:[0,0,1], offset:0.5 } }, 1, false],
  ['sphere vs slab, clear',      ball(0,1), 1, { slab: { center:[0,0,9], axis:[0,0,1], thickness:2 } }, 1, true],
  ['sphere vs slab, through',    ball(0,1), 1, { slab: { center:[0,0,0], axis:[0,0,1], thickness:0.5 } }, 1, false],
  ['sphere vs cylinder, clear',  ball(6,1), 1, { cylinder: { center:[0,0,0], axis:[0,0,1], radius:2 } }, 1, true],
  ['sphere vs cylinder, inside', ball(0,1), 1, { cylinder: { center:[0,0,0], axis:[0,0,1], radius:2 } }, 1, false],
  ['sphere vs cone, outside',    ball(4,0.5), 1, { cone: { apex:[0,0,0], axis:[0,0,1], slope:0.5 } }, 1, true],
  ['sphere vs cone, inside',     { sphere:{ center:[0,0,4], radius:0.5 } }, 1,
                                 { cone: { apex:[0,0,0], axis:[0,0,1], slope:0.5 } }, 1, false],
  ['skew cylinders, clear',      { cylinder:{ center:[0,0,0], axis:[0,0,1], radius:1 } }, 1,
                                 { cylinder:{ center:[5,0,0], axis:[0,1,0], radius:1 } }, 1, true],
  ['skew cylinders, crossing',   { cylinder:{ center:[0,0,0], axis:[0,0,1], radius:1 } }, 1,
                                 { cylinder:{ center:[1,0,0], axis:[0,1,0], radius:1 } }, 1, false],
  ['hyperboloid vs sphere, in',  { hyperboloid:{ center:[0,0,0], axis:[0,0,1], radius:1, semiAxial:1 } }, 1,
                                 ball(0,0.5), 1, false],
  ['hyperboloid vs sphere, out', { hyperboloid:{ center:[0,0,0], axis:[0,0,1], radius:1, semiAxial:1 } }, 1,
                                 { sphere:{ center:[3,0,0], radius:0.5 } }, 1, true],
  ['two parallel slabs, apart',  { slab:{ center:[0,0,0], axis:[0,0,1], thickness:1 } }, 1,
                                 { slab:{ center:[0,0,5], axis:[0,0,1], thickness:1 } }, 1, true],
  ['two crossing slabs',         { slab:{ center:[0,0,0], axis:[0,0,1], thickness:1 } }, 1,
                                 { slab:{ center:[0,0,0], axis:[1,0,0], thickness:1 } }, 1, false],
];

test('regions that should be apart are proved apart', () => {
  for (const [label, a, sa, b, sb, apart] of PAIRS) {
    assert.equal(regionsDisjoint(primOf(a), sa, primOf(b), sb), apart, label);
    assert.equal(regionsOverlap(primOf(a), sa, primOf(b), sb), !apart, label);
  }
});

test('the sign picks the other side of a node', () => {
  const outer = primOf(ball(0, 2)), inner = primOf(ball(0, 1));
  // Inside the big ball meets inside the small one...
  assert.equal(regionsOverlap(outer, 1, inner, 1), true);
  // ...but outside the big ball does not.
  assert.equal(regionsDisjoint(outer, -1, inner, 1), true);
  // Outside both is a shared region: everything far away.
  assert.equal(regionsOverlap(outer, -1, inner, -1), true);
});

test('touching counts as apart, and the margin says how close', () => {
  const touch = separation(matrixOf(primOf(ball(-1, 1)), 1), matrixOf(primOf(ball(1, 1)), 1));
  const clear = separation(matrixOf(primOf(ball(-3, 1)), 1), matrixOf(primOf(ball(3, 1)), 1));
  const over  = separation(matrixOf(primOf(ball(-0.5, 1)), 1), matrixOf(primOf(ball(0.5, 1)), 1));
  assert.ok(Math.abs(touch.margin) < 1e-6, `touching margin ${touch.margin}`);
  assert.ok(clear.margin > touch.margin, 'further apart proves more easily');
  assert.ok(over.margin < -1e-3, 'overlapping has no certificate');
  assert.ok(clear.mu >= 0, 'the multiplier is the proof');
});

test('the certificate is never wrong about an overlap', () => {
  // Random pairs, checked against witnesses found by sampling. A witness and
  // a certificate at the same time would mean the test is unsound.
  let proved = 0, witnessed = 0, neither = 0;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const vec = () => [rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)];
  const shapes = [
    () => ({ sphere: { center: vec().map((v) => v * 3), radius: rnd(0.3, 1.5) } }),
    () => ({ cylinder: { center: vec().map((v) => v * 3), axis: vec(), radius: rnd(0.3, 1.2) } }),
    () => ({ slab: { center: vec().map((v) => v * 3), axis: vec(), thickness: rnd(0.3, 2) } }),
    () => ({ cone: { apex: vec().map((v) => v * 3), axis: vec(), slope: rnd(0.2, 1.2) } }),
    () => ({ plane: { normal: vec(), offset: rnd(-2, 2) } }),
  ];
  for (let trial = 0; trial < 400; trial++) {
    const a = primOf(shapes[trial % shapes.length]());
    const b = primOf(shapes[(trial * 7 + 3) % shapes.length]());
    const sa = Math.random() < 0.3 ? -1 : 1, sb = Math.random() < 0.3 ? -1 : 1;
    const apart = regionsDisjoint(a, sa, b, sb);
    let witness = null;
    for (let k = 0; k < 4000 && !witness; k++) {
      const R = [rnd(-6, 6), rnd(-6, 6), rnd(-6, 6)];
      if (sa * H(a, R) < 0 && sb * H(b, R) < 0) witness = R;
    }
    assert.ok(!(apart && witness),
              `certified apart but (${witness}) is interior to both`);
    if (apart) proved++; else if (witness) witnessed++; else neither++;
  }
  assert.ok(proved > 20 && witnessed > 20, `proved ${proved}, witnessed ${witnessed}`);
  assert.ok(neither < 400 * 0.2, `too many undecided: ${neither}`);
});

// -- whole subtrees ---------------------------------------------------------------------

function sceneOf(root) {
  const built = compileScene({ materials: { clay: {} }, lights: [], root });
  const solid = (i) => !!built.materials[built.nodes[i].material].solid;
  return { built, solid, prims: (i) => built.nodes[i].prim };
}

test('interior paths are the conjunctions a region is made of', () => {
  // A ball with a bite: one path, two constraints.
  const { built, solid } = sceneOf({
    sphere: { center: [0,0,0], radius: 1 }, material: 'clay',
    inside: { sphere: { center: [0.6,0,0], radius: 0.5 }, complement: true, material: 'clay' },
  });
  const paths = interiorPaths(built.nodes, 1, solid);
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0].map((c) => c.sign), [1, 1]);
});

test('subtrees far apart are proved apart; overlapping ones are not', () => {
  // Each object is compiled on its own: the paths within one tree already
  // partition space, so the question is only ever about two of them.
  const bitten = (x) => ({
    sphere: { center: [x,0,0], radius: 1 }, material: 'clay',
    inside: { sphere: { center: [x+0.6,0,0], radius: 0.5 }, complement: true, material: 'clay' },
  });
  const object = (shape) => {
    const s = sceneOf(shape);
    return { paths: interiorPaths(s.built.nodes, 1, s.solid), prims: s.prims };
  };

  // Radius 1 each, centres 1.2 apart, so they share a lens that neither
  // bite removes.
  const left = object(bitten(-0.6)), right = object(bitten(0.6));
  const far = object(bitten(40));

  assert.equal(subtreesApart(left.paths, left.prims, far.paths, far.prims).apart, true,
               'far apart');
  assert.equal(subtreesApart(left.paths, left.prims, right.paths, right.prims).apart, false,
               'overlapping');

  // A cutter that misses is still proved apart from what it would have cut.
  const shell = object({ intersect: [
    { sphere: { center: [0,0,0], radius: 1 }, material: 'clay' },
    { sphere: { center: [0,0,0], radius: 0.7 }, complement: true, material: 'clay' },
  ] });
  const core = object({ sphere: { center: [0,0,0], radius: 0.5 }, material: 'clay' });
  assert.equal(subtreesApart(shell.paths, shell.prims, core.paths, core.prims).apart, true,
               'a shell and the ball in its hollow never meet');
});
