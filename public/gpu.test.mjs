// Tests that run antisphere-raycast.wgsl itself, on a real GPU. Run with:
//   npm run test:gpu        (or: node --test gpu.test.mjs)
//
// Every other test here checks a JS transcription of the shader, which can
// agree with itself while the WGSL drifts. These go through the same path the
// page does - ASContext.create, ASScene's packing, castRays and overlapPairs -
// with Dawn (the `webgpu` package) standing in for the browser, and check the
// answers against things that owe nothing to the shader: closed forms for
// single primitives, the boolean formula a CSG operator claims to implement,
// and overlap.js for the overlap certificate.
//
// Without a GPU, or without `npm install`, every test here skips rather than
// fails, so a machine that can't run them still gets a clean `npm test`.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ASContext } from './as-context.js';
import { matrixOf, separation } from './overlap.js';

// -- a device, or a reason there isn't one ------------------------------------

const here = new URL('.', import.meta.url);

async function openContext() {
  let webgpu;
  try { webgpu = await import('webgpu'); }
  catch { return { skip: 'no webgpu package; run npm install' }; }

  // What gpu-setup.js expects of a browser. Node 21+ has a navigator of its
  // own, without gpu; 20 has none at all.
  Object.assign(globalThis, webgpu.globals);
  globalThis.navigator ??= {};
  Object.defineProperty(globalThis.navigator, 'gpu',
                        { value: webgpu.create([]), configurable: true });

  try {
    const ctx = await ASContext.create({
      load: (name) => readFile(new URL(name, here), 'utf8'),
    });
    return { ctx };
  } catch (e) {
    return { skip: `no usable GPU: ${e.message}` };
  }
}

const { ctx, skip } = await openContext();
after(() => ctx?.device.destroy());

const gpuTest = (name, fn) => test(name, { skip }, fn);

// -- helpers --------------------------------------------------------------------

const MATERIALS = { clay: { albedo: [0.7, 0.5, 0.4] }, sky: { albedo: [0.1, 0.1, 0.2] } };

function scene(root) {
  return ctx.createScene({ materials: MATERIALS, lights: [], root });
}

const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };

/** Cast any number of rays, in batches the context's buffers can hold. */
async function cast(sc, rays) {
  const out = { node: [], t0: [] };
  for (let i = 0; i < rays.length; i += 16) {
    const { node, t0 } = await sc.castRays(rays.slice(i, i + 16));
    out.node.push(...node);
    out.t0.push(...t0);
  }
  return out;
}

// -- single primitives against their closed forms ----------------------------------
//
// Each case is a shape and rays whose first hit is known exactly; null means
// the ray must miss. Rays stay clear of grazing, where f32 can honestly go
// either way.

const PRIMITIVES = [
  ['sphere', { sphere: { center: [0, 0, 0], radius: 1 } }, [
    [[-5, 0, 0], [1, 0, 0], 4],
    [[-5, 0.6, 0], [1, 0, 0], 4.2],
    [[0, 0, 7], [0, 0, -1], 6],
    [[-5, 1.5, 0], [1, 0, 0], null],
    [[-5, 0, 0], [-1, 0, 0], null],                  // pointing away
  ]],
  ['plane', { plane: { normal: [0, 0, 1], offset: 0.5 } }, [   // solid below z = 0.5
    [[0, 0, 3], [0, 0, -1], 2.5],
    [[0, 0, 3], norm([1, 0, -1]), 2.5 * Math.SQRT2],
    [[0, 0, 3], [0, 0, 1], null],
  ]],
  ['slab', { slab: { center: [0, 0, 5], axis: [0, 0, 1], thickness: 4 } }, [
    [[0, 0, -1], [0, 0, 1], 4],
    [[0, 0, 12], [0, 0, -1], 5],
    [[0, 0, 0], [1, 0, 0], null],                    // parallel, below it
  ]],
  ['cylinder', { cylinder: { center: [2, 0, 0], axis: [0, 0, 1], radius: 2 } }, [
    [[-3, 0, 7], [1, 0, 0], 3],
    [[-3, 1.2, -4], [1, 0, 0], 5 - Math.sqrt(4 - 1.44)],
    [[-3, 2.5, 0], [1, 0, 0], null],
  ]],
  ['cone', { cone: { apex: [0, 0, 2], axis: [0, 0, 1], slope: 0.5 } }, [
    [[-5, 0, 4], [1, 0, 0], 4],                      // radius 1 there
    [[-5, 0, 6], [1, 0, 0], 3],                      // radius 2
  ]],
  ['paraboloid', { paraboloid: { vertex: [0, 0, 0], axis: [0, 0, 1], focal: 1 } }, [
    [[1, 0, -5], [0, 0, 1], 5.25],                   // z = r^2 / 4f
    [[-5, 0, 1], [1, 0, 0], 3],
  ]],
  ['hyperboloid, two sheets', { hyperboloid: { center: [0, 0, 0], axis: [0, 0, 1],
                                               radius: 1, semiAxial: 1, sheets: 2 } }, [
    [[0, 0, 0], [0, 0, 1], 1],
    [[0.75, 0, 0], [0, 0, 1], 1.25],
    [[0, 0, 0], [0, 0, -1], 1],
    [[0, 0, 0], [1, 0, 0], null],                    // the gap between the sheets
  ]],
];

for (const [label, shape, cases] of PRIMITIVES) {
  gpuTest(`trace() hits a ${label} where the closed form says`, async () => {
    const sc = scene({ ...shape, material: 'clay' });
    const rays = cases.map(([origin, direction]) => ({ origin, direction }));
    const { node, t0 } = await cast(sc, rays);
    cases.forEach(([origin, direction, expected], i) => {
      const what = `${label}: ray from (${origin}) along (${direction.map((v) => +v.toFixed(3))})`;
      if (expected === null) {
        assert.equal(node[i], 0, `${what} should miss, hit at ${t0[i]}`);
      } else {
        assert.notEqual(node[i], 0, `${what} should hit at ${expected}, missed`);
        assert.ok(Math.abs(t0[i] - expected) < 1e-4,
                  `${what}: t0 ${t0[i]}, expected ${expected}`);
      }
    });
    sc.destroy();
  });
}

// -- CSG against the formula it implements ------------------------------------------
//
// Along each ray, the first hit is the first t where the formula turns true.
// That is found by marching and then bisecting on the formula alone, so the
// only thing this shares with the shader is the scene spec.

const ball = (c, r) => (R) => (R[0] - c[0]) ** 2 + (R[1] - c[1]) ** 2 + (R[2] - c[2]) ** 2 < r * r;
const A = { sphere: { center: [-0.5, 0, 0], radius: 1 }, material: 'clay' };
const B = { sphere: { center: [0.5, 0, 0], radius: 1 }, material: 'sky' };
const inA = ball([-0.5, 0, 0], 1), inB = ball([0.5, 0, 0], 1);
const inUnit = ball([0, 0, 0], 1), inCore = ball([0, 0, 0], 0.5);

const OPERATORS = [
  ['union', { union: [A, B] }, (R) => inA(R) || inB(R)],
  ['intersect', { intersect: [A, B] }, (R) => inA(R) && inB(R)],
  ['difference', { difference: [A, B] }, (R) => inA(R) && !inB(R)],
  ['reversed difference', { difference: [B, A] }, (R) => inB(R) && !inA(R)],
  ['hollow shell',
   { difference: [{ sphere: { center: [0, 0, 0], radius: 1 }, material: 'clay' },
                  { sphere: { center: [0, 0, 0], radius: 0.5 }, material: 'sky' }] },
   (R) => inUnit(R) && !inCore(R)],
];

// tMin is castRays' default: a ray that starts in solid hits right there.
function firstEntry(solid, O, D, tMin = 1e-3, tMax = 10) {
  const at = (t) => [O[0] + t * D[0], O[1] + t * D[1], O[2] + t * D[2]];
  if (solid(at(tMin))) return tMin;
  const dt = 1e-3;
  for (let t = tMin + dt; t < tMax; t += dt) {
    if (!solid(at(t))) continue;
    let lo = t - dt, hi = t;
    for (let i = 0; i < 40; i++) {
      const mid = 0.5 * (lo + hi);
      if (solid(at(mid))) hi = mid; else lo = mid;
    }
    return hi;
  }
  return null;
}

// Rays in several directions through the pair, including some that start
// inside the hollow and some that cross a cut face first.
const CSG_RAYS = [];
for (const y of [-0.9, -0.55, -0.3, 0, 0.2, 0.45, 0.8, 1.3]) {
  for (const z of [0, 0.35]) {
    CSG_RAYS.push({ origin: [-4, y, z], direction: [1, 0, 0] });
    CSG_RAYS.push({ origin: [4, y, z], direction: [-1, 0, 0] });
  }
}
for (const x of [-1.2, -0.5, 0, 0.3, 0.9]) {
  CSG_RAYS.push({ origin: [x, -4, 0.1], direction: [0, 1, 0] });
}
CSG_RAYS.push({ origin: [0, 0, 0], direction: [1, 0, 0] });       // from the core
CSG_RAYS.push({ origin: [0, 0, 0], direction: norm([1, 1, 1]) });
CSG_RAYS.push({ origin: [-3, -2, -1], direction: norm([3, 2, 1]) });

for (const [label, subtree, solid] of OPERATORS) {
  gpuTest(`trace() agrees with the formula for ${label}`, async () => {
    // Wrapped in vacuum, as antisphere-csg.test.mjs does, so the operator's
    // own subtree is all there is.
    const sc = scene({ sphere: { center: [0, 0, 0], radius: 100 }, material: null,
                       inside: subtree });
    const { node, t0 } = await cast(sc, CSG_RAYS);
    CSG_RAYS.forEach(({ origin, direction }, i) => {
      const expected = firstEntry(solid, origin, direction);
      const what = `${label}: ray from (${origin}) along (${direction.map((v) => +v.toFixed(3))})`;
      if (expected === null) {
        assert.equal(node[i], 0, `${what} should miss, hit at ${t0[i]}`);
      } else {
        assert.notEqual(node[i], 0, `${what} should hit at ${expected}, missed`);
        assert.ok(Math.abs(t0[i] - expected) < 1e-4,
                  `${what}: t0 ${t0[i]}, expected ${expected}`);
      }
    });
    sc.destroy();
  });
}

// -- overlapFrom() against overlap.js ----------------------------------------------

// Five shapes in a vacuum shell. Node 1 is the shell, as the root always is.
const OVERLAP_SCENE = { sphere: { center: [0, 0, 0], radius: 100 }, material: null, inside: {
  union: [
    { sphere: { center: [-3, 0, 0], radius: 1 }, material: 'clay' },
    { sphere: { center: [-1.5, 0, 0], radius: 1 }, material: 'clay' },
    { cylinder: { center: [3, 0, 0], axis: [0, 0, 1], radius: 0.5 }, material: 'sky' },
    { slab: { center: [0, 0, 5], axis: [0, 0, 1], thickness: 1 }, material: 'clay' },
    { cone: { apex: [0, 4, 0], axis: [0, 1, 0], slope: 0.3 }, material: 'sky' },
  ],
} };

// The cone is the only node with negative curvature along its axis.
const coneOf = (sc) => sc.nodes.findIndex((nd, i) => i > 0 && nd.prim.k_par < 0);

// Outside the shell and outside the cone plainly overlap - everything far
// enough away is in both - and the GPU "proves" them apart with a margin of
// about +3, which after normalization should not even be possible. The CPU
// gets it right in f64, and a literal f32 transcription of overlapMargin()
// gets -0.01: right, barely. So the characteristic-polynomial eigenvalue
// loses most of its precision in f32, and this driver's arithmetic (fused
// multiply-adds, its own determinant()) loses the rest. Excluded from the
// test below and checked on its own, so it stays visible until it is fixed.
const isKnownBad = (sc, { a, b, signA, signB }) =>
  a === 1 && b === coneOf(sc) && signA < 0 && signB < 0;

const cpuMargin = (sc, { a, b, signA, signB }) =>
  separation(matrixOf(sc.nodes[a].prim, signA), matrixOf(sc.nodes[b].prim, signB)).margin;

gpuTest('overlapFrom() agrees with overlap.js on every pair of nodes', async () => {
  const sc = scene(OVERLAP_SCENE);
  const pairs = [];
  for (let a = 1; a < sc.nodes.length; a++) {
    for (let b = a + 1; b < sc.nodes.length; b++) {
      for (const signA of [1, -1]) for (const signB of [1, -1]) pairs.push({ a, b, signA, signB });
    }
  }
  const margins = await sc.overlapPairs(pairs);

  // The verdict has to match wherever the CPU is not itself on the fence.
  // The margin's size only means something when it is positive - how much
  // room the proof has. A negative margin is just "no certificate", and its
  // value is wherever the ternary search happened to stop, which f32 and f64
  // can legitimately disagree on: the search assumes the objective is
  // unimodal, and smallestEigenvalue() near a repeated eigenvalue can make it
  // not so.
  let decided = 0;
  pairs.forEach((pair, i) => {
    if (isKnownBad(sc, pair)) return;
    const cpu = cpuMargin(sc, pair);
    const { a, b, signA, signB } = pair;
    const what = `nodes ${a}(${signA > 0 ? 'in' : 'out'}) and ${b}(${signB > 0 ? 'in' : 'out'})`;
    if (cpu > 1e-3) {
      assert.ok(Math.abs(margins[i] - cpu) < 1e-3, `${what}: GPU ${margins[i]}, CPU ${cpu}`);
    }
    if (Math.abs(cpu) > 1e-3) {
      decided++;
      assert.equal(margins[i] > 0, cpu > 0, `${what}: GPU ${margins[i]}, CPU ${cpu}`);
    }
  });
  assert.ok(decided > pairs.length / 2, `only ${decided} of ${pairs.length} pairs were decisive`);
  sc.destroy();
});

test('overlapFrom() does not prove outside-the-shell and outside-a-cone apart',
     { skip, todo: 'f32 eigenvalue precision; see isKnownBad' }, async () => {
  const sc = scene(OVERLAP_SCENE);
  const pair = { a: 1, b: coneOf(sc), signA: -1, signB: -1 };
  const [margin] = await sc.overlapPairs([pair]);
  sc.destroy();
  assert.ok(cpuMargin(sc, pair) < 0, 'the CPU should find no certificate');
  assert.ok(margin < 0, `GPU margin ${margin} claims a proof`);
});
