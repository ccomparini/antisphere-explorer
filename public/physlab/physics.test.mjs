// GPU tests for physlab's physics (shaders/physics.wgsls). Run with:
//   node --test public/physlab/physics.test.mjs
//
// Built from shaders/ in memory, so these test the sources whatever state
// public/gen/ is in. Without a GPU, or without `npm install`, they skip.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildAll } from '../../tools/shader-build/index.js';
import { compileSolid, packSolids } from './physics.js';
import { Contact, ContactQuery, viewsOf } from '../gen/layouts.js';

const repo = new URL('../../', import.meta.url);

async function openDevice() {
  let webgpu;
  try { webgpu = await import('webgpu'); } catch { return { skip: 'no webgpu package; run npm install' }; }
  Object.assign(globalThis, webgpu.globals);
  globalThis.gpuInstance = webgpu.create([]);          // held: see CLAUDE.md
  const adapter = await globalThis.gpuInstance.requestAdapter();
  if (!adapter) return { skip: 'no GPU adapter' };
  const device = await adapter.requestDevice();
  const config = JSON.parse(await readFile(new URL('shaders/build.json', repo), 'utf8'));
  const files = await buildAll(config, (p) => readFile(new URL(p, repo), 'utf8'), { warn: () => {} });
  const code = files.find((f) => f.path.endsWith('/physics.wgsl')).content;
  const module = device.createShaderModule({ code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) throw new Error(errors.map((m) => `${m.lineNum}: ${m.message}`).join('\n'));
  return { device, module };
}

const { device, module, skip } = await openDevice();
after(() => device?.destroy());
const gpuTest = (name, fn) => test(name, { skip }, fn);

const MATERIALS = { m: { albedo: [0.5, 0.5, 0.5] } };
const solid = (geometry) => compileSolid(geometry, MATERIALS);

function storage(data, extra = 0) {
  const buf = device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | extra | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buf, 0, data);
  return buf;
}

/**
 * Contacts between solid A's first path and solid B's first path, for each
 * [A, B] given, as plain objects.
 */
async function contacts(pairs) {
  const packed = packSolids(pairs.flat());
  const queries = ContactQuery.allocate(pairs.length);
  pairs.forEach((_, i) => ContactQuery.write(queries, i, {
    path_a: packed.ranges[2 * i].firstPath, path_b: packed.ranges[2 * i + 1].firstPath,
  }));
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'contactFrom' } });
  const bytes = pairs.length * Contact.STRIDE;
  const results = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readBuf = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: storage(packed.nodes) } },
      { binding: 1, resource: { buffer: storage(packed.regions) } },
      { binding: 2, resource: { buffer: storage(packed.paths) } },
      { binding: 3, resource: { buffer: storage(queries.buffer) } },
      { binding: 4, resource: { buffer: results } },
    ],
  });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(pairs.length / 64));
  pass.end();
  enc.copyBufferToBuffer(results, 0, readBuf, 0, bytes);
  device.queue.submit([enc.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const views = viewsOf(readBuf.getMappedRange().slice(0));
  readBuf.unmap();
  return pairs.map((_, i) => Contact.read(views, i));
}

const near = (a, b, eps, what) => {
  if (Array.isArray(a)) a.forEach((v, i) => near(v, b[i], eps, `${what}[${i}]`));
  else assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} is not within ${eps} of ${b}`);
};
const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };

gpuTest('a sphere resting on the ground touches it at one point, pushed straight up', async () => {
  const ball = solid({ sphere: { center: [0, 0, 1], radius: 1 }, material: 'm' });
  const ground = solid({ plane: { normal: [0, 0, 1], offset: 0 }, material: 'm' });   // z < 0
  const [c] = await contacts([[ball, ground]]);
  assert.equal(c.found, 1);
  near(c.point, [0, 0, 0], 2e-3, 'point');
  near(c.normal, [0, 0, 1], 1e-3, 'normal (out of the ground)');
  near(c.depth, 0, 2e-3, 'depth');
});

gpuTest('overlapping spheres: a point in both, depth r1 + r2 - d, pushed apart along the line', async () => {
  const a = solid({ sphere: { center: [0, 0, 0], radius: 1 }, material: 'm' });
  const b = solid({ sphere: { center: [1.5, 0, 0], radius: 1 }, material: 'm' });
  const [c] = await contacts([[a, b]]);
  assert.equal(c.found, 1);
  assert.ok(Math.hypot(...c.point) <= 1 + 1e-3, 'inside A');
  assert.ok(Math.hypot(c.point[0] - 1.5, c.point[1], c.point[2]) <= 1 + 1e-3, 'inside B');
  near(c.depth, 0.5, 0.05, 'depth');
  near(c.normal, [-1, 0, 0], 0.05, 'normal (out of B, towards A)');
});

gpuTest('spheres apart have no contact', async () => {
  const a = solid({ sphere: { center: [0, 0, 0], radius: 1 }, material: 'm' });
  const b = solid({ sphere: { center: [3, 0, 0], radius: 1 }, material: 'm' });
  const [c] = await contacts([[a, b]]);
  assert.equal(c.found, 0);
});

gpuTest('no contact is made up where every pair of regions meets but not all of them', async () => {
  // A column x, y in (0, 1): every point has x + y < 2. Each of its slabs
  // alone meets the half-space x + y > 3, so no single pair proves them
  // apart - but there is no point in all three.
  const column = solid({ intersect: [
    { slab: { center: [0.5, 0, 0], axis: [1, 0, 0], thickness: 1 }, material: 'm' },
    { slab: { center: [0, 0.5, 0], axis: [0, 1, 0], thickness: 1 }, material: 'm' },
  ] });
  const beyond = (s) => solid({ plane: { normal: unit([-1, -1, 0]), offset: -s / Math.SQRT2 }, material: 'm' });  // x + y > s
  const [far, reaching] = await contacts([[column, beyond(3)], [column, beyond(1.5)]]);
  assert.equal(far.found, 0, 'x + y > 3 is out of reach');
  assert.equal(reaching.found, 1, 'x + y > 1.5 is not');
  const [x, y] = reaching.point;
  assert.ok(x > -1e-3 && x < 1 + 1e-3 && y > -1e-3 && y < 1 + 1e-3 && x + y > 1.5 - 1e-3, `point ${reaching.point} in both`);
});

gpuTest('a tilted rod whose lower end dips into the ground has its contact at that end', async () => {
  // A cylinder cut to length by a slab along its axis. The endless cylinder
  // meets the ground all along one side, so the certificate's point can be
  // anywhere down there, well past the rod's end; it has to be brought back.
  const axis = unit([1, 0, -0.2]);
  const at = (s) => [s * axis[0], 0, 1 + s * axis[2]];
  const rod = solid({ intersect: [
    { cylinder: { center: [0, 0, 1], axis, radius: 0.5 }, material: 'm' },
    { slab: { center: at(4.5), axis, thickness: 2 }, material: 'm' },          // s in (3.5, 5.5)
  ] });
  const ground = solid({ plane: { normal: [0, 0, 1], offset: 0 }, material: 'm' });
  const [c] = await contacts([[rod, ground]]);
  assert.equal(c.found, 1, 'the dipped end is found');
  const s = (c.point[0] * axis[0] + (c.point[2] - 1) * axis[2]);
  assert.ok(s > 3.5 - 1e-2 && s < 5.5 + 1e-2, `along the rod at ${s}`);
  assert.ok(c.point[2] <= 1e-3, `in the ground: z = ${c.point[2]}`);
  near(c.normal, [0, 0, 1], 1e-3, 'normal');
  // Its lowest corner is at s = 5.5, 0.5 below the axis there: z = -0.57.
  const lowest = at(5.5)[2] - 0.5 / Math.hypot(1, 0.2);
  assert.ok(c.depth > 0 && c.depth <= -lowest + 1e-2, `depth ${c.depth}, deepest ${-lowest}`);
});
