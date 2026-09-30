// GPU tests for physlab's physics (shaders/physics.wgsls). Run with:
//   node --test public/physlab/physics.test.mjs
//
// Built from shaders/ in memory, so these test the sources whatever state
// public/gen/ is in. Without a GPU, or without `npm install`, they skip.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildAll } from '../../tools/shader-build/index.js';
import { compileSolid, packSolids, PhysicsSim } from './physics.js';
import { PhysicsWorld } from './physics-world.js';
import { World, WorldObject } from './world.js';
import { fromAxisAngle } from './quat.js';
import { Contact, ContactQuery, viewsOf } from '../gen/layouts.js';
import { compileScene } from '../antisphere-scene.js';

const repo = new URL('../../', import.meta.url);

async function openDevice() {
  let webgpu;
  try { webgpu = await import('webgpu'); } catch { return { skip: 'no webgpu package; run npm install' }; }
  Object.assign(globalThis, webgpu.globals);
  globalThis.gpuInstance = webgpu.create([]);          // held: see CLAUDE.md
  const adapter = await globalThis.gpuInstance.requestAdapter();
  if (!adapter) return { skip: 'no GPU adapter' };
  const device = await adapter.requestDevice();
  // A validation error otherwise only shows as nothing happening.
  device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
  const config = JSON.parse(await readFile(new URL('shaders/build.json', repo), 'utf8'));
  const files = await buildAll(config, (p) => readFile(new URL(p, repo), 'utf8'), { warn: () => {} });
  const code = files.find((f) => f.path.endsWith('/physics.wgsl')).content;
  const module = device.createShaderModule({ code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) throw new Error(errors.map((m) => `${m.lineNum}: ${m.message}`).join('\n'));
  return { device, module };
}

const gpuErrors = [];
const { device, module, skip } = await openDevice();
after(() => device?.destroy());
const gpuTest = (name, fn) => test(name, { skip }, async () => {
  gpuErrors.length = 0;
  await fn();
  await device.queue.onSubmittedWorkDone();
  assert.deepEqual(gpuErrors, [], 'GPU validation errors');
});

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

// -- particles, gravity and constraints -------------------------------------------

const GM = 9.81 * 500 * 500;               // 9.81 m/s^2 at 500 m
const gAt = (r) => GM / (r * r);
const sim = (particles, bodies, extra = {}) =>
  new PhysicsSim(device, module, { particles, bodies, gravityCentre: [0, 0, 0], gm: GM, ...extra });
const alone = (pos, vel, body = 0) => ({ pos, vel, invMass: 1, body });
const point = { p0: 0, p1: 0, rest: 0 };   // a body of one particle: nothing to hold together

gpuTest('a dropped particle falls as 1/2 g t^2', async () => {
  const s = sim([alone([0, 0, 600])], [point]);
  assert.equal(s.step(1.0), 240);
  const [q] = await s.read();
  const g = gAt(600);                      // barely changes over a 3.4 m drop
  near(q.pos[2], 600 - 0.5 * g, 0.03, 'height after 1 s');
  near(q.vel[2], -g, 0.05, 'speed after 1 s');
  near([q.pos[0], q.pos[1]], [0, 0], 1e-6, 'straight down');
  s.destroy();
});

gpuTest('a circular orbit keeps its radius', async () => {
  const r = 600, v = Math.sqrt(GM / r);
  const s = sim([alone([r, 0, 0], [0, v, 0])], [point]);
  let most = 0;
  for (let t = 0; t < 10; t++) {
    s.step(1);
    const [q] = await s.read();
    most = Math.max(most, Math.abs(Math.hypot(...q.pos) - r) / r);
  }
  assert.ok(most < 2e-3, `radius strays by ${(most * 100).toFixed(3)}%`);
  s.destroy();
});

gpuTest('a rigid rod keeps its length while it tumbles, and its centre falls freely', async () => {
  const s = sim(
    [alone([-2, 0, 600], [0, 0, 5]), alone([2, 0, 600], [0, 0, -5])],
    [{ p0: 0, p1: 1, rest: 4 }],
  );
  s.step(1);
  const [a, b] = await s.read();
  near(Math.hypot(...a.pos.map((v, i) => v - b.pos[i])), 4, 1e-3, 'length');
  near((a.pos[2] + b.pos[2]) / 2, 600 - 0.5 * gAt(600), 0.05, 'centre height');
  assert.ok(Math.abs(a.pos[2] - b.pos[2]) > 1, 'it turned');
  s.destroy();
});

gpuTest('thrust equal to gravity hovers; a pinned particle never moves', async () => {
  const s = sim([alone([0, 0, 600]), { pos: [5, 0, 600], invMass: 0, body: 1 }], [point, { p0: 1, p1: 1, rest: 0 }]);
  s.setThrust(0, [0, 0, gAt(600)]);
  s.step(1);
  const [hover, pinned] = await s.read();
  near(hover.pos, [0, 0, 600], 2e-3, 'hovering');
  assert.deepEqual(pinned.pos, [5, 0, 600]);
  s.destroy();
});

// -- bodies against static ground ----------------------------------------------------
//
// A planetoid of radius 500 whose top is at the origin: the simulation's
// floating origin sits where the action is, as physlab's will.

const ground = () => compileSolid({ sphere: { center: [0, 0, -500], radius: 500 }, material: 'm' }, MATERIALS);
const onGround = (particles, bodies) =>
  new PhysicsSim(device, module, { particles, bodies, statics: [ground()], gravityCentre: [0, 0, -500], gm: GM });

// Two half-masses on a body's axis, spaced so the pair has the solid's
// inertia across its axis: 2 (m/2) (d/2)^2 = I.
const spacing = (inertiaPerMass) => 2 * Math.sqrt(inertiaPerMass);

// A body upright (its +Y along world +Z) with its local origin at `at`, or
// turned by `tilt` radians about world X.
function bodyAt(at, geometry, { inertiaPerMass, radius, mass = 1, tilt = 0, friction = 0.6 }) {
  const d = spacing(inertiaPerMass);
  const u = [0, -Math.sin(tilt), Math.cos(tilt)];
  const place = (a) => at.map((v, i) => v + a * u[i]);
  const w = 2 / mass;
  return {
    particles: [{ pos: place(-d / 2), invMass: w, body: 0 }, { pos: place(d / 2), invMass: w, body: 0 }],
    body: { p0: 0, p1: 1, rest: d, solid: compileSolid(geometry, MATERIALS), a0: -d / 2, a1: d / 2, radius, friction },
  };
}

const lift = (p) => p[2] + 500 - Math.hypot(p[0], p[1], p[2] + 500);   // ~ height above the ground
const heightOf = (p) => Math.hypot(p[0], p[1], p[2] + 500) - 500;

gpuTest('a dropped sphere comes to rest on the ground', async () => {
  const r = 0.5;
  const { particles, body } = bodyAt([0, 0, 4], { sphere: { center: [0, 0, 0], radius: r }, material: 'm' },
    { inertiaPerMass: 0.4 * r * r, radius: r });
  const s = onGround(particles, [body]);
  s.step(4);
  const [a, b] = await s.read();
  const centre = a.pos.map((v, i) => (v + b.pos[i]) / 2);
  near(heightOf(centre), r, 0.02, 'centre above the ground');
  assert.ok(Math.hypot(...a.vel) < 0.05, `still moving at ${Math.hypot(...a.vel)} m/s`);
  const contacts = await s.readContacts();
  assert.ok(contacts.length >= 1, 'touching');
  s.destroy();
});

gpuTest('a rod dropped at an angle turns as it lands, and ends lying flat', async () => {
  const r = 0.25, L = 4;
  const rod = { intersect: [
    { cylinder: { center: [0, 0, 0], axis: [0, 1, 0], radius: r }, material: 'm' },
    { slab: { center: [0, 0, 0], axis: [0, 1, 0], thickness: L }, material: 'm' },
  ] };
  const { particles, body } = bodyAt([0, 0, 3], rod,
    { inertiaPerMass: L * L / 12 + r * r / 4, radius: Math.hypot(L / 2, r), tilt: Math.PI / 3 });   // 30 deg from flat
  const s = onGround(particles, [body]);
  s.step(6);
  const [a, b] = await s.read();
  near(heightOf(a.pos), r, 0.05, 'one end on the ground');
  near(heightOf(b.pos), r, 0.05, 'and the other');
  assert.ok(Math.hypot(...a.vel) + Math.hypot(...b.vel) < 0.1, 'at rest');
  s.destroy();
});

// Its centre of mass is about 4.3 m above a base 1 m in radius, so tipped
// less than ~13 degrees it should rock back onto its base, settle, and
// stand - which needs pushes at the rim to turn it (the lever arm), and
// to lose the rocking's energy.
for (const tilt of [0, 0.05]) gpuTest(`a rocket set down ${tilt ? 'tilted 3 degrees' : 'upright'} stands on its base`, async () => {
  const rocket = { union: [
    { intersect: [
      { cylinder: { center: [0, 0, 0], axis: [0, 1, 0], radius: 1 }, material: 'm' },
      { slab: { center: [0, 0, 0], axis: [0, 1, 0], thickness: 8 }, material: 'm' },
    ] },
    { intersect: [
      { cone: { apex: [0, 6, 0], axis: [0, 1, 0], slope: 0.5 }, material: 'm' },
      { slab: { center: [0, 5, 0], axis: [0, 1, 0], thickness: 2 }, material: 'm' },
    ] },
  ] };
  const { particles, body } = bodyAt([0, 0, 4.01 + Math.sin(tilt)], rocket,
    { inertiaPerMass: 64 / 12 + 1 / 4, radius: 6.1, tilt });
  const s = onGround(particles, [body]);
  s.step(6);                                     // tilted, it rocks for ~5 s before it rests
  const [a, b] = await s.read();
  const axis = b.pos.map((v, i) => v - a.pos[i]);
  const upright = axis[2] / Math.hypot(...axis);
  assert.ok(upright > Math.cos(0.1 * Math.PI / 180), `upright within 0.1 degree: axis . up = ${upright}`);
  assert.ok(Math.hypot(...b.vel) < 0.03, `at rest: its top moves at ${Math.hypot(...b.vel)} m/s`);
  const base = a.pos.map((v, i) => v - (-spacing(64 / 12 + 1 / 4) / 2 + 4) * axis[i] / Math.hypot(...axis));
  near(heightOf(base), 0, 0.03, 'base on the ground');
  s.destroy();
});

// -- bodies against each other --------------------------------------------------------

// A sphere as a two-particle body, axis along world Z, centred at `at`.
function sphereBody(at, r, index, { vel = [0, 0, 0], mass = 1 } = {}) {
  const d = spacing(0.4 * r * r);
  const w = 2 / mass;
  return {
    particles: [
      { pos: [at[0], at[1], at[2] - d / 2], vel, invMass: w, body: index },
      { pos: [at[0], at[1], at[2] + d / 2], vel, invMass: w, body: index },
    ],
    body: { p0: 2 * index, p1: 2 * index + 1, rest: d, solid: compileSolid({ sphere: { center: [0, 0, 0], radius: r }, material: 'm' }, MATERIALS),
            a0: -d / 2, a1: d / 2, radius: r, friction: 0.5 },
  };
}
const centreOf = (qs, b) => qs[2 * b].pos.map((v, i) => (v + qs[2 * b + 1].pos[i]) / 2);
const velOf = (qs, b) => qs[2 * b].vel.map((v, i) => (v + qs[2 * b + 1].vel[i]) / 2);

gpuTest('a head-on collision conserves momentum and never passes through', async () => {
  const a = sphereBody([-2, 0, 0], 0.5, 0, { vel: [2, 0, 0] });
  const b = sphereBody([2, 0, 0], 0.5, 1);
  const s = new PhysicsSim(device, module, { particles: [...a.particles, ...b.particles], bodies: [a.body, b.body],
    gravityCentre: [0, 0, 0], gm: 0 });
  let closest = Infinity;
  for (let k = 0; k < 60; k++) {
    s.step(0.05);
    const qs = await s.read();
    const [ca, cb] = [centreOf(qs, 0), centreOf(qs, 1)];
    closest = Math.min(closest, Math.hypot(...ca.map((v, i) => v - cb[i])));
    assert.ok(ca[0] < cb[0], `passed through at step ${k}`);
  }
  const qs = await s.read();
  const [va, vb] = [velOf(qs, 0), velOf(qs, 1)];
  near(va[0] + vb[0], 2, 0.02, 'momentum (equal masses)');
  near(vb[0], 1, 0.1, 'the struck one takes half (inelastic)');
  assert.ok(closest > 1 - 0.02, `overlapped by ${1 - closest} m at most`);
  s.destroy();
});

// (A sphere on a sphere would roll off - that balance is unstable - so the
// stack here is a sphere on the flat top of a puck, which is stable. On
// flat ground: a flat puck on a round planetoid touches it at one point,
// and with a load off-centre that is a balancing act, not a stack.)
gpuTest('a sphere dropped onto a puck on flat ground settles on top of it', async () => {
  const R = 1, h = 0.5, r = 0.3;
  const puckGeometry = { intersect: [
    { cylinder: { center: [0, 0, 0], axis: [0, 1, 0], radius: R }, material: 'm' },
    { slab: { center: [0, 0, 0], axis: [0, 1, 0], thickness: h }, material: 'm' },
  ] };
  const d = spacing((3 * R * R + h * h) / 12);
  const puck = {
    particles: [{ pos: [0, 0, h / 2 - d / 2], invMass: 2, body: 0 }, { pos: [0, 0, h / 2 + d / 2], invMass: 2, body: 0 }],
    body: { p0: 0, p1: 1, rest: d, solid: compileSolid(puckGeometry, MATERIALS), a0: -d / 2, a1: d / 2,
            radius: Math.hypot(R, h / 2), friction: 0.6 },
  };
  const ball = sphereBody([0.3, 0, 2], r, 1);
  const flat = compileSolid({ plane: { normal: [0, 0, 1], offset: 0 }, material: 'm' }, MATERIALS);
  const s = new PhysicsSim(device, module, { particles: [...puck.particles, ...ball.particles], bodies: [puck.body, ball.body],
    statics: [flat], gravityCentre: [0, 0, -1e6], gm: 9.81e12 });     // 9.81 m/s^2, as good as uniform
  s.step(3);
  const qs = await s.read();
  const [cp, cb] = [centreOf(qs, 0), centreOf(qs, 1)];
  near(cp[2], h / 2, 0.03, 'the puck on the ground');
  near(cb[2], h + r, 0.03, 'the ball on the puck');
  near(cb[0], 0.3, 0.02, 'where it landed');
  assert.ok(Math.hypot(cb[0] - cp[0], cb[1] - cp[1]) < R, 'still over the puck');
  for (const b of [0, 1]) assert.ok(Math.hypot(...velOf(qs, b)) < 0.03, `body ${b} at rest`);
  s.destroy();
});

gpuTest('a ball given a push slides, then rolls at 5/7 of its speed', async () => {
  // Friction brings a sliding ball to rolling without slipping, and a
  // uniform sphere then keeps 5/7 of its starting speed.
  const r = 0.3;
  const ball = sphereBody([0, 0, r], r, 0, { vel: [0.5, 0, 0] });
  ball.body.friction = 0.3;
  const flat = compileSolid({ plane: { normal: [0, 0, 1], offset: 0 }, material: 'm' }, MATERIALS);
  const s = new PhysicsSim(device, module, { particles: ball.particles, bodies: [ball.body],
    statics: [flat], gravityCentre: [0, 0, -1e6], gm: 9.81e12 });
  s.step(2);
  const v1 = velOf(await s.read(), 0)[0];
  s.step(1);
  const v2 = velOf(await s.read(), 0)[0];
  near(v1, 0.5 * 5 / 7, 0.01, 'rolling speed');
  near(v2, v1, 0.002, 'and it keeps it');
  s.destroy();
});

// -- world objects, simulated ---------------------------------------------------------

gpuTest('PhysicsWorld drops world objects onto a static one and follows them back', async () => {
  // Far from the world's origin on purpose: the simulation is centred on
  // `origin`, and the objects' poses come back in world coordinates.
  const world = new World();
  const planet = world.add(new WorldObject('planet', { geometry: { sphere: { center: [0, 0, 0], radius: 500 }, material: 'm' } }));
  const ball = world.add(new WorldObject('ball', {
    position: [0, 0, 510], geometry: { sphere: { center: [0, 0, 0], radius: 1 }, material: 'm' },
    body: { mass: 10, centre: 0, inertia: 0.4, radius: 1 },
  }));
  const rod = world.add(new WorldObject('rod', {
    position: [6, 0, 506], orientation: fromAxisAngle([1, 0, 0], 1.2),
    geometry: { intersect: [
      { cylinder: { center: [0, 0, 0], axis: [0, 1, 0], radius: 0.3 }, material: 'm' },
      { slab: { center: [0, 0, 0], axis: [0, 1, 0], thickness: 4 }, material: 'm' },
    ] },
    body: { mass: 10, centre: 0, inertia: 16 / 12, radius: 2.1 },
  }));
  const physics = new PhysicsWorld(device, module, world, {
    materials: MATERIALS, origin: [0, 0, 500], gravity: { from: planet, gm: GM },
  });
  assert.equal(physics.simulates(ball), true);
  assert.equal(physics.simulates(planet), false);
  for (let f = 0; f < 240; f++) {                  // 4 s at 60 frames a second
    physics.update(1 / 60);
    await physics.reading;                         // a real page doesn't wait; the test does
  }
  physics.update(0);
  near(Math.hypot(...ball.position) - 500, 1, 0.03, 'the ball on the ground');
  near(Math.hypot(...rod.position) - 500, 0.3, 0.05, 'the rod lying on it');
  // Thrust: up on the ball, more than gravity, and it climbs.
  physics.setThrust(ball, [0, 0, 15]);
  for (let f = 0; f < 60; f++) { physics.update(1 / 60); await physics.reading; }
  physics.update(0);
  assert.ok(Math.hypot(...ball.position) - 500 > 2, `climbing: ${Math.hypot(...ball.position) - 500} m up`);
  await physics.reading;
  physics.destroy();
});

gpuTest('PhysicsWorld.add fires a body in mid-run, and what was moving keeps moving', async () => {
  // A ball falling, then a capsule fired sideways 20 m above the ground.
  // Adding it rebuilds the simulation: the ball must carry on falling from
  // where it had got to, at the speed it had, and the capsule leave at its
  // own speed, as good as unhindered at first.
  const world = new World();
  const planet = world.add(new WorldObject('planet', { geometry: { sphere: { center: [0, 0, 0], radius: 500 }, material: 'm' } }));
  const ball = world.add(new WorldObject('ball', {
    position: [0, 0, 560], geometry: { sphere: { center: [0, 0, 0], radius: 1 }, material: 'm' },
    body: { mass: 10, centre: 0, inertia: 0.4, radius: 1 },
  }));
  const physics = new PhysicsWorld(device, module, world, {
    materials: MATERIALS, origin: [0, 0, 500], gravity: { from: planet, gm: GM },
  });
  const run = async (frames) => {
    for (let f = 0; f < frames; f++) {
      physics.update(1 / 60);
      await physics.reading;
      await physics.rebuilding;
    }
  };
  // Gravity weakens with height (7.8 m/s^2 up here), so where free fall
  // from 560 m should have got to, in small steps.
  const fall = (t) => {
    let r = 560, v = 0;
    for (let k = 0; k < t * 1000; k++) { v -= (GM / (r * r)) * 1e-3; r += v * 1e-3; }
    return 560 - r;
  };
  await run(60);
  physics.update(0);
  near(560 - ball.position[2], fall(1), 0.1, 'a second of free fall');

  const capsule = world.add(new WorldObject('capsule', {
    position: [0, 20, 520],                         // lying along +Y, the way it goes
    geometry: { intersect: [
      { cylinder: { center: [0, 0, 0], axis: [0, 1, 0], radius: 0.5 }, material: 'm' },
      { slab: { center: [0, 0, 0], axis: [0, 1, 0], thickness: 2 }, material: 'm' },
    ] },
    body: { mass: 10, centre: 0, inertia: 4 / 12, radius: 1.2 },
  }));
  physics.add(capsule, [0, 25, 0]);
  assert.equal(physics.simulates(capsule), true);
  // physlab sets every body's thrust each frame, the newcomer's included,
  // before the simulation has room for it.
  for (const o of physics.bodies) physics.setThrust(o, [0, 0, 0]);
  await run(31);                                  // the first frame rebuilds, and runs nothing
  physics.update(0);
  await physics.reading;
  physics.update(0);
  // Half a second more for each: the ball from 1 s to 1.5 s of its fall.
  near(560 - ball.position[2], fall(1.5), 0.1, 'the ball fell on from where it was');
  near(capsule.position[1], 20 + 25 * 0.5, 0.2, 'the capsule went its own way');
  near(capsule.position[2], 520 - 0.5 * 9.81 * (500 / 520) ** 2 * 0.25, 0.1, 'and fell as it went');
  await physics.reading;
  physics.destroy();
});

gpuTest('only the pairs set are tested: with none, a sphere falls through the ground', async () => {
  const { particles, body } = sphereBody([0, 0, 1], 0.5, 0);
  const s = onGround(particles, [body]);
  s.setPairs([]);
  assert.equal(s.pairCount, 0);
  s.step(1);
  assert.ok(centreOf(await s.read(), 0)[2] < -1, 'fell through');
  s.destroy();
  const t = onGround(sphereBody([0, 0, 1], 0.5, 0).particles, [sphereBody([0, 0, 1], 0.5, 0).body]);
  t.setPairs([]);
  t.setPairs([{ body: 0, other: 1 }]);            // the ground, back again
  t.step(1);
  near(centreOf(await t.read(), 0)[2], 0.5, 0.02, 'landed');
  t.destroy();
});

gpuTest('an overlapping group of the world is the broad phase: far pairs untested, and everything still lands', async () => {
  // A ball on the ground, one falling from 60 m (too far to touch anything
  // at first; its bounds must grow with its speed in time to meet the
  // ground's), and two rods apart from them, all around a planet.
  const world = new World();
  const planet = world.add(new WorldObject('planet', { geometry: { sphere: { center: [0, 0, 0], radius: 500 }, material: 'm' } }));
  const ball = (name, at) => world.add(new WorldObject(name, {
    position: at, geometry: { sphere: { center: [0, 0, 0], radius: 1 }, material: 'm' },
    body: { mass: 10, centre: 0, inertia: 0.4, radius: 1 },
  }));
  const rod = (name, at) => world.add(new WorldObject(name, {
    position: at,                                   // along Y: lying down
    geometry: { intersect: [
      { cylinder: { center: [0, 0, 0], axis: [0, 1, 0], radius: 0.3 }, material: 'm' },
      { slab: { center: [0, 0, 0], axis: [0, 1, 0], thickness: 4 }, material: 'm' },
    ] },
    body: { mass: 10, centre: 0, inertia: 16 / 12, radius: 2.1 },
  }));
  const low = ball('low', [0, 0, 501.5]);
  const high = ball('high', [8, 0, 560]);
  const rods = [rod('rod1', [20, 0, 502]), rod('rod2', [-20, 0, 502])];
  const physics = new PhysicsWorld(device, module, world, {
    materials: MATERIALS, origin: [0, 0, 500], gravity: { from: planet, gm: GM },
  });
  const all = physics.pairCount;
  const broadPhase = () => {
    const built = compileScene(world.sceneSpec({ materials: MATERIALS }, { bounds: (o) => physics.boundsOf(o) }));
    physics.setCandidates(world.overlappingPairs(built.overlaps));
  };
  broadPhase();
  // Each body against the planet but the high ball: three bodies, and
  // path pairs 1 (ball), 1, 1 (rods).
  assert.equal(physics.pairCount, 3, `pairs at first (of ${all})`);
  for (let f = 0; f < 5 * 60; f++) {
    physics.update(1 / 60);
    await physics.reading;
    physics.update(0);
    broadPhase();
  }
  const up = (o) => Math.hypot(...o.position) - 500;
  near(up(low), 1, 0.05, 'the low ball on the ground');
  near(up(high), 1, 0.05, 'the high ball landed, not fallen through');
  for (const r of rods) near(up(r), 0.3, 0.05, 'a rod lying on the ground');
  assert.equal(physics.pairCount, 4, 'each body against the planet, and nothing else');
  await physics.reading;
  physics.destroy();
});

gpuTest('a rod dropped at any steep angle comes to rest lying flat, gaining no energy', async () => {
  // Landing nearly on end once gained energy on every bounce - up to 23 m
  // from a 6 m drop - because depth was measured to the nearest boundary,
  // which for a tipped end face is sideways, not down.
  const flat = compileSolid({ plane: { normal: [0, 0, 1], offset: 0 }, material: 'm' }, MATERIALS);
  const rod = { intersect: [
    { cylinder: { center: [0, 0, 0], axis: [0, 1, 0], radius: 0.3 }, material: 'm' },
    { slab: { center: [0, 0, 0], axis: [0, 1, 0], thickness: 4 }, material: 'm' },
  ] };
  const d = spacing(16 / 12);
  for (const deg of [30, 60, 75, 80, 85]) {
    const t = deg * Math.PI / 180, u = [0, Math.cos(t), Math.sin(t)];
    const s = new PhysicsSim(device, module, {
      particles: [0, 1].map((k) => ({ pos: u.map((v, i) => [0, 0, 6][i] + (k ? 1 : -1) * v * d / 2), invMass: 0.2, body: 0 })),
      bodies: [{ p0: 0, p1: 1, rest: d, solid: compileSolid(rod, MATERIALS), a0: -d / 2, a1: d / 2, radius: 2.1, friction: 0.5 }],
      statics: [flat], gravityCentre: [0, 0, -1e6], gm: 9.81e12 });
    s.step(5);
    let highest = 0;
    for (let k = 0; k < 20; k++) {
      s.step(0.25);
      const q = await s.read();
      highest = Math.max(highest, (q[0].pos[2] + q[1].pos[2]) / 2);
    }
    assert.ok(highest < 0.35, `dropped at ${deg} degrees, it rose to ${highest.toFixed(2)} m after settling`);
    s.destroy();
  }
});

// -- resting stays at rest ------------------------------------------------------------
//
// XPBD takes velocity from how far a substep moved things, so any push a
// contact doesn't finish in one substep comes back as a small bounce in the
// next: bodies that look settled keep shimmering. These settle a body, then
// watch it for a second at 60 frames a second: the fastest any particle
// moves, and how far any drifts from where it settled.
async function restlessness(s, settle) {
  s.step(settle);
  const from = await s.read();
  let fastest = 0, drift = 0;
  for (let f = 0; f < 60; f++) {
    s.step(1 / 60);
    const qs = await s.read();
    qs.forEach((q, i) => {
      fastest = Math.max(fastest, Math.hypot(...q.vel));
      drift = Math.max(drift, Math.hypot(...q.pos.map((v, k) => v - from[i].pos[k])));
    });
  }
  s.destroy();
  return { fastest, drift };
}

const ROD = { intersect: [
  { cylinder: { center: [0, 0, 0], axis: [0, 1, 0], radius: 0.25 }, material: 'm' },
  { slab: { center: [0, 0, 0], axis: [0, 1, 0], thickness: 4 }, material: 'm' },
] };
const ROCKET = { union: [
  { intersect: [
    { cylinder: { center: [0, 0, 0], axis: [0, 1, 0], radius: 1 }, material: 'm' },
    { slab: { center: [0, 0, 0], axis: [0, 1, 0], thickness: 8 }, material: 'm' },
  ] },
  { intersect: [
    { cone: { apex: [0, 6, 0], axis: [0, 1, 0], slope: 0.5 }, material: 'm' },
    { slab: { center: [0, 5, 0], axis: [0, 1, 0], thickness: 2 }, material: 'm' },
  ] },
] };
const PUCK = { intersect: [
  { cylinder: { center: [0, 0, 0], axis: [0, 1, 0], radius: 1 }, material: 'm' },
  { slab: { center: [0, 0, 0], axis: [0, 1, 0], thickness: 0.5 }, material: 'm' },
] };

const resting = {
  'a sphere on the planetoid': () => {
    const { particles, body } = bodyAt([0, 0, 0.51], { sphere: { center: [0, 0, 0], radius: 0.5 }, material: 'm' },
      { inertiaPerMass: 0.1, radius: 0.5 });
    return onGround(particles, [body]);
  },
  'a rod lying on the planetoid': () => {
    const { particles, body } = bodyAt([0, 0, 0.26], ROD,
      { inertiaPerMass: 16 / 12 + 0.25 * 0.25 / 4, radius: 2.02, tilt: Math.PI / 2 });
    return onGround(particles, [body]);
  },
  'a rocket standing on the planetoid': () => {
    const { particles, body } = bodyAt([0, 0, 4.01], ROCKET, { inertiaPerMass: 64 / 12 + 1 / 4, radius: 6.1 });
    return onGround(particles, [body]);
  },
  'a sphere on a puck on flat ground': () => {
    const d = spacing((3 + 0.25) / 12);
    const puck = {
      particles: [{ pos: [0, 0, 0.25 - d / 2], invMass: 2, body: 0 }, { pos: [0, 0, 0.25 + d / 2], invMass: 2, body: 0 }],
      body: { p0: 0, p1: 1, rest: d, solid: compileSolid(PUCK, MATERIALS), a0: -d / 2, a1: d / 2,
              radius: Math.hypot(1, 0.25), friction: 0.6 },
    };
    const ball = sphereBody([0.3, 0, 0.81], 0.3, 1);
    const flat = compileSolid({ plane: { normal: [0, 0, 1], offset: 0 }, material: 'm' }, MATERIALS);
    return new PhysicsSim(device, module, { particles: [...puck.particles, ...ball.particles], bodies: [puck.body, ball.body],
      statics: [flat], gravityCentre: [0, 0, -1e6], gm: 9.81e12 });
  },
};

for (const [what, make] of Object.entries(resting)) gpuTest(`${what} stays at rest`, async () => {
  const { fastest, drift } = await restlessness(make(), 3);
  console.log(`# ${what}: fastest ${(fastest * 1000).toFixed(3)} mm/s, drift ${(drift * 1000).toFixed(3)} mm`);
  assert.ok(fastest < 1e-3, `a particle moved at ${(fastest * 1000).toFixed(2)} mm/s`);
  assert.ok(drift < 1e-3, `a particle drifted ${(drift * 1000).toFixed(2)} mm`);
});
