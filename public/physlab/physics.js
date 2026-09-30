// physlab's physics, host side: what the compute passes in
// shaders/physics.wgsls work on, and (as it grows) running them.
//
// A solid is a compiled geometry subtree: its nodes, and its interior paths
// - each a conjunction of regions (node, sign), from interiorPaths() in
// overlap.js. Two solids touch where a path of one and a path of the other
// share a point; pathContact() in the shader finds it.

import { compileScene, packNodes } from '../antisphere-scene.js';
import { interiorPaths } from '../overlap.js';
import { Body, BodyContact, Particle, Path, Region, SimParams, Solid, viewsOf } from '../gen/layouts.js';

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
 * A body's solid must be coaxial with +Y: every node a surface of
 * revolution about the Y axis (its axis along Y, or no axis at all, and its
 * linear term along Y). Then placing it needs only an axis and an origin -
 * see placeCoaxial in the shader. Throws otherwise, naming the node.
 */
export function checkCoaxial(solid, what = 'body') {
  const tiny = (v, scale) => Math.abs(v) <= 1e-9 * Math.max(1, scale);
  solid.nodes.forEach((nd, i) => {
    if (i === 0) return;                      // node 0 is reserved, and empty
    const { axis, k_par, k_perp, linear } = nd.prim;
    const scale = Math.max(Math.abs(k_par), Math.abs(k_perp), Math.hypot(...linear));
    const axial = tiny(k_par - k_perp, scale) || (tiny(axis[0], 1) && tiny(axis[2], 1));
    if (!axial || !tiny(linear[0], scale) || !tiny(linear[2], scale)) {
      throw new Error(`${what}: node ${i} is not a surface of revolution about +Y, ` +
                      'which a two-particle body needs (its roll would matter)');
    }
  });
}

/**
 * Particles and bodies on the GPU, stepped in fixed substeps (XPBD; see
 * shaders/physics.wgsls), colliding with each other's solids and with
 * static ones. Coordinates are the simulation's own: callers keep them
 * near the origin (a floating origin), shifting in and out in f64, so f32
 * keeps its resolution.
 */
export class PhysicsSim {
  /**
   * @param {GPUDevice} device
   * @param {GPUShaderModule} module  gen/physics.wgsl
   * @param {object} setup
   * @param {{ pos, vel?, invMass, body }[]} setup.particles
   * @param {{ p0, p1, rest, compliance?, thrust?, solid?, a0?, a1?, radius?, friction? }[]} setup.bodies
   *   solid: a compileSolid() in the body's coordinates, coaxial with +Y;
   *   a0, a1: where p0 and p1 sit on its Y axis; radius: how far it
   *   reaches from its origin; friction: Coulomb coefficient
   * @param {object[]} [setup.statics]      compileSolid()s that collide but never move
   * @param {number[]} setup.gravityCentre  in simulation coordinates
   * @param {number} setup.gm               gravity is gm / r^2
   * @param {number} [setup.h]              substep, seconds
   * @param {number} [setup.iterations]     constraint rounds per substep
   */
  constructor(device, module, { particles, bodies, statics = [], gravityCentre, gm,
                                h = 1 / 240, iterations = 4 }) {
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
    // Solids: each body's own (every body its own copy, since each is
    // placed differently), then the statics, which the shader finds from
    // first_static on. A body with no solid gets an empty one.
    const EMPTY = { nodes: [], paths: [] };
    bodies.forEach((b, i) => { if (b.solid) checkCoaxial(b.solid, `body ${i}`); });
    const packed = packSolids([...bodies.map((b) => b.solid ?? EMPTY), ...statics]);
    const solidViews = Solid.allocate(Math.max(1, packed.ranges.length));
    packed.ranges.forEach((r, i) => Solid.write(solidViews, i, {
      first_path: r.firstPath, path_count: r.pathCount, first_node: r.firstNode, node_count: r.nodeCount,
    }));

    this.bodyViews = Body.allocate(Math.max(1, bodies.length));
    bodies.forEach((b, i) => Body.write(this.bodyViews, i, {
      p0: b.p0, p1: b.p1, rest: b.rest, compliance: b.compliance ?? 0, thrust: b.thrust ?? [0, 0, 0],
      solid: i, a0: b.a0 ?? 0, a1: b.a1 ?? b.rest, radius: b.radius ?? 1, friction: b.friction ?? 0.5,
    }));
    this.bodies = storage(this.bodyViews.buffer);
    const params = SimParams.allocate(1);
    SimParams.write(params, 0, {
      gravity_centre: gravityCentre, gm, h, particle_count: particles.length, body_count: bodies.length,
      first_static: bodies.length, static_count: statics.length,
    });
    this.params = device.createBuffer({ size: SimParams.SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.params, 0, params.buffer);
    this.readBuf = device.createBuffer({ size: pv.buffer.byteLength,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    // Buffers by their binding number in shaders/physics.wgsls. An 'auto'
    // layout holds only the bindings its entry point uses, so each stage
    // names the ones it binds.
    // Collisions: where each solid is, its nodes as given and as placed
    // (statics are placed already, and pose() only rewrites bodies'), the
    // contacts found each substep with their count, and the summed
    // corrections (x, y, z and how many, per particle).
    const nodes = new Uint8Array(Math.max(64, packed.nodes.byteLength));
    nodes.set(new Uint8Array(packed.nodes));
    this.contactCapacity = Math.max(64, bodies.length * (statics.length + bodies.length) * 8);
    this.contacts = device.createBuffer({ size: this.contactCapacity * BodyContact.STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.contactCount = device.createBuffer({ size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.collision = [
      storage(solidViews.buffer), storage(nodes), storage(nodes, GPUBufferUsage.COPY_SRC),
      storage(packed.regions), storage(packed.paths),
      device.createBuffer({ size: Math.max(16, particles.length * 16), usage: GPUBufferUsage.STORAGE }),
    ];
    const [solidBuf, localNodes, posedNodes, regionBuf, pathBuf, corrections] = this.collision;
    this.posedNodes = posedNodes;

    const buffers = {
      0: posedNodes, 1: regionBuf, 2: pathBuf,
      5: this.particles, 6: this.bodies, 7: this.params,
      8: solidBuf, 9: localNodes, 10: posedNodes, 11: this.contacts, 12: this.contactCount, 13: corrections,
    };
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
      pose: stage('pose', [5, 6, 7, 8, 9, 10]),
      clearContacts: stage('clearContacts', [12]),
      detect: stage('detect', [0, 1, 2, 5, 6, 7, 8, 11, 12]),
      solveContacts: stage('solveContacts', [5, 6, 11, 12, 13]),
      applyCorrections: stage('applyCorrections', [5, 7, 13]),
    };
    this.pairCount = bodies.length * statics.length;
    this.contactRounds = iterations;
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
      if (this.pairCount > 0) {
        run(this.stages.pose, this.bodyCount);
        run(this.stages.clearContacts, 1);
        run(this.stages.detect, this.pairCount);
        for (let k = 0; k < this.contactRounds; k++) {
          run(this.stages.solveContacts, this.contactCapacity);
          run(this.stages.applyCorrections, this.particleCount);
          run(this.stages.solveDistance, this.bodyCount);
        }
      }
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

  /** The contacts the last substep found: [{ point, depth, normal, body, other }]. */
  async readContacts() {
    const bytes = 16 + this.contactCapacity * BodyContact.STRIDE;
    const read = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.contactCount, 0, read, 0, 16);
    enc.copyBufferToBuffer(this.contacts, 0, read, 16, bytes - 16);
    this.device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const raw = read.getMappedRange().slice(0);
    read.destroy();
    const count = Math.min(new Uint32Array(raw, 0, 1)[0], this.contactCapacity);
    const views = viewsOf(raw.slice(16));
    return Array.from({ length: count }, (_, i) => BodyContact.read(views, i));
  }

  destroy() {
    for (const b of [this.particles, this.bodies, this.params, this.readBuf, this.contacts,
                     this.contactCount, ...this.collision]) b.destroy();
  }
}
