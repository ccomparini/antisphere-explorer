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

test('a difference can be a group member, and is bounded by what it cuts', () => {
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
  assert.ok(scene.nodes.length > 4);
  // The bore really is bored: on the axis, inside the sphere, nothing solid.
  assert.equal(solidAt(scene, [0, 0, 0]), false);
  assert.equal(solidAt(scene, [0.7, 0, 0]), true);
});

// -- overlapping groups ----------------------------------------------------------------

test('an overlapping group is A or B or C, and reports that A and B overlap', () => {
  const C = { sphere: { center: [0, 0, 3], radius: 0.5 }, material: 'clay' };
  const inC = (R) => R[0] ** 2 + R[1] ** 2 + (R[2] - 3) ** 2 < 0.25;
  const built = build({ group: [A, B, C], overlapping: true });
  agrees(built, (R) => inA(R) || inB(R) || inC(R), 'overlapping group',
         [...CLEAR, [0, 0, 3], [0.2, 0.1, 2.8], [0, 0, 3.6]]);
  assert.deepEqual(built.overlaps, [{ group: 'root.inside', members: [0, 1] }]);
  // Without the flag, the same members are still refused.
  assert.throws(() => build({ group: [A, B, C] }), /not mutually exterior/);
});

test('an overlapping group of many members is their union, and finds exactly the pairs whose bounds meet', () => {
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
  const built = build({ group: members, overlapping: true });
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

  // The pairs: every pair whose balls meet (as the group nudges them), and
  // no other.
  const grown = balls.map((b) => ({ c: b.c, r: b.r * (1 + 1e-4) + 1e-6 }));
  const expected = [];
  for (let i = 0; i < grown.length; i++) {
    for (let j = i + 1; j < grown.length; j++) {
      const d = Math.hypot(...grown[i].c.map((v, k) => v - grown[j].c[k]));
      if (d < grown[i].r + grown[j].r) expected.push([i, j]);
    }
  }
  const got = built.overlaps.map((o) => o.members).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  assert.ok(expected.length > 3 && expected.length < 100, `a fair test: ${expected.length} overlapping pairs`);
  assert.deepEqual(got, expected);
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
