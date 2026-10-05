// Tests for the CSG operators. Run with:
//   node --test antisphere-csg.test.mjs
//
// These decide whether a point is solid by walking the compiled tree the way
// antisphere-raycast.wgsls's trace() does - descend by the sign of H, and at
// an absent child read the two slots the way flatten() documents: an omitted
// "inside" is solid using this node's own material, an omitted "outside" is
// void. An operator is right when that walk agrees with the boolean formula
// it claims to implement, at points chosen to cover every region.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene } from './antisphere-scene.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function H(prim, R) {
  const along = dot(prim.axis, R);
  return prim.k_perp * dot(R, R) + (prim.k_par - prim.k_perp) * along * along
       + 2 * dot(prim.linear, R) + prim.constant;
}

/**
 * Where a point lands: { solid, material, node }, by trace()'s own rules.
 *
 * Descending into a node's inside with a solid material starts a hit if none
 * is open, which is why the node reported is the *outermost* of a run of
 * solid regions rather than the innermost; anything non-solid, and going
 * outside a node, clears it again. Solidity is then just whether a hit is
 * open when the descent runs out.
 *
 * One thing this can't model: trace() establishes that hit as the ray
 * crosses boundaries, so which node a surface reports depends on where the
 * ray came from. A ray reaching this region from outside the object reports
 * the outer node; one arriving through a cut, having had its hit cleared
 * inside the cutter, reports the cutter's. That's what makes a cut face show
 * the cutter's material while the object keeps its own.
 */
function at(built, R) {
  let index = 1;                       // node 1 is always the root
  let found = 0;
  for (let step = 0; step < 500; step++) {
    const nd = built.nodes[index];
    if (H(nd.prim, R) < 0) {
      if (built.materials[nd.material].solid) { if (!found) found = index; }
      else found = 0;
      index = nd.inside;
    } else {
      found = 0;
      index = nd.outside;
    }
    if (index === 0) {
      return { solid: found !== 0, node: found,
               material: found ? built.nodes[found].material : 0 };
    }
  }
  throw new Error('traversal did not terminate');
}

const solidAt = (built, R) => at(built, R).solid;   // i.e. a ray stops here

/** The nodes whose inside a point lies within, outermost first. */
function entered(built, R) {
  const chain = [];
  let index = 1;
  for (let step = 0; step < 500 && index !== 0; step++) {
    const nd = built.nodes[index];
    if (H(nd.prim, R) < 0) { chain.push(index); index = nd.inside; }
    else index = nd.outside;
  }
  return chain;
}

// A scene of one subtree, with a shell of vacuum around it so the root is an
// ordinary sphere and the subtree under test is all there is inside it.
function build(subtree, objects = {}) {
  return compileScene({
    materials: { clay: { albedo: [0.7, 0.5, 0.4] }, sky: { albedo: [0.1, 0.1, 0.2] } },
    lights: [{ pos: [0, 0, 5], color: [1, 1, 1] }],
    objects,
    root: { sphere: { center: [0, 0, 0], radius: 100 }, material: null, inside: subtree },
  });
}

// Two overlapping unit spheres, and points in each region of them.
const A = { sphere: { center: [-0.5, 0, 0], radius: 1 }, material: 'clay' };
const B = { sphere: { center: [0.5, 0, 0], radius: 1 }, material: 'sky' };
const inA = (R) => (R[0] + 0.5) ** 2 + R[1] ** 2 + R[2] ** 2 < 1;
const inB = (R) => (R[0] - 0.5) ** 2 + R[1] ** 2 + R[2] ** 2 < 1;

// Points spread over both spheres and the space around them.
const GRID = [];
for (let x = -2; x <= 2; x += 0.25) {
  for (let y = -1.5; y <= 1.5; y += 0.25) {
    for (const z of [0, 0.4, -0.9]) GRID.push([x, y, z]);
  }
}
// Points exactly on a surface are no test of anything: "inside" is strictly
// H < 0, so which side of its own boundary a point lands on is a coin toss
// between the traversal and any formula written to match it. Every test
// therefore says which surfaces it involves, and points within a hair of one
// are left out.
const ballAt = (c, r) => (R) => (R[0] - c[0]) ** 2 + (R[1] - c[1]) ** 2 + (R[2] - c[2]) ** 2 - r * r;
const surfA = ballAt([-0.5, 0, 0], 1);
const surfB = ballAt([0.5, 0, 0], 1);

const clearOf = (...surfaces) =>
  GRID.filter((R) => surfaces.every((f) => Math.abs(f(R)) > 1e-3));
const CLEAR = clearOf(surfA, surfB);

function agrees(built, expected, what, points = CLEAR) {
  for (const R of points) {
    assert.equal(solidAt(built, R), expected(R),
                 `${what} at (${R.map((v) => +v.toFixed(2))})`);
  }
}

// -- the truth tables ---------------------------------------------------------

test('union is A or B', () => {
  agrees(build({ union: [A, B] }), (R) => inA(R) || inB(R), 'union');
});

test('intersect is A and B', () => {
  agrees(build({ intersect: [A, B] }), (R) => inA(R) && inB(R), 'intersect');
});

test('difference is A and not B', () => {
  agrees(build({ difference: [A, B] }), (R) => inA(R) && !inB(R), 'difference');
  // And it is not symmetric.
  agrees(build({ difference: [B, A] }), (R) => inB(R) && !inA(R), 'difference reversed');
});

test('more than two operands fold left', () => {
  const C = { sphere: { center: [0, 0.75, 0], radius: 1 }, material: 'clay' };
  const inC = (R) => R[0] ** 2 + (R[1] - 0.75) ** 2 + R[2] ** 2 < 1;
  const clear = clearOf(surfA, surfB, ballAt([0, 0.75, 0], 1));
  agrees(build({ union: [A, B, C] }), (R) => inA(R) || inB(R) || inC(R), 'union of three', clear);
  agrees(build({ intersect: [A, B, C] }), (R) => inA(R) && inB(R) && inC(R),
         'intersect of three', clear);
  agrees(build({ difference: [A, B, C] }), (R) => inA(R) && !inB(R) && !inC(R),
         'difference of three', clear);
});

test('one operand is just that operand', () => {
  for (const op of ['union', 'intersect', 'difference']) {
    agrees(build({ [op]: [A] }), inA, op);
  }
});

// -- the awkward cases ----------------------------------------------------------

test('cutting with something that contains the whole thing leaves nothing', () => {
  const big = { sphere: { center: [0, 0, 0], radius: 10 }, material: 'sky' };
  const built = build({ difference: [A, big] });
  for (const R of CLEAR) assert.equal(solidAt(built, R), false, `${R} should hit nothing`);
});

test('cutting with something that misses leaves it whole', () => {
  const far = { sphere: { center: [50, 0, 0], radius: 1 }, material: 'sky' };
  agrees(build({ difference: [A, far] }), inA, 'difference with a miss');
});

test('difference with null changes nothing, and of null is nothing', () => {
  agrees(build({ difference: [A, null] }), inA, 'A minus nothing');
  const nothing = build({ difference: [null, A] });
  for (const R of CLEAR) assert.equal(solidAt(nothing, R), false, `${R} should hit nothing`);
});

test('a half-space cutter slices cleanly', () => {
  // Inside is z < -0.1, so cutting it away leaves everything above that.
  const below = { plane: { normal: [0, 0, 1], offset: -0.1 }, material: 'sky' };
  agrees(build({ difference: [A, below] }), (R) => inA(R) && R[2] > -0.1, 'sliced',
         clearOf(surfA, (R) => R[2] + 0.1));
});

test('a hollow shell, and a hollow that breaches the surface', () => {
  const ball = { sphere: { center: [0, 0, 0], radius: 1 }, material: 'clay' };
  const core = { sphere: { center: [0, 0, 0], radius: 0.5 }, material: 'sky' };
  const shell = build({ difference: [ball, core] });
  const r2 = (R) => dot(R, R);
  const clear = clearOf(ballAt([0, 0, 0], 1), ballAt([0, 0, 0], 0.5));
  agrees(shell, (R) => r2(R) < 1 && r2(R) > 0.25, 'shell', clear);

  // A cavity poking out through the surface: still just A and not B.
  const bite = { sphere: { center: [0.9, 0, 0], radius: 0.5 }, material: 'sky' };
  agrees(build({ difference: [ball, bite] }),
         (R) => r2(R) < 1 && (R[0] - 0.9) ** 2 + R[1] ** 2 + R[2] ** 2 > 0.25, 'bitten',
         clearOf(ballAt([0, 0, 0], 1), ballAt([0.9, 0, 0], 0.5)));
});

test('operators nest, in either direction', () => {
  const C = { sphere: { center: [0, 0.75, 0], radius: 1 }, material: 'clay' };
  const inC = (R) => R[0] ** 2 + (R[1] - 0.75) ** 2 + R[2] ** 2 < 1;
  const clear = clearOf(surfA, surfB, ballAt([0, 0.75, 0], 1));

  // (A or B) minus C
  agrees(build({ difference: [{ union: [A, B] }, C] }),
         (R) => (inA(R) || inB(R)) && !inC(R), 'union then difference', clear);
  // A minus (B and C)
  agrees(build({ difference: [A, { intersect: [B, C] }] }),
         (R) => inA(R) && !(inB(R) && inC(R)), 'difference of an intersection', clear);
  // (A minus B) and C
  agrees(build({ intersect: [{ difference: [A, B] }, C] }),
         (R) => inA(R) && !inB(R) && inC(R), 'difference then intersect', clear);
  // A minus (B minus C): the part of B outside C is what gets removed.
  agrees(build({ difference: [A, { difference: [B, C] }] }),
         (R) => inA(R) && !(inB(R) && !inC(R)), 'difference of a difference', clear);
});

test('operators work through use, transforms and objects', () => {
  const objects = {
    ball: { sphere: { center: [0, 0, 0], radius: 1 }, material: 'clay' },
    cut: { sphere: { center: [0, 0, 0], radius: 0.6 }, material: 'sky' },
  };
  const built = build({ difference: [
    { use: 'ball' },
    { use: 'cut', translate: [0.8, 0, 0] },
  ] }, objects);
  const inBall = (R) => dot(R, R) < 1;
  const inCut = (R) => (R[0] - 0.8) ** 2 + R[1] ** 2 + R[2] ** 2 < 0.36;
  agrees(built, (R) => inBall(R) && !inCut(R), 'difference of two placed objects',
         clearOf(ballAt([0, 0, 0], 1), ballAt([0.8, 0, 0], 0.6)));
});

test('a difference can be a group member', () => {
  const scene = compileScene({
    materials: { clay: {} }, lights: [],
    objects: {
      carved: { difference: [
        { sphere: { center: [0, 0, 0], radius: 1 }, material: 'clay' },
        { cylinder: { center: [0, 0, 0], axis: [0, 0, 1], radius: 0.3 }, material: 'clay' },
      ] },
      ball: { sphere: { center: [8, 0, 0], radius: 1 }, material: 'clay' },
    },
    root: { group: ['carved', 'ball'] },
  });
  assert.equal(solidAt(scene, [8, 0, 0]), true, 'the other member');
  // The bore really is bored: on the axis, inside the sphere, nothing solid.
  assert.equal(solidAt(scene, [0, 0, 0]), false);
  assert.equal(solidAt(scene, [0.7, 0, 0]), true);
});

// -- groups ------------------------------------------------------------------------------
//
// A group is a union whose members are each grafted only where they may
// be (buildGroup in antisphere-scene.js): solid wherever any member is,
// overlapping or not, and reporting the pairs of members that may overlap.

test('a group is A or B or C, overlapping or not, and reports that A and B may overlap', () => {
  const C = { sphere: { center: [0, 0, 3], radius: 0.5 }, material: 'clay' };
  const inC = (R) => R[0] ** 2 + R[1] ** 2 + (R[2] - 3) ** 2 < 0.25;
  const built = build({ group: [A, B, C] });
  agrees(built, (R) => inA(R) || inB(R) || inC(R), 'group',
         [...CLEAR, [0, 0, 3], [0.2, 0.1, 2.8], [0, 0, 3.6]]);
  assert.deepEqual(built.overlaps, [{ group: 'root.inside', members: [0, 1] }]);
});

// Where a sphere with this centre is referenced from in a compiled tree:
// the [node, 'inside' | 'outside'] slots that lead to it.
function slotsOf(built, centre) {
  const isIt = (nd) => nd.prim.k_perp > 0 && nd.prim.linear.every((v, i) => Math.abs(-v / nd.prim.k_perp - centre[i]) < 1e-9);
  const out = [];
  built.nodes.forEach((nd, i) => {
    if (!i) return;
    if (nd.inside && isIt(built.nodes[nd.inside])) out.push([i, 'inside']);
    if (nd.outside && isIt(built.nodes[nd.outside])) out.push([i, 'outside']);
  });
  return out;
}

test('a member of material null claims its region like any other: the group is the same tree', () => {
  // Nodes only divide space; what fills a region is the material's
  // business. A cube with no material and one of clay make the same
  // group, and a ball inside the cube is in the region it claims either
  // way.
  const cube = (material) => ({ intersect: [0, 1, 2].map((k) => ({
    slab: { center: [0, 0, 0], axis: [0, 1, 2].map((j) => (j === k ? 1 : 0)), thickness: 2 }, material })) });
  const inCube = { sphere: { center: [0.2, 0, 0], radius: 0.3 }, material: 'sky' };
  const beside = { sphere: { center: [3, 0, 0], radius: 0.5 }, material: 'sky' };
  const shape = (built) => built.nodes.map((n) => ({ prim: n.prim, inside: n.inside, outside: n.outside }));
  const vacuum = build({ group: [cube(null), inCube, beside] });
  const clay = build({ group: [cube('clay'), inCube, beside] });
  assert.deepEqual(shape(vacuum), shape(clay));
  assert.deepEqual(vacuum.overlaps, clay.overlaps);
  assert.deepEqual(vacuum.overlaps.map((o) => o.members), [[0, 1]], 'the ball in the cube; not the one beside it');
  // The earlier claim stands: in the vacuum cube, the ball isn't there.
  assert.equal(solidAt(vacuum, [0.2, 0, 0]), false);
  assert.equal(solidAt(vacuum, [3, 0, 0]), true);
});

test('a member reaching a shared subtree two ways goes where each way says', () => {
  // A quadrant, x < 0 and y < 0, leaves two absent outsides: x > 0, and
  // x < 0 with y > 0. A half-space, z < 0, goes into both, so its node is
  // shared. Then B, two small balls: one at (-5, 5, -5), the other at
  // (5, -5, 5). Coming in by x > 0, the ball at x = -5 is ruled out, so
  // B arrives at the half-space with only (5, -5, 5) possible, which is
  // beyond it: B is grafted onto its outside. Coming in by x < 0, only
  // (-5, 5, -5) is possible, which is inside the half-space's claim: no
  // graft. What happens below a node depends on which of B's paths are
  // still possible, so that, not the node alone, is what a result can be
  // reused for: keyed by node alone, the second way in (x < 0 is tried
  // first) would take the first's answer and lose the ball at (5, -5, 5).
  const half = (normal) => ({ plane: { normal, offset: 0 }, material: 'clay' });
  const quadrant = { intersect: [half([1, 0, 0]), half([0, 1, 0])] };
  const below = half([0, 0, 1]);
  const twoBalls = { union: [
    { sphere: { center: [-5, 5, -5], radius: 0.5 }, material: 'sky' },
    { sphere: { center: [5, -5, 5], radius: 0.5 }, material: 'sky' },
  ] };
  const built = build({ group: [quadrant, below, twoBalls] });
  const union = build({ union: [quadrant, below, twoBalls] });
  assert.equal(solidAt(built, [5, -5, 5]), true, 'the ball at (5, -5, 5)');
  for (const R of GRID.map(([x, y, z]) => [x * 3, y * 4, z * 6])) {
    assert.equal(solidAt(built, R), solidAt(union, R), `at (${R})`);
  }
});

test('a member beyond one face of an octahedron hangs off that face alone', () => {
  const s = 1 / Math.sqrt(3);
  const faces = [];
  for (const sy of [1, -1]) for (const [sx, sz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
    faces.push({ plane: { normal: [sx * s, sy * s, sz * s], offset: 1.5 * s }, material: 'clay' });
  }
  // Beyond the (+1, +1, +1) face, the first, and clear of every other's
  // outside... except none: a point beyond one face is inside the rest.
  const c = [1.6, 1.6, 1.6];
  const built = build({ group: [{ intersect: faces }, { sphere: { center: c, radius: 0.5 }, material: 'clay' }] });
  const slots = slotsOf(built, c);
  assert.equal(slots.length, 1, `grafted at ${JSON.stringify(slots)}`);
  const face = built.nodes[slots[0][0]].prim.linear;
  assert.ok(face.every((v) => v > 0) && slots[0][1] === 'outside', 'the outside of the (+1, +1, +1) face');
});


test('a group of many members, overlapping, is their union, and reports every pair that overlaps', () => {
  // Spheres, and capped rods given bounds (a cylinder and a slab bound
  // nothing themselves), scattered so that some overlap and some don't.
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const members = [], inside = [], surfaces = [], balls = [];
  for (let i = 0; i < 24; i++) {
    const c = [rnd() * 12 - 6, rnd() * 12 - 6, rnd() * 3 - 1.5];
    if (i % 2) {
      const r = 0.3 + rnd() * 0.9;
      members.push({ sphere: { center: c, radius: r }, material: 'clay' });
      inside.push((R) => ballAt(c, r)(R) < 0);
      surfaces.push(ballAt(c, r));
      balls.push({ c, r });
    } else {
      const axis = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
      const n = Math.hypot(...axis), u = axis.map((v) => v / n);
      const rr = 0.2 + rnd() * 0.3, half = 0.5 + rnd();
      const reach = Math.hypot(rr, half);
      members.push({ intersect: [
        { cylinder: { center: c, axis: u, radius: rr }, material: 'sky' },
        { slab: { center: c, axis: u, thickness: 2 * half }, material: 'sky' },
      ], bounds: { center: c, radius: reach } });
      const along = (R) => dot(R.map((v, k) => v - c[k]), u);
      const across = (R) => Math.hypot(...R.map((v, k) => v - c[k] - along(R) * u[k]));
      inside.push((R) => across(R) < rr && Math.abs(along(R)) < half);
      surfaces.push((R) => Math.min(Math.abs(across(R) - rr), Math.abs(Math.abs(along(R)) - half)));
      balls.push({ c, r: reach });
    }
  }
  const built = build({ group: members });
  const points = [];
  for (let k = 0; k < 4000; k++) points.push([rnd() * 16 - 8, rnd() * 16 - 8, rnd() * 5 - 2.5]);
  // and many within every member's ball, where overlaps are: inside a
  // rod's ball but outside the rod is where a neighbour would vanish if
  // the chain didn't union them.
  for (const b of balls) {
    for (let k = 0; k < 150; k++) points.push(b.c.map((v) => v + (rnd() * 2 - 1) * b.r));
  }
  const clear = points.filter((R) => surfaces.every((f) => Math.abs(f(R)) > 1e-3));
  agrees(built, (R) => inside.some((f) => f(R)), 'overlapping group of many', clear);

  // The pairs: every pair seen to overlap (some point inside both) is
  // reported, and no pair whose balls are apart is.
  const reported = new Set(built.overlaps.map((o) => o.members.join()));
  const seen = new Set();
  for (const R of points) {
    const hits = inside.map((f, i) => (f(R) ? i : -1)).filter((i) => i >= 0);
    for (let a = 0; a < hits.length; a++) for (let b = a + 1; b < hits.length; b++) seen.add(`${hits[a]},${hits[b]}`);
  }
  assert.ok(seen.size > 3, `a fair test: ${seen.size} pairs seen to overlap`);
  for (const pair of seen) assert.ok(reported.has(pair), `${pair} overlap, but weren't reported`);
  for (const pair of reported) {
    const [i, j] = pair.split(',').map(Number);
    const d = Math.hypot(...balls[i].c.map((v, k) => v - balls[j].c[k]));
    assert.ok(d < balls[i].r + balls[j].r + 1e-6, `${pair} reported, but their balls are apart`);
  }
});

test('a group of capsules, octahedra and spheres is their union, however their trees share parts', () => {
  // Capsules are unions of an intersection and two spheres, so their trees
  // share subtrees, reached from several places; a member grafted into
  // such a subtree is pruned by the path it came in on, and must still be
  // wherever the union says. Octahedra are all planes. Given no bounds, so
  // all the proofs are the members' own shapes.
  let seed = 23;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const members = [], inside = [];
  const s3 = 1 / Math.sqrt(3);
  for (let i = 0; i < 18; i++) {
    const c = [rnd() * 10 - 5, rnd() * 10 - 5, rnd() * 3 - 1.5];
    const kind = i % 3;
    if (kind === 0) {                       // a capsule
      const axis = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
      const n = Math.hypot(...axis), u = axis.map((v) => v / n);
      const r = 0.2 + rnd() * 0.3, half = 0.4 + rnd() * 0.8;
      const end = (sgn) => c.map((v, k) => v + sgn * half * u[k]);
      members.push({ union: [
        { intersect: [
          { cylinder: { center: c, axis: u, radius: r }, material: 'clay' },
          { slab: { center: c, axis: u, thickness: 2 * half }, material: 'clay' },
        ] },
        { sphere: { center: end(1), radius: r }, material: 'clay' },
        { sphere: { center: end(-1), radius: r }, material: 'clay' },
      ] });
      inside.push((R) => {
        const t = Math.max(-half, Math.min(half, dot(R.map((v, k) => v - c[k]), u)));
        return Math.hypot(...R.map((v, k) => v - c[k] - t * u[k])) < r;
      });
    } else if (kind === 1) {               // an octahedron, turned
      const a = 0.5 + rnd();
      const faces = [];
      for (const sy of [1, -1]) for (const [sx, sz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
        faces.push({ plane: { normal: [sx * s3, sy * s3, sz * s3], offset: a * s3 }, material: 'sky' });
      }
      const degrees = rnd() * 90;
      const axis = [rnd(), rnd(), rnd()];
      members.push({ intersect: faces, rotate: { axis, degrees }, translate: c });
      const n = Math.hypot(...axis), u = axis.map((v) => v / n), th = -degrees * Math.PI / 180;
      inside.push((R) => {                  // turned back, then |x| + |y| + |z| < a
        const d = R.map((v, k) => v - c[k]);
        const along = dot(u, d), x = [u[1] * d[2] - u[2] * d[1], u[2] * d[0] - u[0] * d[2], u[0] * d[1] - u[1] * d[0]];
        const back = d.map((v, k) => v * Math.cos(th) + x[k] * Math.sin(th) + u[k] * along * (1 - Math.cos(th)));
        return Math.abs(back[0]) + Math.abs(back[1]) + Math.abs(back[2]) < a;
      });
    } else {                                // a sphere
      const r = 0.3 + rnd() * 0.8;
      members.push({ sphere: { center: c, radius: r }, material: 'clay' });
      inside.push((R) => ballAt(c, r)(R) < 0);
    }
  }
  const built = build({ group: members });
  const union = build({ union: members });
  // Points everywhere, and many around each member.
  const points = [];
  for (let k = 0; k < 6000; k++) points.push([rnd() * 12 - 6, rnd() * 12 - 6, rnd() * 5 - 2.5]);
  // Compared with the union of the same members, not a formula: points on
  // a surface are a coin toss either way, and the two agree on those too.
  let agreeing = 0, solid = 0;
  for (const R of points) {
    const want = solidAt(union, R);
    assert.equal(solidAt(built, R), want, `at (${R.map((v) => +v.toFixed(2))})`);
    agreeing++;
    if (want) solid++;
  }
  assert.ok(solid > 100, `a fair test: ${solid} of ${agreeing} points solid`);
  // And the union is what the members say.
  const wrong = points.filter((R) => solidAt(union, R) !== inside.some((f) => f(R)));
  assert.ok(wrong.length < 3, `the union itself disagrees at ${wrong.length} points`);
});

// -- materials and provenance ------------------------------------------------------

test('what survives a difference keeps its own material', () => {
  const built = build({ difference: [A, B] });
  const clay = built.materials.findIndex((m) => m.albedo[0] === 0.7);
  // The cutter is the innermost node over this region, but a ray arriving
  // from outside enters A first, so what it reports is A's.
  for (const R of [[-1.2, 0, 0], [-0.5, 0.5, 0], [-0.9, 0.3, 0.2]]) {
    const hit = at(built, R);
    assert.ok(hit.solid, `${R} should be solid`);
    assert.equal(hit.material, clay, `${R} should report A's material`);
  }
});

test("an intersection keeps both operands' materials where they are named", () => {
  const built = build({ intersect: [A, B] });
  const sky = built.materials.findIndex((m) => m.albedo[2] === 0.2);
  const clay = built.materials.findIndex((m) => m.albedo[0] === 0.7);

  // Which node a surface reports depends on which one the ray crosses, and
  // a point walk only sees the nesting - so look at the nesting itself. Over
  // the lens, A encloses B: a ray reaching it from outside reports A, and
  // one crossing B's own surface reports B, each with its own material.
  const lens = [0, 0, 0];
  assert.ok(inA(lens) && inB(lens));
  assert.equal(built.materials[at(built, lens).material], built.materials[clay],
               'from outside, the first thing entered is A');
  // The vacuum shell build() wraps everything in is entered first; being
  // non-solid it clears any hit, which is why `at` above still reports A.
  const vacuum = 0;
  assert.deepEqual(entered(built, lens).map((i) => built.nodes[i].material),
                   [vacuum, clay, sky], 'A then B, each keeping the material it named');
});

test('a cut face belongs to the object that cut it', () => {
  const built = compileScene({
    materials: { clay: {} }, lights: [],
    objects: {
      ball: { sphere: { center: [0, 0, 0], radius: 1 }, material: 'clay' },
      chisel: { sphere: { center: [1, 0, 0], radius: 0.5 }, material: 'clay' },
    },
    root: { difference: ['ball', 'chisel'] },
  });
  const owners = new Set(built.provenance.filter(Boolean).map((p) => p.owner));
  assert.ok(owners.has('ball'));
  assert.ok(owners.has('chisel'), 'clicking the cut face should select the cutter');
});

// -- refusals ------------------------------------------------------------------------

test('the operators are checked like union is', () => {
  for (const op of ['intersect', 'difference']) {
    assert.throws(() => build({ [op]: [] }), /at least one operand/, op);
    assert.throws(() => build({ [op]: A }), /takes an array/, op);
    assert.throws(() => build({ [op]: [A], inside: { sphere: { center: [0, 0, 0], radius: 1 } } }),
                  /takes no inside or outside/, op);
  }
});

// -- complement, as a scene file writes it ---------------------------------------------

test('complement turns a whole subtree inside out, children and all', () => {
  // A ball with a bite out of it, and the same thing complemented: what was
  // interior is now exterior, everywhere.
  const bitten = {
    sphere: { center: [0, 0, 0], radius: 1 }, material: 'clay',
    inside: { sphere: { center: [0.8, 0, 0], radius: 0.5 }, complement: true, material: 'clay' },
  };
  const solidThere = (R) => dot(R, R) < 1 && (R[0] - 0.8) ** 2 + R[1] ** 2 + R[2] ** 2 > 0.25;
  const clear = clearOf(ballAt([0, 0, 0], 1), ballAt([0.8, 0, 0], 0.5));

  agrees(build(bitten), solidThere, 'the bitten ball', clear);
  agrees(build({ ...bitten, complement: true }), (R) => !solidThere(R),
         'and its complement', clear);
});

test('complement of a bare primitive is what it always was', () => {
  const hollow = build({ sphere: { center: [0, 0, 0], radius: 1 },
                         complement: true, material: 'clay' });
  agrees(hollow, (R) => dot(R, R) > 1, 'a hollow', clearOf(ballAt([0, 0, 0], 1)));
});

test('complement applies to any subtree form, not just primitives', () => {
  const both = (R) => inA(R) || inB(R);
  agrees(build({ union: [A, B], complement: true }), (R) => !both(R), 'a complemented union');
  agrees(build({ intersect: [A, B], complement: true }), (R) => !(inA(R) && inB(R)),
         'a complemented intersection');
  agrees(build({ difference: [A, B], complement: true }), (R) => !(inA(R) && !inB(R)),
         'a complemented difference');

  // Through a reference, and with a transform on the same node.
  const objects = { ball: { sphere: { center: [0, 0, 0], radius: 1 }, material: 'clay' } };
  const shifted = build({ use: 'ball', complement: true, translate: [0.5, 0, 0] }, objects);
  agrees(shifted, (R) => (R[0] - 0.5) ** 2 + R[1] ** 2 + R[2] ** 2 > 1,
         'a complemented, translated object', clearOf(ballAt([0.5, 0, 0], 1)));
});

test('complementing twice gets back to where it started', () => {
  const once = { union: [A, B], complement: true };
  agrees(build({ union: [once], complement: true }), (R) => inA(R) || inB(R), 'there and back');
});

// -- envs: the node an ambient region starts at -------------------------------------

function buildEnvs(subtree, objects = {}) {
  return compileScene({
    materials: {
      clay: { albedo: [0.7, 0.5, 0.4] },
      air: { kind: 'ambient', albedo: [0.2, 0.2, 0.3] },
      warm: { kind: 'ambient', albedo: [0.4, 0.3, 0.2] },
    },
    lights: [{ pos: [0, 0, 50], color: [1, 1, 1] }],
    objects,
    root: { sphere: { center: [0, 0, 0], radius: 100 }, material: null, inside: subtree },
  });
}

/** The envs a node is in, innermost first, ending at 0. */
const envChain = (built, index) => {
  const chain = [];
  for (let e = built.nodes[index].env; ; e = built.nodes[e].env) {
    chain.push(e);
    if (e === 0) return chain;
    assert.ok(chain.length < 50, 'an env chain that does not end');
  }
};
const ball = (x, r, extra = {}) => ({ sphere: { center: [x, 0, 0], radius: r }, ...extra });

test('a node\'s env is the node its ambient region starts at, and envs chain outward', () => {
  const built = buildEnvs(ball(0, 20, { material: 'air', inside: { union: [
    ball(-5, 1, { material: 'clay' }),
    ball(5, 3, { material: 'warm', inside: ball(5, 1, { material: 'clay' }) }),
  ] } }));
  const outerBall = at(built, [-5, 0, 0]).node, innerBall = at(built, [5, 0, 0]).node;
  assert.ok(outerBall && innerBall, 'both balls are there');
  const [outer] = envChain(built, outerBall), [inner] = envChain(built, innerBall);
  assert.deepEqual(envChain(built, outerBall), [outer, 0]);
  assert.deepEqual(envChain(built, innerBall), [inner, outer, 0]);

  // An env node carries its ambient as its material - the level - which
  // does not stop rays: the air between is empty.
  const kindOf = (e) => built.materials[built.nodes[e].material];
  assert.deepEqual(kindOf(outer).albedo, [0.2, 0.2, 0.3]);
  assert.deepEqual(kindOf(inner).albedo, [0.4, 0.3, 0.2]);
  assert.equal(kindOf(outer).solid, false);
  assert.equal(at(built, [0, 10, 0]).solid, false, 'air is no substance');
  assert.equal(at(built, [5, 2, 0]).solid, false);
});

test('regions with the same ambient are different envs; a node inheriting it starts none', () => {
  const built = buildEnvs({ union: [
    ball(-10, 4, { material: 'air', inside: ball(-10, 1, { material: 'clay' }) }),
    // The middle sphere names nothing, so inherits air: a division in the
    // env, not an env of its own.
    ball(10, 4, { material: 'air', inside: ball(10, 3, { inside: ball(10, 1, { material: 'clay' }) }) }),
  ] });
  const [left] = envChain(built, at(built, [-10, 0, 0]).node);
  const right = envChain(built, at(built, [10, 0, 0]).node);
  assert.notEqual(left, right[0], 'two rooms, one ambient: two envs');
  assert.equal(right.length, 2, `inheriting air started an env: ${right}`);
});

test('a subtree used in two envs is baked once for each', () => {
  // Two overlapping regions, both holding the same pebble: one shared
  // subtree, in two envs, so two baked copies - one in each.
  const built = buildEnvs({ union: [
    ball(-2, 5, { material: 'air', inside: { use: 'pebble' } }),
    ball(2, 5, { material: 'warm', inside: { use: 'pebble' } }),
  ] }, { pebble: ball(0, 1, { material: 'clay' }) });
  // The pebble: a unit sphere at the origin, (|R|^2 - 1) / 2.
  const pebbles = built.nodes.filter((nd) => Math.abs(nd.prim.k_perp - 0.5) < 1e-9 &&
    Math.abs(nd.prim.constant + 0.5) < 1e-9 && nd.prim.linear.every((c) => Math.abs(c) < 1e-9));
  // (Three, in fact: the union also grafts the warm region into air's
  // absent outsides, where it is warm-within-air, an env of its own.)
  assert.ok(pebbles.length >= 2, `${pebbles.length} pebbles`);
  assert.equal(new Set(pebbles.map((nd) => nd.env)).size, pebbles.length, 'each in its own env');
  const levels = new Set(pebbles.map((nd) => String(built.materials[built.nodes[nd.env].material].albedo)));
  assert.deepEqual([...levels].sort(), ['0.2,0.2,0.3', '0.4,0.3,0.2']);
  // A ray reaching it comes through air first: the union keeps the first.
  const [first] = envChain(built, at(built, [0, 0, 0]).node);
  assert.deepEqual(built.materials[built.nodes[first].material].albedo, [0.2, 0.2, 0.3]);
});

// -- { "use", "material" }: a placement made of one material ------------------------

/** What fills point R, by its material's albedo; null where nothing does. */
const albedoAt = (built, R) => {
  const { solid, material } = at(built, R);
  return solid ? built.materials[material].albedo : null;
};

const CLAY = [0.7, 0.5, 0.4], SKY = [0.1, 0.1, 0.2], RED = [0.9, 0.1, 0.1];

function buildPainted(subtree, objects) {
  return compileScene({
    materials: {
      clay: { albedo: CLAY },
      sky: { albedo: SKY },
      red: { albedo: RED },
      haze: { kind: 'ambient', albedo: [0.2, 0.2, 0.2] },
    },
    lights: [{ pos: [0, 0, 5], color: [1, 1, 1] }],
    objects,
    root: { sphere: { center: [0, 0, 0], radius: 100 }, material: null, inside: subtree },
  });
}

// Two materials, a hollow - a shell, beyond a complemented sphere, whose
// absent-outside side is the hollow - and in the hollow a vacuum node with
// a node inside it that inherits that; and a ball that names no material,
// so it is whatever its scope is.
const kitObjects = {
  kit: { union: [
    { sphere: { center: [-1.5, 0, 0], radius: 0.8 }, material: 'clay' },
    { sphere: { center: [1.5, 0, 0], radius: 0.8 }, material: 'sky',
      inside: { sphere: { center: [1.5, 0, 0], radius: 0.4, complement: true },
                outside: { sphere: { center: [1.5, 0, 0], radius: 0.4 }, material: null,
                           inside: { sphere: { center: [1.5, 0, 0], radius: 0.2 } } } } },
  ] },
  plain: { sphere: { center: [0, 2, 0], radius: 0.5 } },
};
const HEAD = [-1.5, 0, 0], SHELL = [2.1, 0, 0], HOLLOW = [1.5, 0.3, 0], CORE = [1.5, 0, 0];

const SHAPE_KEYS = { sphere: 1, plane: 1, slab: 1, cylinder: 1 };
/** A subtree with every node's "material" set to m, as written by hand. */
const everyNode = (def, m) => {
  if (Array.isArray(def)) return def.map((d) => everyNode(d, m));
  if (!def || typeof def !== 'object') return def;
  const out = { ...def };
  if (Object.keys(def).some((k) => k in SHAPE_KEYS)) out.material = m;
  for (const k of ['inside', 'outside', 'union']) if (k in def) out[k] = everyNode(def[k], m);
  return out;
};
const fills = (built) => built.nodes.map((nd) => [nd.material, nd.env]);

test('a use with a material: every node as if written with it', () => {
  const own = buildPainted({ use: 'kit' }, kitObjects);
  assert.deepEqual(albedoAt(own, HEAD), CLAY);
  assert.deepEqual(albedoAt(own, SHELL), SKY);
  assert.equal(albedoAt(own, HOLLOW), null);
  assert.equal(albedoAt(own, CORE), null, 'inherits the vacuum node');

  const red = buildPainted({ use: 'kit', material: 'red' }, kitObjects);
  assert.deepEqual(albedoAt(red, HEAD), RED);
  assert.deepEqual(albedoAt(red, SHELL), RED);
  assert.deepEqual(albedoAt(red, CORE), RED, 'the vacuum node is red now, like every other');
  assert.equal(albedoAt(red, HOLLOW), null, 'an absent outside is still empty');
  assert.equal(red.nodes.length, own.nodes.length, 'the same divisions');

  // Any material at all, the same way: vacuum, an ambient, a plain one.
  for (const m of [null, 'haze', 'red']) {
    assert.deepEqual(fills(buildPainted({ use: 'kit', material: m }, kitObjects)),
                     fills(buildPainted(everyNode(kitObjects.kit, m))),
                     `material ${m}`);
  }
});

test('a use with a material fills what would have inherited from around it', () => {
  assert.equal(albedoAt(buildPainted({ use: 'plain' }, kitObjects), [0, 2, 0]), null);
  assert.deepEqual(albedoAt(buildPainted({ use: 'plain', material: 'red' }, kitObjects), [0, 2, 0]), RED);
});

test('a painted use leaves the object, and its other uses, as they were', () => {
  const objects = { ...kitObjects, redKit: { use: 'kit', material: 'red', translate: [0, 0, 3] } };
  const built = buildPainted({ union: ['kit', 'redKit'] }, objects);
  assert.deepEqual(albedoAt(built, HEAD), CLAY);
  assert.equal(albedoAt(built, CORE), null);
  assert.deepEqual(albedoAt(built, [-1.5, 0, 3]), RED);
  assert.deepEqual(albedoAt(built, [1.5, 0, 3]), RED);
});
