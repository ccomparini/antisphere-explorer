// Tests that run antisphere-raycast.wgsls itself, on a real GPU. Run with:
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
import { sharedStructs } from '../tools/shader-build/layout.js';
import { emitModule } from '../tools/shader-build/emit-js.js';
import { buildAll } from '../tools/shader-build/index.js';
import { bindGroup } from './bind-group.js';

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

const cpuMargin = (sc, { a, b, signA, signB }) =>
  separation(matrixOf(sc.nodes[a].prim, signA), matrixOf(sc.nodes[b].prim, signB)).margin;

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
  const margins = await sc.overlapPairs(pairs);

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
  const [margin] = await sc.overlapPairs([pair]);
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
  const margins = await sc.overlapPairs(pairs);
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
  const margins = await sc.overlapPairs(pairs);
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
  await sc.overlapPairs(pairs);                          // warm up
  const runs = 20, start = performance.now();
  for (let i = 0; i < runs; i++) await sc.overlapPairs(pairs);
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
  assert.ok(checked >= 16, `only ${checked} pipelines checked`);
});
