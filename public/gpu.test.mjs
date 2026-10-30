// Tests that run antisphere-raycast.wgsls itself, on a real GPU. Run with:
//   npm run test:gpu        (or: node --test gpu.test.mjs)
//
// Every other test here checks a JS transcription of the shader, which can
// agree with itself while the WGSL drifts. These go through the same path the
// page does - ASContext.create, ASScene's packing and castRays - with Dawn
// (the `webgpu` package) standing in for the browser, and check the
// answers against things that owe nothing to the shader: closed forms for
// single primitives, the boolean formula a CSG operator claims to implement,
// and overlap.js for the overlap certificate.
//
// Without a GPU, or without `npm install`, every test here skips rather than
// fails, so a machine that can't run them still gets a clean `npm test`.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { writeSTL } from './stl.js';
import { ASContext } from './as-context.js';
import { readScene, withReferences } from './antisphere-scene.js';
import { matrixOf, separation } from './overlap.js';
import { OverlapQuery, OverlapResult, viewsOf } from './gen/layouts.js';
import { sharedStructs } from '../tools/shader-build/layout.js';
import { emitModule } from '../tools/shader-build/emit-js.js';
import { buildAll } from '../tools/shader-build/index.js';
import { build } from '../tools/shader-build/preprocess.js';
import { assignBindings } from '../tools/shader-build/bindings.js';
import { bindGroup } from './bind-group.js';
import { quadricAt, gradientAt } from './quadric.js';

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

  // No GPU to be had is a reason to skip; anything after that - a shader
  // that doesn't compile, a pipeline that doesn't build - is a failure of
  // every test here, not a skip, so a broken shader can't pass for a
  // missing GPU.
  let adapter = null;
  try { adapter = await navigator.gpu.requestAdapter(); }
  catch (e) { return { skip: `no usable GPU: ${e.message}` }; }
  if (!adapter) return { skip: 'no usable GPU: no adapter' };
  try {
    const ctx = await ASContext.create({
      load: (name) => readFile(new URL(name, here), 'utf8'),
    });
    return { ctx };
  } catch (e) {
    return { broken: e };
  }
}

const { ctx, skip, broken } = await openContext();
after(() => ctx?.device.destroy());

const gpuTest = (name, fn) => test(name, { skip }, broken ? () => { throw broken; } : fn);

// -- helpers --------------------------------------------------------------------

const MATERIALS = { clay: { albedo: [0.7, 0.5, 0.4] }, sky: { albedo: [0.1, 0.1, 0.2] } };

function scene(root) {
  return ctx.createScene({ materials: MATERIALS, lights: [], root });
}

const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };

/** Cast any number of rays, in batches the context's buffers can hold. */
async function cast(sc, rays) {
  const out = { node: [], t0: [] };
  // (tMin, tMax and fromNode, if a ray has them, go through as they are.)
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

// The same shapes and rays, 1300 m from the origin. Expanded about the
// origin, a quadric's constant term there is k |p|^2 ~ 1e6 k, and H near
// the surface the small difference of such terms: f32 kept few of its
// digits, so hits wandered by centimetres and grazing rays flipped (the
// rocket's edges flickering in physlab, 500 m out). Each node is anchored
// near itself now (see Node), so it is as exact here as at the origin.
const FAR = [1000, -700, 400];

for (const [label, shape, cases] of PRIMITIVES) {
  gpuTest(`trace() hits a ${label} 1300 m out as it does at the origin`, async () => {
    const sc = scene({ ...shape, material: 'clay', translate: FAR });
    const rays = cases.map(([origin, direction]) => ({ origin: origin.map((v, i) => v + FAR[i]), direction }));
    const { node, t0 } = await cast(sc, rays);
    let worst = 0;
    cases.forEach(([origin, direction, expected], i) => {
      const what = `${label}, far: ray from (${origin}) along (${direction.map((v) => +v.toFixed(3))})`;
      if (expected === null) {
        assert.equal(node[i], 0, `${what} should miss, hit at ${t0[i]}`);
      } else {
        assert.notEqual(node[i], 0, `${what} should hit at ${expected}, missed`);
        worst = Math.max(worst, Math.abs(t0[i] - expected));
        assert.ok(Math.abs(t0[i] - expected) < 1e-4, `${what}: t0 ${t0[i]}, expected ${expected}`);
      }
    });
    console.log(`# ${label}, 1300 m out: worst hit error ${(worst * 1000).toFixed(3)} mm`);
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
  ['intersection', { intersection: [A, B] }, (R) => inA(R) && inB(R)],
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

// -- rays leaving a surface: fromNode ----------------------------------------------
//
// A shadow ray starts exactly on the surface the camera ray hit. Computed
// from the rounded hit point, that surface's H is a little either side of
// zero, so the ray could hit its own surface at once; an offset to step
// clear of it is wrong at some scale. Given the node it leaves (fromNode),
// trace() takes that surface - and its copies - as exactly through the
// start: no offset, no tolerance.

gpuTest('a ray leaving a surface (fromNode) never hits it there, and still hits what is in the way', async () => {
  // A sphere, and a box of slabs, each with a small ball between it and a
  // light, so some rays from it are blocked and the rest must go clear.
  const targets = [
    { center: [0, 0, 0], shape: { sphere: { center: [0, 0, 0], radius: 1 } } },
    { center: [0, 4, 0], shape: { intersection: [
      { slab: { center: [0, 4, 0], axis: [1, 0, 0], thickness: 2 } },
      { slab: { center: [0, 4, 0], axis: [0, 1, 0], thickness: 2 } },
      { slab: { center: [0, 4, 0], axis: [0, 0, 1], thickness: 2 } },
    ] } },
  ];
  const blockers = targets.map(({ center }) => ({ c: [-3, center[1], 0], r: 0.5 }));
  const sc = scene({ union: [
    ...targets.map(({ shape }) => ({ ...shape, material: 'clay' })),
    ...blockers.map(({ c, r }) => ({ sphere: { center: c, radius: r }, material: 'clay' })),
  ] });
  // Does the segment from p to q pass through ball b (not merely touch it)?
  const blocked = (p, q, { c, r }) => {
    const d = q.map((v, i) => v - p[i]), len = Math.hypot(...d), u = d.map((v) => v / len);
    const m = p.map((v, i) => v - c[i]);
    const bq = m[0] * u[0] + m[1] * u[1] + m[2] * u[2], cq = m[0] ** 2 + m[1] ** 2 + m[2] ** 2 - r * r;
    const disc = bq * bq - cq;
    if (disc <= 1e-9) return false;
    const t0 = -bq - Math.sqrt(disc), t1 = -bq + Math.sqrt(disc);
    return t1 > 0 && t0 < len;
  };
  let selfHits = 0, checked = 0;
  for (const [k, { center }] of targets.entries()) {
    // Camera rays from the -x side, across the target's face.
    const cams = [];
    for (let y = -0.85; y <= 0.85; y += 0.05) for (let z = -0.85; z <= 0.85; z += 0.05) {
      cams.push({ origin: [-6, center[1] + y, z], direction: [1, 0, 0] });
    }
    const hits = await cast(sc, cams);
    const light = [-10, center[1] + 0.3, 0.2];
    const leaving = [], expected = [];
    cams.forEach(({ origin, direction }, i) => {
      if (!hits.node[i]) return;
      const p = origin.map((v, j) => v + hits.t0[i] * direction[j]);
      // Only points on the target, not on its blocker.
      if (Math.abs(p[0]) > 1.01) return;
      const d = light.map((v, j) => v - p[j]), dist = Math.hypot(...d);
      // And only where the light is in front of the surface, as shading
      // asks (behind it, the ray goes into the target, and hitting it is
      // right): the sphere's normal is radial, the box's its nearest face's.
      const q = p.map((v, j) => v - center[j]);
      const axis = q.map(Math.abs).indexOf(Math.max(...q.map(Math.abs)));
      const normal = k === 0 ? q : q.map((v, j) => (j === axis ? Math.sign(v) : 0));
      if (normal[0] * d[0] + normal[1] * d[1] + normal[2] * d[2] <= 0) return;
      leaving.push({ origin: p, direction: d.map((v) => v / dist), tMin: 0, tMax: dist, fromNode: hits.node[i] });
      expected.push(blocked(p, light, blockers[k]));
    });
    const out = await cast(sc, leaving);
    leaving.forEach((ray, i) => {
      checked++;
      const hit = out.node[i] !== 0;
      if (hit && !expected[i]) selfHits++;
      if (!hit && expected[i]) assert.fail(`target ${k}: a ray from ${ray.origin.map((v) => v.toFixed(3))} went through its blocker`);
    });
  }
  assert.ok(checked > 500, `only ${checked} rays checked`);
  assert.equal(selfHits, 0, `${selfHits} of ${checked} rays hit the surface they left`);
  sc.destroy();
});

gpuTest('a ray leaving a crater floor is still blocked by the same sphere\'s far wall', async () => {
  // Starting on a surface discards only the crossing where the ray is; the
  // same surface further on still counts. A crater: the ground less a ball
  // of radius 3 at the origin. From its floor, toward a light low over the
  // far rim, the ray must hit the far wall - the same sphere it left.
  const sc = scene({ intersection: [
    { plane: { normal: [0, 0, 1], offset: 0 }, material: 'clay' },
    { sphere: { center: [0, 0, 0], radius: 3 }, complement: true, material: 'clay' },
  ] });
  const cams = [];
  for (let x = -1; x <= 1; x += 0.25) for (let y = -1; y <= 1; y += 0.25) cams.push({ origin: [x, y, 10], direction: [0, 0, -1] });
  const hits = await cast(sc, cams);
  const leaving = [], low = [], high = [];
  cams.forEach(({ origin, direction }, i) => {
    assert.notEqual(hits.node[i], 0, 'the floor is hit');
    const p = origin.map((v, j) => v + hits.t0[i] * direction[j]);
    for (const [light, list] of [[[40, 0, 4], low], [[0, 0, 40], high]]) {
      const d = light.map((v, j) => v - p[j]), dist = Math.hypot(...d);
      list.push(leaving.length);
      leaving.push({ origin: p, direction: d.map((v) => v / dist), tMin: 0, tMax: dist, fromNode: hits.node[i] });
    }
  });
  const out = await cast(sc, leaving);
  for (const i of low) {
    const { origin: p, direction: d } = leaving[i];
    const what = `from ${p.map((v) => v.toFixed(2))}`;
    assert.notEqual(out.node[i], 0, `${what}, the far wall should block a low light`);
    // Where: the far side of the ball, |p + t d| = 3 with t > 0 - not at
    // the start, which a surface ignored rather than started on gives.
    const b = p[0] * d[0] + p[1] * d[1] + p[2] * d[2], c = p[0] ** 2 + p[1] ** 2 + p[2] ** 2 - 9;
    const wall = -b + Math.sqrt(b * b - c);
    assert.ok(Math.abs(out.t0[i] - wall) < 1e-3, `${what}: blocked at ${out.t0[i]}, the far wall is at ${wall}`);
  }
  for (const i of high) assert.equal(out.node[i], 0, `from ${leaving[i].origin.map((v) => v.toFixed(2))}, nothing is above`);
  sc.destroy();
});

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

const cpuMargin = (sc, { a, b, signA, signB }) =>
  separation(matrixOf(sc.nodes[a].prim, signA), matrixOf(sc.nodes[b].prim, signB)).margin;

// overlap.wgsls is a library, not a build output, so its batch entry point
// is built here from source: overlapFrom() alone, bound to a scene's nodes.
let overlapShader = null;
async function overlapShaderOf() {
  if (!overlapShader) {
    const read = (path) => readFile(new URL(`../${path}`, here), 'utf8');
    const { code, slots, entries } = assignBindings((await build('shaders/overlap.wgsls', { read })).code);
    const module = ctx.device.createShaderModule({ code });
    const pipeline = ctx.device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'overlapFrom' },
    });
    overlapShader = { pipeline, bindings: { slots, entries } };
  }
  return overlapShader;
}

/**
 * The GPU's margin for each pair of regions: { a, b } node indices of the
 * scene, optional signs (+1 inside, the default; -1 outside) and an
 * optional frame ({ c, L }, as for overlap.js's regionsDisjoint).
 */
async function overlapPairs(sc, pairs) {
  const { device } = ctx;
  const { pipeline, bindings } = await overlapShaderOf();
  const queries = OverlapQuery.allocate(pairs.length);
  pairs.forEach((pair, i) => OverlapQuery.write(queries, i, {
    node_a: pair.a,
    node_b: pair.b,
    sign_a: pair.signA ?? 1,
    sign_b: pair.signB ?? 1,
    frame_centre: pair.frame?.c ?? [0, 0, 0],
    frame_length: pair.frame?.L ?? 0,
  }));
  const queryBuf = device.createBuffer({
    size: queries.buffer.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(queryBuf, 0, queries.buffer);
  const bytes = pairs.length * OverlapResult.STRIDE;
  const resultBuf = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readBuf = device.createBuffer({
    size: bytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const group = bindGroup(
    device,
    pipeline,
    bindings,
    'overlapFrom', {
      nodes: sc.nodeBuf,
      overlapQueries: queryBuf,
      overlapResults: resultBuf,
    }
  );
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(Math.ceil(pairs.length / 64));
  pass.end();
  enc.copyBufferToBuffer(resultBuf, 0, readBuf, 0, bytes);
  device.queue.submit([enc.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const results = viewsOf(readBuf.getMappedRange().slice(0));
  readBuf.unmap();
  for (const b of [queryBuf, resultBuf, readBuf]) b.destroy();
  return Float32Array.from(pairs, (_, i) => OverlapResult.read(results, i).margin);
}

// shaders/overlap.wgsls's OVERLAP_TAU: the GPU's margin is only a verdict
// outside this band, and inside it is touching.
const TAU = 1e-5;

function allPairs(sc) {
  const pairs = [];
  for (let a = 1; a < sc.nodes.length; a++) {
    for (let b = a + 1; b < sc.nodes.length; b++) {
      for (const signA of [1, -1]) for (const signB of [1, -1]) pairs.push({ a, b, signA, signB });
    }
  }
  return pairs;
}

gpuTest('overlapFrom() agrees with overlap.js on every pair of nodes', async () => {
  const sc = scene(OVERLAP_SCENE);
  const pairs = allPairs(sc);
  const margins = await overlapPairs(sc, pairs);

  // The GPU stops as soon as it is sure, so its margin is one that settles
  // the question rather than the best there is: compare verdicts, against
  // the CPU's full search, wherever the CPU is not itself on the fence.
  let decided = 0;
  pairs.forEach((pair, i) => {
    const cpu = cpuMargin(sc, pair);
    if (Math.abs(cpu) <= 1e-3) return;
    decided++;
    const { a, b, signA, signB } = pair;
    const what = `nodes ${a}(${signA > 0 ? 'in' : 'out'}) and ${b}(${signB > 0 ? 'in' : 'out'})`;
    if (cpu > 0) assert.ok(margins[i] > TAU, `${what} should be apart: GPU ${margins[i]}, CPU ${cpu}`);
    else assert.ok(margins[i] < -TAU, `${what} should overlap: GPU ${margins[i]}, CPU ${cpu}`);
  });
  assert.ok(decided > pairs.length / 2, `only ${decided} of ${pairs.length} pairs were decisive`);
  sc.destroy();
});

// Once a false proof: the characteristic polynomial lost its digits in f32
// and the GPU "proved" these apart with a margin of +3.
gpuTest('overlapFrom() does not prove outside-the-shell and outside-a-cone apart', async () => {
  const sc = scene(OVERLAP_SCENE);
  const pair = { a: 1, b: coneOf(sc), signA: -1, signB: -1 };
  const [margin] = await overlapPairs(sc, [pair]);
  assert.ok(cpuMargin(sc, pair) < 0, 'the CPU should find no certificate');
  assert.ok(margin < -TAU, `GPU margin ${margin} should be an overlap`);
  sc.destroy();
});

gpuTest('overlapFrom() calls touching touching, to f32', async () => {
  // Two unit balls meeting at the origin, and a ball resting on a plane.
  const sc = scene({ sphere: { center: [0, 0, 0], radius: 100 }, material: null, inside: {
    union: [
      { sphere: { center: [-1, 0, 0], radius: 1 }, material: 'clay' },
      { sphere: { center: [1, 0, 0], radius: 1 }, material: 'clay' },
      { sphere: { center: [0, 5, 1], radius: 1 }, material: 'clay' },
      { plane: { normal: [0, 0, 1], offset: 0 }, material: 'clay' },
    ],
  } });
  const ball = (x, y, z) => sc.nodes.findIndex((nd, i) =>
    i > 1 && nd.prim.k_perp > 0 && Math.hypot(nd.prim.linear[0] / nd.prim.k_perp + x,
                                              nd.prim.linear[1] / nd.prim.k_perp + y,
                                              nd.prim.linear[2] / nd.prim.k_perp + z) < 1e-6);
  const plane = sc.nodes.findIndex((nd, i) => i > 0 && nd.prim.k_perp === 0 && nd.prim.k_par === 0);
  const pairs = [{ a: ball(-1, 0, 0), b: ball(1, 0, 0), signA: 1, signB: 1 },
                 { a: ball(0, 5, 1), b: plane, signA: 1, signB: 1 }];
  for (const p of pairs) assert.ok(p.a > 0 && p.b > 0, 'found the nodes');
  const margins = await overlapPairs(sc, pairs);
  for (const m of margins) assert.ok(Math.abs(m) <= TAU, `touching margin ${m}`);
  sc.destroy();
});

// overlap.test.mjs's planet and balls, on the GPU. Scaled for the planet, a
// 2 m ball's overlap with the planet's outside reads a margin far inside
// what counts as touching; measured in the ball's own frame it is clear.
gpuTest('overlapFrom() in a frame near the smaller one decides a small ball beside a big one', async () => {
  const cases = [
    // centre, radius, apart from the planet's inside, from its outside
    [[20, 0, 502], 2.2, true, false],     // just above the ground
    [[0, 0, 600], 2, true, false],        // well above
    [[0, 0, 501], 2, false, false],       // half sunk
    [[0, 0, 502], 2, true, false],        // resting on it: touching is apart
    [[0, 0, 30], 2, false, true],         // deep inside
  ];
  const sc = scene({ sphere: { center: [0, 0, 0], radius: 2000 }, material: null, inside: {
    union: [{ sphere: { center: [0, 0, 0], radius: 500 }, material: 'clay' },
            ...cases.map(([center, radius]) => ({ sphere: { center, radius }, material: 'clay' }))],
  } });
  // A sphere's node: k = 1 / 2r, and linear = -k C.
  const sphereNode = (c, r) => sc.nodes.findIndex((nd, i) => i > 1 &&
    Math.abs(nd.prim.k_perp * 2 * r - 1) < 1e-9 &&
    Math.hypot(...nd.prim.linear.map((v, j) => v / nd.prim.k_perp + c[j])) < 1e-6);
  const planet = sphereNode([0, 0, 0], 500);
  const pairs = [], expect = [];
  for (const [c, r, fromInside, fromOutside] of cases) {
    const ball = sphereNode(c, r);
    assert.ok(planet > 0 && ball > 0, 'found the nodes');
    const frame = { c, L: r };
    pairs.push({ a: planet, b: ball, signA: 1, signB: 1, frame },
               { a: planet, b: ball, signA: -1, signB: 1, frame });
    expect.push([fromInside, `${c} r ${r}: the planet's inside`], [fromOutside, `${c} r ${r}: its outside`]);
  }
  const margins = await overlapPairs(sc, pairs);
  expect.forEach(([apart, what], i) => assert.equal(margins[i] > -TAU, apart, `${what}: margin ${margins[i]}`));
  sc.destroy();
});

gpuTest('overlapFrom() batch timing (logged, not asserted)', async (t) => {
  // A crowd of shapes, deterministic, for a before/after number.
  let seed = 1;
  const rnd = (lo, hi) => lo + ((seed = (seed * 16807) % 2147483647) / 2147483647) * (hi - lo);
  const vec = () => [rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)];
  const makers = [
    () => ({ sphere: { center: vec().map((v) => v * 4), radius: rnd(0.3, 1.5) } }),
    () => ({ cylinder: { center: vec().map((v) => v * 4), axis: vec(), radius: rnd(0.3, 1.2) } }),
    () => ({ slab: { center: vec().map((v) => v * 4), axis: vec(), thickness: rnd(0.3, 2) } }),
    () => ({ cone: { apex: vec().map((v) => v * 4), axis: vec(), slope: rnd(0.2, 1.2) } }),
    () => ({ plane: { normal: vec(), offset: rnd(-2, 2) } }),
  ];
  const sc = scene({ sphere: { center: [0, 0, 0], radius: 100 }, material: null, inside: {
    union: Array.from({ length: 24 }, (_, i) => ({ ...makers[i % 5](), material: 'clay' })),
  } });
  const pairs = allPairs(sc).slice(0, 1024);
  await overlapPairs(sc, pairs);                          // warm up
  const runs = 20, start = performance.now();
  for (let i = 0; i < runs; i++) await overlapPairs(sc, pairs);
  t.diagnostic(`${pairs.length} pairs: ${((performance.now() - start) / runs).toFixed(2)} ms ` +
               'per batch, round trip included');
  sc.destroy();
});

// -- generated struct layouts against Dawn's -------------------------------------
//
// tools/shader-build works out struct layouts from the WGSL spec's rules.
// These check its answer against the compiler's: for each shared struct, a
// shader writes a distinct value into every scalar in it, the generated JS
// class writes the same values into its own buffer, and the two must match
// byte for byte - every offset right, and padding left zero on both sides.

// A struct with the layout features our shaders don't use (yet).
const LAYOUT_ZOO = `
struct Inner { x : f32, y : vec2<f32> }
struct Zoo {
  a : u32,
  b : vec3<f32>,
  c : i32,
  m : mat3x3<f32>,
  n : mat2x2f,
  arr : array<vec3<f32>, 2>,
  @size(12) s : f32,
  inner : Inner,
  @align(32) late : u32,
  inners : array<Inner, 2>,
}
@group(0) @binding(0) var<storage, read_write> zoo : array<Zoo>;
`;

// A distinct value for every scalar in a layout, as the JS value to write
// and the WGSL statements that write the same; i32s go negative.
function fillAll(type, path, next, statements) {
  const scalar = (t, p) => {
    const k = next();
    const v = t === 'i32' ? -k : k;
    statements.push(`${p} = ${t}(${v});`);
    return v;
  };
  switch (type.kind) {
    case 'scalar': return scalar(type.scalar, path);
    case 'vector': return Array.from({ length: type.n }, (_, j) => scalar(type.scalar, `${path}[${j}]`));
    case 'matrix': return Array.from({ length: type.c }, (_, c) =>
      Array.from({ length: type.r }, (_, r) => scalar(type.scalar, `${path}[${c}][${r}]`)));
    case 'array': return Array.from({ length: type.count }, (_, i) => fillAll(type.elem, `${path}[${i}]`, next, statements));
    case 'struct': return Object.fromEntries(type.members.map((m) =>
      [m.name, fillAll(m.type, `${path}.${m.name}`, next, statements)]));
  }
  throw new Error(`unknown kind ${type.kind}`);
}

/** Checks every struct `code` shares; returns their names. */
async function checkLayouts(code) {
  const { device } = ctx;
  const structs = sharedStructs(code);
  const classes = await import(`data:text/javascript,${encodeURIComponent(emitModule(structs, '// check'))}`);
  for (const s of structs) {
    let k = 0;
    const statements = [];
    const values = fillAll(s, 'layoutCheckOut[0]', () => ++k, statements);
    // Appended to the source that declares the struct; binding 999 is clear
    // of every binding the source itself uses.
    const checkCode = `${code}
@group(0) @binding(999) var<storage, read_write> layoutCheckOut : array<${s.name}>;
@compute @workgroup_size(1) fn layoutCheck() {
  ${statements.join('\n  ')}
}`;
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ code: checkCode });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'layoutCheck' } });
    const out = device.createBuffer({ size: s.size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readBuf = device.createBuffer({ size: s.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 999, resource: { buffer: out } }],
    }));
    pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(out, 0, readBuf, 0, s.size);
    device.queue.submit([enc.finish()]);
    const err = await device.popErrorScope();
    if (err) throw new Error(`${s.name}: ${err.message}`);
    await readBuf.mapAsync(GPUMapMode.READ);
    const gpu = readBuf.getMappedRange().slice(0);
    readBuf.unmap();
    out.destroy();
    readBuf.destroy();

    const cls = classes[s.name];
    const mine = cls.allocate(1);
    cls.write(mine, 0, values);
    const a = new Uint8Array(gpu), b = new Uint8Array(mine.buffer);
    assert.equal(b.length, a.length, `${s.name}: size`);
    const at = a.findIndex((byte, i) => byte !== b[i]);
    if (at >= 0) {
      const field = s.members.findLast((m) => m.offset <= at);
      assert.fail(`${s.name}: byte ${at} (in or after ${field?.name}) is ${a[at]} from Dawn, ${b[at]} from JS`);
    }
    assert.deepEqual(cls.read(classes.viewsOf(gpu), 0), values, `${s.name}: read back`);
  }
  return structs.map((s) => s.name);
}

gpuTest('generated layouts match Dawn for every struct the shaders share', async () => {
  // Built from shaders/ here and now, so this checks the sources, whatever
  // state the committed files under gen/ are in.
  const config = JSON.parse(await readFile(new URL('../shaders/build.json', here), 'utf8'));
  const files = await buildAll(config, (path) => readFile(new URL(`../${path}`, here), 'utf8'));
  const names = [];
  for (const f of files.filter((f) => f.path.endsWith('.wgsl'))) names.push(...await checkLayouts(f.content));
  for (const n of ['Camera', 'Node', 'Light', 'Material', 'RayQuery', 'Seg', 'OverlapQuery', 'OverlapResult']) {
    assert.ok(names.includes(n), `${n} was checked`);
  }
});

gpuTest('generated layouts match Dawn for matrices, nested arrays, @align and @size', async () => {
  assert.deepEqual(await checkLayouts(LAYOUT_ZOO), ['Inner', 'Zoo']);
});

// -- each entry point's bindings against Dawn's ------------------------------------
//
// tools/shader-build/bindings.js works out which resources each entry point
// uses, and bind-group.js binds just those; a pipeline made with 'auto'
// wants exactly the ones the compiler sees used. So for every entry point of
// every output: a pipeline, and a bind group from stand-in resources of the
// declared kinds, with no validation error.

/** A resource of the kind a declaration names: var<uniform>, var<storage>, a texture or sampler. */
function standIn(space, type) {
  if (space === 'uniform' || space === 'storage') {
    return ctx.device.createBuffer({ size: 65536, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM });
  }
  if (type.startsWith('sampler')) return ctx.device.createSampler();
  const storage = type.match(/^texture_storage_2d<(\w+)/);
  return ctx.device.createTexture({
    size: [4, 4], format: storage ? storage[1] : 'rgba8unorm',
    usage: storage ? GPUTextureUsage.STORAGE_BINDING : GPUTextureUsage.TEXTURE_BINDING,
  }).createView();
}

gpuTest('every entry point binds exactly the resources it uses', async () => {
  // Built here and now, as the layout check above is.
  const config = JSON.parse(await readFile(new URL('../shaders/build.json', here), 'utf8'));
  const files = await buildAll(config, (path) => readFile(new URL(`../${path}`, here), 'utf8'));
  const layouts = files.find((f) => f.path === config.layouts).content;
  const { BINDINGS } = await import(`data:text/javascript,${encodeURIComponent(layouts)}`);
  const { device } = ctx;
  let checked = 0;
  for (const output of config.outputs) {
    const name = output.out.slice(output.out.lastIndexOf('/') + 1).replace(/\.wgsl$/, '');
    const code = files.find((f) => f.path === output.out).content;
    const shader = BINDINGS[name];
    const resources = {};
    for (const [, space, res, type] of code.matchAll(/@binding\(\d+\) var(?:<(\w+)[^>]*>)? (\w+) : ([^;]+);/g)) {
      resources[res] = standIn(space, type);
    }
    assert.deepEqual(Object.keys(resources).sort(), Object.keys(shader.slots).sort(), `${name}: resources`);
    const stages = Object.fromEntries([...code.matchAll(/@(compute|vertex|fragment)\b[^{;]*?\bfn\s+(\w+)/g)]
      .map(([, stage, entry]) => [entry, stage]));
    assert.deepEqual(Object.keys(stages).sort(), Object.keys(shader.entries).sort(), `${name}: entry points`);

    const module = device.createShaderModule({ code });
    const vertex = Object.keys(stages).filter((e) => stages[e] === 'vertex');
    const fragment = Object.keys(stages).filter((e) => stages[e] === 'fragment');
    const pipelines = Object.keys(stages).filter((e) => stages[e] === 'compute').map((entry) => [entry,
      () => device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: entry } })]);
    if (vertex.length || fragment.length) {
      assert.ok(vertex.length === 1 && fragment.length === 1, `${name}: one vertex and one fragment stage`);
      pipelines.push([[vertex[0], fragment[0]], () => device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: vertex[0] },
        fragment: { module, entryPoint: fragment[0], targets: [{ format: 'rgba8unorm' }] },
      })]);
    }
    for (const [entries, make] of pipelines) {
      device.pushErrorScope('validation');
      bindGroup(device, make(), shader, entries, resources);
      const err = await device.popErrorScope();
      assert.equal(err?.message, undefined, `${name}: ${[entries].flat().join(' + ')}`);
      checked++;
    }
  }
  assert.ok(checked >= 15, `only ${checked} pipelines checked`);
});

// -- a maze reports the face struck ------------------------------------------------------

gpuTest('trace() reports the face a ray struck in a maze: every hit\'s node passes through it', async () => {
  // Spelled as public/maze.js spells it - every wall face the surface of a
  // node carrying the wall's material, entered on its inside, dividers off
  // the faces - trace()'s own node is the face struck, as castRays (and so
  // physlab's beam) sees it, not some node claiming the region below.
  const { circularMaze } = await import('./maze.js');
  const maze = circularMaze({ seed: 5, rings: 4, material: 'stone' });
  const sc = ctx.createScene({
    materials: { stone: { albedo: [0.6, 0.6, 0.6] } },
    lights: [{ pos: [0, 0, 20], color: [1, 1, 1] }],
    objects: { maze: maze.tree },
    root: { sphere: { center: [0, 0, 0], radius: 100 }, material: null, inside: { use: 'maze' } },
  });
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const H = quadricAt, grad = gradientAt;
  // Rays from all round and above, at points in the maze: tops, faces,
  // jambs and radial walls all get struck.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const rays = [];
  for (let k = 0; k < 400; k++) {
    const a = rnd() * 2 * Math.PI, r = rnd() * maze.radius, z = rnd() * 2.5;
    const target = [r * Math.cos(a), r * Math.sin(a), z];
    const from = [target[0] + (rnd() - 0.5) * 20, target[1] + (rnd() - 0.5) * 20, z + rnd() * 10];
    const d = target.map((v, i) => v - from[i]), L = Math.hypot(...d);
    rays.push({ origin: from, direction: d.map((v) => v / L), tMin: 0, tMax: 100 });
  }
  const hits = await cast(sc, rays);
  let struck = 0;
  rays.forEach((ray, i) => {
    // A ray that starts inside a wall crosses no face into it: nothing to
    // name (its origin was picked at random, and some land in walls).
    if (!hits.node[i] || hits.t0[i] < 1e-6) return;
    struck++;
    const p = ray.origin.map((v, j) => v + hits.t0[i] * ray.direction[j]);
    const prim = sc.nodes[hits.node[i]].prim;
    const off = Math.abs(H(prim, p)) / Math.hypot(...grad(prim, p));
    assert.ok(off < 1e-3, `ray ${i}: node ${hits.node[i]} is ${off} from the hit at ${p.map((v) => v.toFixed(3))}`);
  });
  assert.ok(struck > 150, `only ${struck} rays struck the maze`);
  sc.destroy();
});

gpuTest('a maze shows each face its own material: tops, doorways and walls', async () => {
  const { circularMaze } = await import('./maze.js');
  const maze = circularMaze({ seed: 6, rings: 4, material: 'stone', doorMaterial: 'oak', topMaterial: 'slate' });
  const sc = ctx.createScene({
    materials: { stone: {}, oak: {}, slate: {} },
    lights: [{ pos: [0, 0, 20], color: [1, 1, 1] }],
    objects: { maze: maze.tree },
    root: { sphere: { center: [0, 0, 0], radius: 100 }, material: null, inside: { use: 'maze' } },
  });
  const index = { stone: 1, oak: 2, slate: 3 };
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const rays = [];
  for (let k = 0; k < 300; k++) {
    const a = rnd() * 2 * Math.PI, r = rnd() * maze.radius, z = rnd() * 2.5;
    const target = [r * Math.cos(a), r * Math.sin(a), z];
    const from = [target[0] + (rnd() - 0.5) * 20, target[1] + (rnd() - 0.5) * 20, z + 3 + rnd() * 10];
    const d = target.map((v, i) => v - from[i]), L = Math.hypot(...d);
    rays.push({ origin: from, direction: d.map((v) => v / L), tMin: 0, tMax: 100 });
  }
  const hits = await cast(sc, rays);
  const parts = { stone: 0, oak: 0, slate: 0 };
  rays.forEach((ray, i) => {
    if (!hits.node[i] || hits.t0[i] < 1e-6) return;
    const p = ray.origin.map((v, j) => v + hits.t0[i] * ray.direction[j]);
    const nd = sc.nodes[hits.node[i]];
    // A hit at the walls' height is on a top, and shows the tops'; below
    // it, a wall's face or a doorway's jamb, never the tops'.
    if (Math.abs(p[2] - 2.5) < 1e-4) assert.equal(nd.material, index.slate, `ray ${i}: a top, at z ${p[2]}`);
    else assert.notEqual(nd.material, index.slate, `ray ${i}: below the tops, at z ${p[2]}`);
    parts[Object.keys(index).find((k) => index[k] === nd.material)]++;
  });
  assert.ok(parts.stone > 20 && parts.oak > 0 && parts.slate > 20, JSON.stringify(parts));
  sc.destroy();
});

// -- lights scoped by env, as rendered --------------------------------------------------

/** Render `spec` from `camera` onto a W x H stand-in canvas; the pixels, RGBA. */
async function renderPixels(spec, camera, W = 160, H = 80) {
  await import('./as-renderer.js');                  // registers ASRenderer
  const sc = ctx.createScene(spec);
  let config, tex;
  const surface = {
    configure(c) { config = c; }, unconfigure() {},
    getCurrentTexture() {
      tex ??= ctx.device.createTexture({ size: [W, H], format: config.format,
                                         usage: config.usage | GPUTextureUsage.COPY_SRC });
      return tex;
    },
  };
  globalThis.window ??= { devicePixelRatio: 1 };
  const view = ctx.createRenderer({ clientWidth: W, clientHeight: H, width: W, height: H,
                                    getContext: () => surface }, { scene: sc, camera });
  // Rows of a texture copy are padded to 256 bytes.
  const stride = Math.ceil((W * 4) / 256) * 256;
  const buf = ctx.device.createBuffer({ size: stride * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = ctx.device.createCommandEncoder();
  view.encode(enc);
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: stride }, [W, H]);
  ctx.device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const raw = new Uint8Array(buf.getMappedRange().slice(0));
  const bgra = config.format.startsWith('bgra');
  view.destroy(); sc.destroy(); tex.destroy(); buf.destroy();
  const at = (col, row) => {
    const i = row * stride + col * 4;
    return bgra ? [raw[i + 2], raw[i + 1], raw[i]] : [raw[i], raw[i + 1], raw[i + 2]];
  };
  return { at, W, H };
}

gpuTest('a region\'s lights light it, and the scene\'s everything; not each other\'s region', async () => {
  const { ASCamera } = await import('./as-camera.js');
  const red = { pos: [-1.5, 0, 0], color: [60, 0, 0] };
  const blue = { pos: [1.5, 0, 0], color: [0, 0, 60] };
  const green = { pos: [0, -10, 0], color: [0, 90, 0] };
  // Two regions side by side, nothing solid between them, a white ball in
  // each. Scoped, the red light is region A's and the blue region B's;
  // unscoped, the same three lights are all the scene's.
  const room = (x, lights) => ({
    sphere: { center: [x, 0, 0], radius: 2.9 }, ...(lights ? { lights } : {}),
    inside: { sphere: { center: [x, 0, 0], radius: 0.5 }, material: 'white' },
  });
  const spec = (scoped) => ({
    materials: { white: { albedo: [0.8, 0.8, 0.8] } },
    lights: scoped ? [green] : [green, red, blue],
    root: { sphere: { center: [0, 0, 0], radius: 100 }, material: null, inside: { group: [
      room(-3, scoped ? [red] : null), room(3, scoped ? [blue] : null),
    ] } },
  });
  // Looking along +Y, orthographic, 8 either side: column = (x / 8 + 1) / 2 * 160.
  const camera = () => {
    const c = new ASCamera({ position: [0, -10, 0], direction: [0, 1, 0], projection: 'orthographic' });
    c.orthoHeight = 4;
    return c;
  };
  const scoped = await renderPixels(spec(true), camera());
  const open = await renderPixels(spec(false), camera());
  const col = (x) => Math.round((x / 8 + 1) / 2 * 160);
  // Ball B's side toward A, and ball A's side toward B.
  const bSide = [scoped.at(col(2.6), 40), open.at(col(2.6), 40)];
  const aSide = [scoped.at(col(-2.6), 40), open.at(col(-2.6), 40)];
  const say = `B side ${bSide.join(' / ')}, A side ${aSide.join(' / ')} (scoped / open)`;
  assert.ok(bSide[1][0] - bSide[0][0] > 40, `A's red no longer reaches B: ${say}`);
  assert.ok(aSide[1][2] - aSide[0][2] > 40, `B's blue no longer reaches A: ${say}`);
  assert.ok(Math.abs(bSide[0][2] - bSide[1][2]) <= 2 && Math.abs(aSide[0][0] - aSide[1][0]) <= 2,
            `each still lit by its own: ${say}`);
  assert.ok(Math.abs(bSide[0][1] - bSide[1][1]) <= 2 && bSide[0][1] > 60, `and the scene's green everywhere: ${say}`);
});

gpuTest('a glow region lights from its centre, fading to nothing at its surface, as its node is now', async () => {
  const { ASCamera } = await import('./as-camera.js');
  // A floor seen from above, and over it a glow region, a sphere about
  // [0, 0, 1]; around it no ambient light at all, so beyond the sphere
  // the floor is black.
  const floor = { plane: { normal: [0, 0, 1], offset: 0 }, material: 'white' };
  const spec = (radius, lights = []) => ({
    materials: {
      white: { albedo: [0.8, 0.8, 0.8] },
      glow: { kind: 'glowRegion', albedo: [3, 3, 3] },
      dark: { kind: 'ambient', albedo: [0, 0, 0] },
    },
    lights,
    root: { sphere: { center: [0, 0, 0], radius: 100 }, material: 'dark', inside: {
      sphere: { center: [0, 0, 1], radius }, material: lights.length ? 'dark' : 'glow',
      inside: floor, outside: floor,
    } },
  });
  // Looking straight down, orthographic: x to the left, so column 80 - 10 x.
  const camera = () => {
    const c = new ASCamera({ position: [0, 0, 10], direction: [0, 0, -1], projection: 'orthographic' });
    c.orthoHeight = 4;
    return c;
  };
  const level = (img, x) => img.at(Math.round(80 - 10 * x), 40)[0];
  const glow = await renderPixels(spec(3), camera());
  // As the formula has it, at each pixel's centre, x = (79.5 - column) / 10:
  // the light at its centre, inverse square (softened, 1 + d^2), and by
  // H(P) / H(centre) = 1 - d^2 / r^2, squared; on white 0.8, raised to
  // 1/2.2 for the screen. The sphere meets the floor at x = sqrt(8), 2.83.
  const expected = (column, radius) => {
    const x = (79.5 - column) / 10, d2 = x * x + 1;
    const falloff = Math.max(0, 1 - d2 / (radius * radius)) ** 2;
    const light = 0.8 * (3 / (1 + d2)) * falloff * (1 / Math.sqrt(d2));
    return 255 * Math.min(1, light) ** (1 / 2.2);
  };
  for (const column of [80, 70, 60, 55, 53, 52, 51, 50, 45, 40]) {
    const seen = glow.at(column, 40)[0], want = expected(column, 3);
    assert.ok(Math.abs(seen - want) <= 3, `column ${column}: ${seen}, the formula ${want.toFixed(1)}`);
  }
  assert.equal(glow.at(50, 40)[0], 0, 'nothing beyond it - no ambient within or without');
  const edge = level(glow, 2.7);
  // The light comes from the node as it is: a bigger sphere reaches further.
  const bigger = await renderPixels(spec(4), camera());
  assert.ok(level(bigger, 2.7) > edge + 10, `radius 4: ${level(bigger, 2.7)} at 2.7, against ${edge}`);
  // And far from its surface it is a light at its centre, of its albedo.
  const huge = await renderPixels(spec(90), camera());
  const point = await renderPixels(spec(90, [{ pos: [0, 0, 1], color: [3, 3, 3] }]), camera());
  for (const x of [0, 0.5, 1, 2]) {
    assert.ok(Math.abs(level(huge, x) - level(point, x)) <= 3,
              `at ${x}: glow ${level(huge, x)}, the same light ${level(point, x)} (within (1 - d^2/90^2)^2)`);
  }
});

gpuTest('a glow region\'s fill lights its shadows: its glow there, unshadowed, times the fill', async () => {
  const { ASCamera } = await import('./as-camera.js');
  // The glow over a floor again, and a ball in it between the centre and
  // the floor at x = 2: the ball's shadow falls round x = 2.
  const floor = { plane: { normal: [0, 0, 1], offset: 0 }, material: 'white' };
  const spec = (fill) => ({
    materials: {
      white: { albedo: [0.8, 0.8, 0.8] },
      glow: { kind: 'glowRegion', albedo: [3, 3, 3], fill },
      dark: { kind: 'ambient', albedo: [0, 0, 0] },
    },
    lights: [],
    root: { sphere: { center: [0, 0, 0], radius: 100 }, material: 'dark', inside: {
      sphere: { center: [0, 0, 1], radius: 3 }, material: 'glow',
      inside: { sphere: { center: [1, 0, 0.5], radius: 0.2 }, material: 'white', outside: floor },
      outside: floor,
    } },
  });
  const camera = () => {
    const c = new ASCamera({ position: [0, 0, 10], direction: [0, 0, -1], projection: 'orthographic' });
    c.orthoHeight = 4;
    return c;
  };
  const none = await renderPixels(spec(0), camera());
  const half = await renderPixels(spec(0.5), camera());
  const column = 60, x = (79.5 - column) / 10, d2 = x * x + 1;
  const glow = 3 / (1 + d2) * (1 - d2 / 9) ** 2;
  const want = 255 * (0.8 * 0.5 * glow) ** (1 / 2.2);
  assert.equal(none.at(column, 40)[0], 0, 'in the ball\'s shadow, with no fill, nothing');
  assert.ok(Math.abs(half.at(column, 40)[0] - want) <= 3, `with fill 0.5: ${half.at(column, 40)[0]}, the formula ${want.toFixed(1)}`);
  // Where the glow reaches directly, the fill adds to it.
  assert.ok(half.at(70, 40)[0] > none.at(70, 40)[0], `lit floor: ${half.at(70, 40)[0]} with fill, ${none.at(70, 40)[0]} without`);
});

gpuTest('a directional light: as bright everywhere, its shadows parallel', async () => {
  const { ASCamera } = await import('./as-camera.js');
  // A floor and a ball a unit above it, lit only by light travelling at 45
  // degrees, along +x and down; seen from above, no ambient light.
  const spec = {
    materials: { white: { albedo: [0.8, 0.8, 0.8] }, dark: { kind: 'ambient', albedo: [0, 0, 0] } },
    lights: [{ direction: [1, 0, -1], color: [1, 1, 1] }],
    root: { sphere: { center: [0, 0, 0], radius: 100 }, material: 'dark', inside: {
      sphere: { center: [0, 0, 1], radius: 0.4 }, material: 'white',
      outside: { plane: { normal: [0, 0, 1], offset: 0 }, material: 'white' },
    } },
  };
  const camera = new ASCamera({ position: [0, 0, 10], direction: [0, 0, -1], projection: 'orthographic' });
  camera.orthoHeight = 4;
  const img = await renderPixels(spec, camera);
  const level = (x, y = 0) => img.at(Math.round(80 - 10 * x), Math.round(40 + 10 * y))[0];
  // No falloff: the floor 7 apart alike, at albedo x color x cos 45, through 1/2.2.
  const lit = 255 * (0.8 * Math.SQRT1_2) ** (1 / 2.2);
  for (const x of [-4, -2, 3]) assert.ok(Math.abs(level(x) - lit) <= 2, `at ${x}: ${level(x)}, the formula ${lit.toFixed(1)}`);
  assert.ok(Math.abs(level(-4, 3) - lit) <= 2, `and off to the side: ${level(-4, 3)}`);
  // The ball's shadow: a unit along the light's way from under its centre,
  // stretched by root 2 along it - to x = 1 +- 0.57 - and lit again past.
  assert.equal(level(1), 0, `in the shadow at x = 1: ${level(1)}`);
  assert.ok(Math.abs(level(1.9) - lit) <= 2, `past it: ${level(1.9)}`);
});

gpuTest('setLights replaces the scene\'s own lights and keeps those its nodes carry', async () => {
  const sc = ctx.createScene({
    materials: MATERIALS,
    lights: [{ pos: [0, 0, 50], color: [1, 1, 1] }],
    root: { sphere: { center: [0, 0, 0], radius: 10 }, lights: [{ pos: [0, 0, 1], color: [5, 5, 5] }] },
  });
  assert.equal(sc.topLights, 1);
  sc.setLights([{ pos: [1, 2, 3], color: [2, 2, 2] }]);
  assert.deepEqual(sc.lights.map((lt) => [lt.pos, lt.env]), [[[1, 2, 3], 0], [[0, 0, 1], 1]]);
  sc.destroy();
});

// -- a light's shadow rays start inside its env ------------------------------------------

gpuTest('a region\'s light is shadowed by what the region holds, as a light of the scene\'s would be', async () => {
  const { ASCamera } = await import('./as-camera.js');
  // A region holding a floor and a ball, its light above; looking down.
  const lamp = { pos: [1, 0, 2.6], color: [30, 30, 30] };
  const ball = { sphere: { center: [0.5, 0, 1.3], radius: 0.4 }, material: 'clay' };
  const floor = { slab: { center: [0, 0, -0.25], axis: [0, 0, 1], thickness: 0.5 }, material: 'clay' };
  const spec = (scoped) => ({
    materials: { clay: { albedo: [0.8, 0.8, 0.8] } },
    lights: scoped ? [] : [lamp],
    root: { sphere: { center: [0, 0, 0], radius: 100 }, material: null, inside: {
      sphere: { center: [0, 0, 1], radius: 3 }, ...(scoped ? { lights: [lamp] } : {}),
      inside: { union: [ball, floor] },
    } },
  });
  const camera = () => {
    const c = new ASCamera({ position: [0, 0, 10], direction: [0, 0, -1], projection: 'orthographic' });
    c.orthoHeight = 4;
    return c;
  };
  // 8 high on 80 pixels: 10 a unit. Looking straight down, the frame's
  // right is -X and its up -Y (as just short of straight down, facing -Y).
  const px = (x, y) => [Math.round(80 - 10 * x), Math.round(40 + 10 * y)];
  const scoped = await renderPixels(spec(true), camera());
  const open = await renderPixels(spec(false), camera());
  for (let y = 0; y < 80; y += 4) for (let x = 0; x < 160; x += 4) {
    assert.deepEqual(scoped.at(x, y), open.at(x, y), `pixel ${x},${y}: the same light, scoped or not`);
  }
  // The ball's shadow falls round (0, 0) on the floor - seen from above at
  // (-0.3, 0), clear of the ball itself (x 0.1 to 0.9); (-2, 0) is open.
  assert.ok(scoped.at(...px(-0.3, 0))[0] + 30 < scoped.at(...px(-2, 0))[0],
            `shadowed ${scoped.at(...px(-0.3, 0))}, open ${scoped.at(...px(-2, 0))}`);
});

gpuTest('a region\'s light sees only the region\'s subtree, even where other geometry overlaps it', async () => {
  const { ASCamera } = await import('./as-camera.js');
  // The same, but the ball is a node before the region - the region is its
  // outside - so it is not in the region's subtree, though it lies within
  // it. The region's light, tracing from inside the region, does not see
  // it.
  const lamp = { pos: [1, 0, 2.6], color: [30, 30, 30] };
  const ball = { sphere: { center: [0.5, 0, 1.3], radius: 0.4 }, material: 'clay' };
  const floor = { slab: { center: [0, 0, -0.25], axis: [0, 0, 1], thickness: 0.5 }, material: 'clay' };
  const spec = (scoped) => ({
    materials: { clay: { albedo: [0.8, 0.8, 0.8] } },
    lights: scoped ? [] : [lamp],
    root: { sphere: { center: [0, 0, 0], radius: 100 }, material: null, inside: {
      ...ball,
      outside: { sphere: { center: [0, 0, 1], radius: 3 }, ...(scoped ? { lights: [lamp] } : {}), inside: floor },
    } },
  });
  const camera = () => {
    const c = new ASCamera({ position: [0, 0, 10], direction: [0, 0, -1], projection: 'orthographic' });
    c.orthoHeight = 4;
    return c;
  };
  const px = (x, y) => [Math.round(80 - 10 * x), Math.round(40 + 10 * y)];   // right -X, up -Y
  const scoped = await renderPixels(spec(true), camera());
  const open = await renderPixels(spec(false), camera());
  const shadow = px(-0.3, 0);
  assert.ok(open.at(...shadow)[0] + 30 < scoped.at(...shadow)[0],
            `the scene's light is shadowed by the ball (${open.at(...shadow)}), the region's is not (${scoped.at(...shadow)})`);
});

// -- loading by URL -------------------------------------------------------------------

gpuTest('loadScene by URL: a scene referencing what sits beside it, an STL on its own, gzipped', async () => {
  const tetrahedron = [
    [[0,0,0],[0,1,0],[1,0,0]], [[0,0,0],[0,0,1],[0,1,0]],
    [[0,0,0],[1,0,0],[0,0,1]], [[1,0,0],[0,1,0],[0,0,1]],
  ];
  // The mesh names no material: it is made of the clay of the root round it,
  // which comes from a library beside the scene.
  const files = {
    '/scenes/s.json': JSON.stringify({
      materials: ['@lib/m.json'],
      lights: [{ pos: [0, 0, 5], color: [1, 1, 1] }],
      root: { sphere: { center: [0, 0, 0], radius: 40 }, material: 'clay', inside: { use: '@parts/tet.stl' } },
    }),
    '/scenes/lib/m.json': JSON.stringify(MATERIALS),
    '/scenes/parts/tet.stl': Buffer.from(writeSTL(tetrahedron)),
  };
  const server = createServer((req, res) => {
    const body = files[req.url.split('?')[0]];
    res.writeHead(body ? 200 : 404);
    res.end(body ?? 'not found');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // What the scene references, "@parts/tet.stl" and "@lib/m.json", is
    // fetched from beside it.
    const sc = await ctx.loadScene(`${base}/scenes/s.json`);
    const hits = await cast(sc, [{ origin: [0.2, 0.2, 5], direction: [0, 0, -1] }]);
    assert.ok(Math.abs(hits.t0[0] - (5 - 0.6)) < 1e-4, `hit at ${hits.t0[0]}: the slanted face`);
    sc.destroy();

    // readScene(): the spec as written, what it references, and where -
    // what the editor and physlab load with. A scene made from them still
    // finds its references when an edit recompiles it, as the editor's do.
    const read = await readScene(`${base}/scenes/s.json`);
    assert.deepEqual(read.spec.materials, ['@lib/m.json'], 'the spec as written, references and all');
    assert.equal(read.path, `${base}/scenes/s.json`);
    assert.ok(Object.keys(read.files).length >= 2, `the library and the mesh: ${Object.keys(read.files)}`);
    const edited = ctx.createScene(read.spec, read);
    edited.update({ ...read.spec, lights: [{ pos: [0, 0, 6], color: [1, 1, 1] }] });
    assert.ok(edited.nodes.length > 2, 'an edit recompiles, references and all');
    edited.destroy();
    // withReferences(): a spec in hand - a file opened from disk - with its
    // references looked for where it is said to be.
    const opened = await withReferences(JSON.parse(files['/scenes/s.json']), `${base}/scenes/opened.json`);
    assert.deepEqual(Object.keys(opened.files).sort(), Object.keys(read.files).sort());

    // On its own: a floor, a sky and the mesh, scaled to 2 across (x 2)
    // and centred, on the floor. Over its (0.2, 0.2) it is 0.6 tall: 1.2.
    const alone = await ctx.loadScene(`${base}/scenes/parts/tet.stl?v=2`);
    assert.equal(alone.lights.length, 3);
    const down = await cast(alone, [{ origin: [-0.6, -0.6, 5], direction: [0, 0, -1] }]);
    assert.ok(Math.abs(down.t0[0] - (5 - 1.2)) < 1e-4, `hit at ${down.t0[0]}: the mesh's top`);
    alone.destroy();

    // Gzipped, the scene and what it references both.
    files['/scenes/s.json.gz'] = gzipSync(files['/scenes/s.json'].replace('@parts/tet.stl', '@parts/tet.stl.gz'));
    files['/scenes/parts/tet.stl.gz'] = gzipSync(files['/scenes/parts/tet.stl']);
    const zipped = await ctx.loadScene(`${base}/scenes/s.json.gz`);
    const again = await cast(zipped, [{ origin: [0.2, 0.2, 5], direction: [0, 0, -1] }]);
    assert.ok(Math.abs(again.t0[0] - (5 - 0.6)) < 1e-4, `gzipped: hit at ${again.t0[0]}`);
    zipped.destroy();

    await assert.rejects(ctx.loadScene(`${base}/scenes/missing.json`), /404/);
  } finally {
    server.close();
  }
});

// -- reflection, as rendered -----------------------------------------------------------

gpuTest('a mirror shows what its reflected ray sees, times its albedo; past MAX_BOUNCES, its own material', async () => {
  const { ASCamera } = await import('./as-camera.js');
  const { MAX_BOUNCES } = await import('./gen/layouts.js');
  // Looking along +Y, orthographic, at a wall filling y > 0; behind the
  // camera (eye plane y = -10), unseen by the camera's own rays, a wall
  // filling y < -20. Unlit, so the colours are exact.
  const spec = (front, back) => ({
    materials: {
      front: { kind: 'unlit', albedo: [0.5, 0.5, 0.5], ...front },
      back:  { kind: 'unlit', albedo: [1, 0, 0], ...back },
    },
    lights: [],
    root: { plane: { normal: [0, -1, 0], offset: 0 }, material: 'front',
            outside: { plane: { normal: [0, 1, 0], offset: -20 }, material: 'back' } },
  });
  const camera = () => new ASCamera({ position: [0, -10, 0], direction: [0, 1, 0], projection: 'orthographic', orthoHeight: 4 });
  const centre = async (s) => (await renderPixels(s, camera())).at(80, 40);
  const half = Math.round(255 * 0.5 ** (1 / 2.2));    // 0.5, after gamma
  const near = (got, want, what) => assert.ok(got.every((v, i) => Math.abs(v - want[i]) <= 1), `${what}: ${got}, not ${want}`);

  near(await centre(spec({}, {})), [half, half, half], 'not reflective: its own colour');
  near(await centre(spec({ reflective: true }, {})), [half, 0, 0], 'a mirror: the red wall behind the camera, at half');
  near(await centre(spec({ reflective: true, albedo: [1, 1, 0] }, {})), [255, 0, 0], 'a yellow mirror passes the red');
  // Two mirrors facing: the ray bounces between them, front, back, front
  // ..., and the mirror it reaches with no bounce left is shaded as its own
  // material, tinted by every mirror before it.
  const albedo = [[0.5, 0.5, 0.5], [1, 0, 0]];         // front, back
  const last = albedo[MAX_BOUNCES % 2];
  const tint = [0, 1, 2].map((c) => last[c] * Array.from({ length: MAX_BOUNCES }, (_, k) => albedo[k % 2][c]).reduce((a, b) => a * b, 1));
  near(await centre(spec({ reflective: true }, { reflective: true })), tint.map((v) => Math.round(255 * v ** (1 / 2.2))),
       `a mirror seen in a mirror, past MAX_BOUNCES (${MAX_BOUNCES})`);
});

gpuTest('glass refracts: through a tilted slab the world shifts as Snell\'s law says; face on, coloured by its depth', async () => {
  const { ASCamera } = await import('./as-camera.js');
  // A wall filling y > 10, red where x < 0 and blue where x > 0; between it
  // and the camera (looking along +Y, orthographic, 10 pixels a unit) a
  // slab of glass 2 thick through the origin, its axis `axis`, cut to a
  // ball of radius 5 - each face of it a node carrying the glass.
  const spec = (axis, glass) => ({
    materials: {
      red:   { kind: 'unlit', albedo: [1, 0, 0] },
      blue:  { kind: 'unlit', albedo: [0, 0, 1] },
      glass: { iorGlass: true, albedo: [1, 1, 1], ...glass },
    },
    lights: [],
    // The glass first, and beyond it a pure division at x = 0 - parallel to
    // every ray, so on no face - with each half of the wall a node of its
    // own colour, the faces the rays meet.
    root: { slab: { center: [0, 0, 0], axis, thickness: 2 }, material: 'glass',
            inside: { sphere: { center: [0, 0, 0], radius: 5 }, material: 'glass' },
            outside: { plane: { normal: [-1, 0, 0], offset: 0 }, material: null,
                       inside: { plane: { normal: [0, -1, 0], offset: -10 }, material: 'blue' },
                       outside: { plane: { normal: [0, -1, 0], offset: -10 }, material: 'red' } } },
  });
  const camera = () => new ASCamera({ position: [0, -10, 0], direction: [0, 1, 0], projection: 'orthographic', orthoHeight: 4 });
  const near = (got, want, what) => assert.ok(got.every((v, i) => Math.abs(v - want[i]) <= 1), `${what}: ${got}, not ${want}`);

  // Face on, no bend: the wall as it is, coloured by the 2 units of glass
  // between - albedo^(2 * opacity).
  const gamma = (v) => Math.round(255 * v ** (1 / 2.2));
  const faceOn = await renderPixels(spec([0, 1, 0], { albedo: [0.5, 1, 1] }), camera());
  near(faceOn.at(40, 40), [gamma(0.25), 0, 0], 'red through 2 units of glass that halve red each');
  near(faceOn.at(120, 40), [0, 0, 255], 'blue through it');
  near((await renderPixels(spec([0, 1, 0], { albedo: [0.5, 1, 1], opacity: 0.5 }), camera())).at(40, 40),
       [gamma(0.5), 0, 0], 'at opacity 0.5, as if 1 unit');
  near((await renderPixels(spec([0, 1, 0], { albedo: [0.5, 1, 1], opacity: 0 }), camera())).at(40, 40),
       [255, 0, 0], 'at opacity 0, clear');

  // At 45 degrees, a ray along +Y comes out parallel to how it went in,
  // shifted sideways: where, by Snell's law, worked out here.
  const n = [Math.SQRT1_2, Math.SQRT1_2, 0];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const refract = (d, nf, eta) => {          // GLSL's refract(), nf facing the ray
    const c = -dot(d, nf), k = 1 - eta * eta * (1 - c * c);
    return d.map((v, i) => eta * v + (eta * c - Math.sqrt(k)) * nf[i]);
  };
  const wallX = (x0) => {
    let p = [x0, -10, 0], d = [0, 1, 0];
    const to = (plane) => { const t = (plane - dot(n, p)) / dot(n, d); p = p.map((v, i) => v + t * d[i]); };
    to(-1); d = refract(d, n.map((v) => -v), 1 / 1.5);
    to(1);  d = refract(d, n.map((v) => -v), 1.5);
    return p[0] + (10 - p[1]) * d[0] / d[1];
  };
  const shift = wallX(0) - 0;
  assert.ok(Math.abs(shift) > 0.5, `a shift worth seeing: ${shift}`);
  const tilted = await renderPixels(spec(n, {}), camera());
  // Searched over the flat middle of the slab: towards the ball's rim, rays
  // meet its curve as well.
  const boundary = [...Array(50).keys()].map((k) => 50 + k).find((col) => tilted.at(col, 40)[2] > 128);   // first blue column
  const expected = 80 + -shift * 10;          // the column whose ray lands on x = 0
  assert.ok(Math.abs(boundary - expected) <= 1, `red meets blue at column ${boundary}, Snell says ${expected.toFixed(2)}`);
  near(tilted.at(boundary - 5, 40), [255, 0, 0], 'red, through the glass');
});

gpuTest('glass meeting water: a ray bends at each face by the ratio of the two indices, and is coloured by each', async () => {
  const { ASCamera } = await import('./as-camera.js');
  // As above - a wall, red where x < 0, blue where x > 0, behind a slab -
  // but the slab is two, face to face: glass from -1 to 0 along `axis`,
  // water from 0 to 1, each bounded by a ball of radius 5, each face a
  // node carrying its own material.
  const half = (centre, material, axis) => ({
    slab: { center: axis.map((v) => v * centre), axis, thickness: 1 }, material,
    inside: { sphere: { center: [0, 0, 0], radius: 5 }, material },
  });
  const spec = (axis) => ({
    materials: {
      red:   { kind: 'unlit', albedo: [1, 0, 0] },
      blue:  { kind: 'unlit', albedo: [0, 0, 1] },
      glass: { iorGlass: true, albedo: [0.5, 1, 1] },
      water: { iorWater: true, albedo: [0.5, 1, 1] },
    },
    lights: [],
    root: { ...half(-0.5, 'glass', axis),
            outside: { ...half(0.5, 'water', axis),
                       outside: { plane: { normal: [-1, 0, 0], offset: 0 }, material: null,
                                  inside: { plane: { normal: [0, -1, 0], offset: -10 }, material: 'blue' },
                                  outside: { plane: { normal: [0, -1, 0], offset: -10 }, material: 'red' } } } },
  });
  const camera = () => new ASCamera({ position: [0, -10, 0], direction: [0, 1, 0], projection: 'orthographic', orthoHeight: 4 });
  const gamma = (v) => Math.round(255 * v ** (1 / 2.2));
  const near = (got, want, what) => assert.ok(got.every((v, i) => Math.abs(v - want[i]) <= 1), `${what}: ${got}, not ${want}`);

  // Face on: a unit of each, each halving red.
  const faceOn = await renderPixels(spec([0, 1, 0]), camera());
  near(faceOn.at(40, 40), [gamma(0.25), 0, 0], 'red through a unit of glass and a unit of water');
  near(faceOn.at(120, 40), [0, 0, 255], 'blue through them');

  // At 45 degrees: air to glass, glass to water (1.5 / 1.333), water to air.
  // (Through parallel faces Snell's law composes, so a film of air between
  // would bend it the same; what meeting water changes is the critical
  // angle - 62.7 degrees against water, 41.8 against air - and that each is
  // coloured by its own depth.)
  const n = [Math.SQRT1_2, Math.SQRT1_2, 0];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const refract = (d, nf, eta) => {
    const c = -dot(d, nf), k = 1 - eta * eta * (1 - c * c);
    return d.map((v, i) => eta * v + (eta * c - Math.sqrt(k)) * nf[i]);
  };
  const back = n.map((v) => -v);
  let p = [0, -10, 0], d = [0, 1, 0];
  const to = (plane) => { const t = (plane - dot(n, p)) / dot(n, d); p = p.map((v, i) => v + t * d[i]); };
  to(-1); d = refract(d, back, 1 / 1.5);
  to(0);  d = refract(d, back, 1.5 / 1.333);
  to(1);  d = refract(d, back, 1.333);
  const shift = p[0] + (10 - p[1]) * d[0] / d[1];
  const tilted = await renderPixels(spec(n), camera());
  const boundary = [...Array(50).keys()].map((k) => 50 + k).find((col) => tilted.at(col, 40)[2] > 128);
  const expected = 80 - shift * 10;
  assert.ok(Math.abs(boundary - expected) <= 1, `red meets blue at column ${boundary}, Snell says ${expected.toFixed(2)}`);
});

gpuTest('through a glass box with a box-shaped hole, only its walls colour the light', async () => {
  const { ASCamera } = await import('./as-camera.js');
  // A glass box 3 across, its inside taken out (walls 0.5), before a red
  // wall, seen face on. The hole is three complemented slabs, so the camera
  // ray reaches the front wall through one's outside and trace() reports
  // another slab at the same distance: the surface it goes on from must be
  // the one it is on (surfaceAt()), or the hole is lost and the light is
  // coloured by glass all the way across.
  const box = (w, material) => ({ intersection: [
    { slab: { center: [0, 0, 0], axis: [1, 0, 0], thickness: w }, ...material },
    { slab: { center: [0, 0, 0], axis: [0, 1, 0], thickness: w }, ...material },
    { slab: { center: [0, 0, 0], axis: [0, 0, 1], thickness: w }, ...material }] });
  const spec = {
    materials: { red: { kind: 'unlit', albedo: [1, 0, 0] }, glass: { iorGlass: true, albedo: [0.5, 1, 1] } },
    lights: [],
    root: { plane: { normal: [0, 1, 0], offset: 10 }, material: null,
            inside: { difference: [box(3, { material: 'glass' }), box(2, {})] },
            outside: { plane: { normal: [0, -1, 0], offset: -10 }, material: 'red' } },
  };
  const camera = new ASCamera({ position: [0, -10, 0], direction: [0, 1, 0], projection: 'orthographic', orthoHeight: 4 });
  const got = (await renderPixels(spec, camera)).at(80, 40);
  const want = Math.round(255 * 0.5 ** (1 / 2.2));      // two walls of 0.5: one unit of glass
  assert.ok(Math.abs(got[0] - want) <= 1 && got[1] === 0 && got[2] === 0, `red through the walls only: ${got}, not ${want}`);
});

// -- the frame loop every page runs ----------------------------------------------------

gpuTest('start(): hooks before the encode and after the submit, encode options, the profiler timing compute and blit', async () => {
  await import('./as-renderer.js');                  // registers ASRenderer
  const { ASCamera } = await import('./as-camera.js');
  const { FrameProfiler } = await import('./frame-profiler.js');
  globalThis.window ??= { devicePixelRatio: 1 };
  const sc = scene({ sphere: { center: [0, 0, 0], radius: 1 }, material: 'clay' });
  const W = 64, H = 32;
  let config, tex;
  const surface = {
    configure(c) { config = c; }, unconfigure() {},
    getCurrentTexture() { tex ??= ctx.device.createTexture({ size: [W, H], format: config.format, usage: config.usage }); return tex; },
  };
  const camera = new ASCamera();
  camera.aim({ focus: [0, 0, 0], direction: [0, 1, 0], distance: 4 });
  const view = ctx.createRenderer({ clientWidth: W, clientHeight: H, width: W, height: H, getContext: () => surface },
                                  { scene: sc, camera });
  // What happens, in order, and what the encode was given.
  const seen = [];
  const encode = view.encode.bind(view);
  view.encode = (enc, opts) => { seen.push(['encode', Object.keys(opts).sort().join()]); return encode(enc, opts); };
  // A panel just good enough for the profiler.
  const cells = {};
  const panel = {
    set innerHTML(html) { for (const [, k] of html.matchAll(/data-k="([^"]+)"/g)) cells[k] = { dataset: { k }, textContent: '' }; },
    querySelectorAll: () => Object.values(cells),
    querySelector: () => ({ textContent: '', innerHTML: '', getContext: () => null }),
  };
  const profiler = new FrameProfiler(ctx.device, ctx.canTimestamp, ['compute', 'blit'], panel);
  let pending = new Map(), ids = 0;
  globalThis.requestAnimationFrame = (fn) => { pending.set(++ids, fn); return ids; };
  globalThis.cancelAnimationFrame = (id) => { pending.delete(id); };
  const tick = async () => {
    const run = [...pending.values()]; pending = new Map();
    for (const fn of run) fn(performance.now());
    await ctx.device.queue.onSubmittedWorkDone();
    while (profiler.pending) await new Promise((r) => setTimeout(r, 1));
  };
  let physicsPass = 'unasked';
  const offBefore = ctx.onFrame((dt, frame) => { seen.push(['before', typeof dt]); physicsPass = frame.pass('physics'); });
  const offAfter = ctx.afterFrame(() => seen.push(['after']));
  ctx.start({ profiler, options: () => ({ camera: { debugView: 0 } }) });
  for (let f = 0; f < 6; f++) await tick();
  ctx.stop();

  assert.deepEqual(seen.slice(0, 3), [['before', 'number'],
    ['encode', 'blitTimestamps,camera,computeTimestamps'], ['after']],
    'onFrame, then the encode (with the options and the timestamps), then afterFrame');
  assert.equal(physicsPass, undefined, 'a pass the profiler doesn\'t time: none');
  if (ctx.canTimestamp) {
    assert.ok(Number.isFinite(profiler.avg.compute()) && profiler.avg.compute() > 0, `compute timed: ${profiler.avg.compute()}`);
    assert.ok(Number.isFinite(profiler.avg.blit()), 'blit timed');
  }

  // With no profiler, as it ever was: hooks, an encode, nothing timed.
  seen.length = 0;
  ctx.start();
  await tick();
  ctx.stop();
  assert.deepEqual(seen.map(([what]) => what), ['before', 'encode', 'after']);
  assert.equal(seen[1][1], '', 'no options, no timestamps');
  offBefore(); offAfter();
  view.destroy(); sc.destroy();
});

// -- casting shadows ---------------------------------------------------------------------

gpuTest('castsShadow: a material seen may cast no shadow, and one unseen may cast one', async () => {
  const { ASCamera } = await import('./as-camera.js');
  // A red ball above a grey floor, lit from the side: its shadow falls to
  // +x of it. Looked at from above.
  const shoot = (ball) => renderPixels({
    materials: { floor: { albedo: [0.6, 0.6, 0.6] }, red: { albedo: [0.9, 0.1, 0.1] }, ball },
    lights: [{ direction: [1, 0, -1], color: [2, 2, 2] }],
    root: { plane: { normal: [0, 0, 1], offset: 0 }, material: 'floor',
            outside: { sphere: { center: [0, 0, 1], radius: 0.5 }, material: 'ball' } },
  }, (() => { const c = new ASCamera(); c.aim({ focus: [0.5, 0, 0], direction: [0, 0.2, -1], distance: 6 }); return c; })(), 120, 60);
  // How much of the picture is the red ball, and the darkest of the floor
  // to its right, where its shadow falls (red pixels, the ball's own, aside),
  // against the lit floor far from both.
  const read = ({ at, W, H }) => {
    const lum = (p) => p[0] + p[1] + p[2], red = (p) => p[0] > 12 && p[0] > 1.5 * p[1] && p[0] > 1.5 * p[2];   // red by hue, lit or not
    let ball = 0, shadow = Infinity;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = at(x, y);
        if (red(p)) ball++;
        else if (x > W * 0.45 && y > H * 0.25 && y < H * 0.75) shadow = Math.min(shadow, lum(p));
      }
    }
    return { ball, shadow, far: lum(at(W - 2, H - 2)) };
  };
  const seen = read(await shoot({ albedo: [0.9, 0.1, 0.1] }));
  const shadowless = read(await shoot({ albedo: [0.9, 0.1, 0.1], castsShadow: false }));
  const stand = read(await shoot({ albedo: [0.9, 0.1, 0.1], optical: false, castsShadow: true }));
  // The ball is seen (red), and shadows the floor beside it.
  assert.ok(seen.ball > 20, `the ball, red: ${seen.ball} pixels`);
  assert.ok(seen.shadow < 0.6 * seen.far, `its shadow: ${seen.shadow} against lit floor ${seen.far}`);
  // castsShadow false: seen still, no shadow.
  assert.equal(shadowless.ball, seen.ball, 'still seen, the same');
  assert.ok(shadowless.shadow > 0.9 * shadowless.far, `no shadow: ${shadowless.shadow} against ${shadowless.far}`);
  // optical false, castsShadow true: unseen, and the shadow is there.
  assert.equal(stand.ball, 0, 'unseen');
  assert.ok(stand.shadow < 0.6 * stand.far, `but it shadows: ${stand.shadow} against ${stand.far}`);
});
