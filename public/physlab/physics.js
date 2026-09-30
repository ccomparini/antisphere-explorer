// physlab's physics, host side: what the compute passes in
// shaders/physics.wgsls work on, and (as it grows) running them.
//
// A solid is a compiled geometry subtree: its nodes, and its interior paths
// - each a conjunction of regions (node, sign), from interiorPaths() in
// overlap.js. Two solids touch where a path of one and a path of the other
// share a point; pathContact() in the shader finds it.

import { compileScene, packNodes } from '../antisphere-scene.js';
import { interiorPaths } from '../overlap.js';
import { Body, Particle, Path, Region, SimParams, viewsOf } from '../gen/layouts.js';

/** A geometry subtree (scene-format.md) as a solid: { nodes, paths }. */
export function compileSolid(geometry, materials) {
  const built = compileScene({ materials, lights: [], root: geometry });
  const solid = (i) => !!built.materials[built.nodes[i].material].solid;
  return { nodes: built.nodes, paths: interiorPaths(built.nodes, 1, solid) };
}

/**
 * Several solids in one set of buffers: their nodes one after another,
 * their paths' regions pointing into that, and for each solid where its
 * paths and nodes start and how many there are.
 *
 * @returns {{ nodes: ArrayBuffer, regions: ArrayBuffer, paths: ArrayBuffer,
 *             ranges: { firstPath, pathCount, firstNode, nodeCount }[] }}
 */
export function packSolids(solids) {
  const nodes = [], regions = [], paths = [], ranges = [];
  for (const s of solids) {
    const firstNode = nodes.length, firstPath = paths.length;
    nodes.push(...s.nodes);
    for (const path of s.paths) {
      paths.push({ first: regions.length, count: path.length });
      for (const { node, sign } of path) regions.push({ node: firstNode + node, sign });
    }
    ranges.push({ firstPath, pathCount: s.paths.length, firstNode, nodeCount: s.nodes.length });
  }
  const regionViews = Region.allocate(Math.max(1, regions.length));
  regions.forEach((r, i) => Region.write(regionViews, i, r));
  const pathViews = Path.allocate(Math.max(1, paths.length));
  paths.forEach((p, i) => Path.write(pathViews, i, p));
  return { nodes: packNodes(nodes), regions: regionViews.buffer, paths: pathViews.buffer, ranges };
}

// -- running it ---------------------------------------------------------------------

/**
 * Particles and bodies on the GPU, stepped in fixed substeps (XPBD; see
 * shaders/physics.wgsls). Coordinates are the simulation's own: callers
 * keep them near the origin (a floating origin), shifting in and out in
 * f64, so f32 keeps its resolution.
 */
export class PhysicsSim {
  /**
   * @param {GPUDevice} device
   * @param {GPUShaderModule} module  gen/physics.wgsl
   * @param {object} setup
   * @param {{ pos, vel?, invMass, body }[]} setup.particles
   * @param {{ p0, p1, rest, compliance?, thrust? }[]} setup.bodies
   * @param {number[]} setup.gravityCentre  in simulation coordinates
   * @param {number} setup.gm               gravity is gm / r^2
   * @param {number} [setup.h]              substep, seconds
   * @param {number} [setup.iterations]     constraint rounds per substep
   */
  constructor(device, module, { particles, bodies, gravityCentre, gm, h = 1 / 240, iterations = 4 }) {
    this.device = device;
    this.h = h;
    this.iterations = iterations;
    this.particleCount = particles.length;
    this.bodyCount = bodies.length;
    this.pending = 0;                     // seconds not yet simulated

    const storage = (data, usage = 0) => {
      const buf = device.createBuffer({ size: data.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | usage });
      device.queue.writeBuffer(buf, 0, data);
      return buf;
    };
    const pv = Particle.allocate(particles.length);
    particles.forEach((q, i) => Particle.write(pv, i, {
      pos: q.pos, vel: q.vel ?? [0, 0, 0], inv_mass: q.invMass, body: q.body, start: q.pos,
    }));
    this.particles = storage(pv.buffer, GPUBufferUsage.COPY_SRC);
    this.bodyViews = Body.allocate(Math.max(1, bodies.length));
    bodies.forEach((b, i) => Body.write(this.bodyViews, i, {
      p0: b.p0, p1: b.p1, rest: b.rest, compliance: b.compliance ?? 0, thrust: b.thrust ?? [0, 0, 0],
    }));
    this.bodies = storage(this.bodyViews.buffer);
    const params = SimParams.allocate(1);
    SimParams.write(params, 0, {
      gravity_centre: gravityCentre, gm, h, particle_count: particles.length, body_count: bodies.length,
    });
    this.params = device.createBuffer({ size: SimParams.SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.params, 0, params.buffer);
    this.readBuf = device.createBuffer({ size: pv.buffer.byteLength,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    // Buffers by their binding number in shaders/physics.wgsls. An 'auto'
    // layout holds only the bindings its entry point uses, so each stage
    // names the ones it binds.
    const buffers = { 5: this.particles, 6: this.bodies, 7: this.params };
    const stage = (entryPoint, bindings) => {
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: bindings.map((binding) => ({ binding, resource: { buffer: buffers[binding] } })),
      });
      return { pipeline, bindGroup };
    };
    this.stages = {
      predict: stage('predict', [5, 6, 7]),
      solveDistance: stage('solveDistance', [5, 6, 7]),
      updateVelocity: stage('updateVelocity', [5, 7]),
    };
  }

  /** Set a body's extra acceleration (world axes of the simulation), m/s^2. */
  setThrust(body, thrust) {
    Body.write(this.bodyViews, body, { thrust });
    const at = body * Body.STRIDE + Body.FIELDS.thrust.offset;
    this.device.queue.writeBuffer(this.bodies, at, this.bodyViews.buffer, at, 12);
  }

  /** Run whole substeps for dt seconds of time (the remainder carries over); returns how many. */
  step(dt) {
    this.pending += dt;
    const n = Math.floor(this.pending / this.h + 1e-9);
    this.pending -= n * this.h;
    if (n > 0) this.substeps(n);
    return n;
  }

  substeps(n) {
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    const run = ({ pipeline, bindGroup }, count) => {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.max(1, Math.ceil(count / 64)));
    };
    for (let s = 0; s < n; s++) {
      run(this.stages.predict, this.particleCount);
      for (let k = 0; k < this.iterations; k++) run(this.stages.solveDistance, this.bodyCount);
      run(this.stages.updateVelocity, this.particleCount);
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** The particles as they are now: [{ pos, vel }]. */
  async read() {
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.particles, 0, this.readBuf, 0, this.readBuf.size);
    this.device.queue.submit([enc.finish()]);
    await this.readBuf.mapAsync(GPUMapMode.READ);
    const views = viewsOf(this.readBuf.getMappedRange().slice(0));
    this.readBuf.unmap();
    return Array.from({ length: this.particleCount }, (_, i) => {
      const { pos, vel } = Particle.read(views, i);
      return { pos, vel };
    });
  }

  destroy() {
    for (const b of [this.particles, this.bodies, this.params, this.readBuf]) b.destroy();
  }
}
