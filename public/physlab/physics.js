// physlab's physics, host side: what the compute passes in
// shaders/physics.wgsls work on, and (as it grows) running them.
//
// A solid is a compiled geometry subtree: its nodes, and its interior paths
// - each a conjunction of regions (node, sign), from interiorPaths() in
// overlap.js. Two solids touch where a path of one and a path of the other
// share a point; pathContact() in the shader finds it.

import { compileScene, packNodes } from '../antisphere-scene.js';
import { interiorPaths } from '../overlap.js';
import { Body, BodyContact, Particle, Path, PathPair, Region, SimParams, Solid, viewsOf } from '../gen/layouts.js';

/**
 * A geometry subtree (scene-format.md) as a solid: { nodes, paths }. With
 * `place` ({ rotate, translate }, as scene-format.md spells them), the
 * geometry is turned and moved first - how a static object's solid gets
 * into simulation coordinates.
 */
export function compileSolid(geometry, materials, place = null) {
  const spec = place
    ? { materials, lights: [], objects: { solid: geometry }, root: { use: 'solid', ...place } }
    : { materials, lights: [], root: geometry };
  const built = compileScene(spec);
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

// Compute pipelines by module and entry point: making them is the slow part
// of making a simulation, and physics-world.js makes a new one each time a
// body is added.
const pipelines = new WeakMap();
function pipelineOf(device, module, entryPoint) {
  if (!pipelines.has(module)) pipelines.set(module, new Map());
  const byEntry = pipelines.get(module);
  if (!byEntry.has(entryPoint)) {
    byEntry.set(entryPoint, device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } }));
  }
  return byEntry.get(entryPoint);
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
   * @param {{ p0, p1, rest, compliance?, thrust?, solid?, a0?, a1?, radius?, friction?, turn? }[]} setup.bodies
   *   solid: a compileSolid() in the body's coordinates, its axis +Y;
   *   a0, a1: where p0 and p1 sit on its Y axis; radius: how far it
   *   reaches from its origin; friction: Coulomb coefficient; turn: its
   *   orientation to start with, a quaternion [x, y, z, w] (identity by
   *   default). Two particles fix only the axis, so the shader carries
   *   the roll along, turning the shortest way as the axis moves (see
   *   pose()); a solid of revolution about +Y doesn't show it, anything
   *   else does.
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
    const turns = new Float32Array(4 * Math.max(1, bodies.length));
    bodies.forEach((b, i) => turns.set(b.turn ?? [0, 0, 0, 1], 4 * i));
    this.turns = storage(turns, GPUBufferUsage.COPY_SRC);
    // Read back together: the particles, then the turns.
    this.particleBytes = pv.buffer.byteLength;
    this.readBuf = device.createBuffer({ size: this.particleBytes + turns.byteLength,
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
    this.ranges = packed.ranges;
    this.staticCount = statics.length;
    this.paramViews = params;

    const buffers = {
      0: posedNodes, 1: regionBuf, 2: pathBuf,
      5: this.particles, 6: this.bodies, 7: this.params,
      8: solidBuf, 9: localNodes, 10: posedNodes, 11: this.contacts, 12: this.contactCount, 13: corrections,
      15: this.turns,
    };
    this.buffers = buffers;
    const stage = (entryPoint, bindings) => {
      const pipeline = pipelineOf(device, module, entryPoint);
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
      pose: stage('pose', [5, 6, 7, 8, 9, 10, 15]),
      clearContacts: stage('clearContacts', [12]),
      solveContacts: stage('solveContacts', [5, 6, 7, 11, 12, 13]),
      applyCorrections: stage('applyCorrections', [5, 7, 13]),
      solveContactVelocities: stage('solveContactVelocities', [5, 6, 7, 11, 12, 13]),
      applyVelocityCorrections: stage('applyVelocityCorrections', [5, 7, 13]),
    };
    this.stage = stage;
    this.collides = bodies.length > 0 && (statics.length > 0 || bodies.length > 1);
    this.contactRounds = iterations;
    // To start with, every body against every static and every other body.
    this.pairBuf = null;
    const everything = [];
    bodies.forEach((_, b) => {
      statics.forEach((_, k) => everything.push({ body: b, other: bodies.length + k }));
      for (let k = b + 1; k < bodies.length; k++) everything.push({ body: b, other: k });
    });
    this.setPairs(everything);
  }

  /**
   * Which pairs detect() tries: [{ body, other }], `other` another body's
   * index (not `body`) or bodyCount + a static's index. Each becomes every
   * path of the one against every path of the other, one a thread. The
   * rest can't touch; a broad phase (such as a group's
   * overlaps, see physics-world.js) says which those are.
   */
  setPairs(pairs) {
    const range = this.ranges;
    const pathsOf = (s) => Array.from({ length: range[s].pathCount }, (_, k) => range[s].firstPath + k);
    const list = [];
    for (const { body, other } of pairs) {
      for (const path_a of pathsOf(body)) for (const path_b of pathsOf(other)) list.push({ body, other, path_a, path_b });
    }
    // The buffer is only replaced when it must grow, and then with room to
    // spare; detect() reads pair_count, not its length.
    if (!this.pairBuf || this.pairBuf.size < list.length * PathPair.STRIDE) {
      this.pairBuf?.destroy();
      this.pairBuf = this.device.createBuffer({ size: Math.max(64, 2 * list.length) * PathPair.STRIDE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.buffers[14] = this.pairBuf;
      this.stages.detect = this.stage('detect', [0, 1, 2, 5, 6, 7, 11, 12, 14]);
    }
    if (list.length) {
      const views = PathPair.allocate(list.length);
      list.forEach((q, i) => PathPair.write(views, i, q));
      this.device.queue.writeBuffer(this.pairBuf, 0, views.buffer);
    }
    this.pairCount = list.length;
    SimParams.write(this.paramViews, 0, { pair_count: list.length });
    const at = SimParams.FIELDS.pair_count.offset;
    this.device.queue.writeBuffer(this.params, at, this.paramViews.buffer, at, 4);
  }

  /** Set a body's extra acceleration (world axes of the simulation), m/s^2. */
  setThrust(body, thrust) {
    Body.write(this.bodyViews, body, { thrust });
    const at = body * Body.STRIDE + Body.FIELDS.thrust.offset;
    this.device.queue.writeBuffer(this.bodies, at, this.bodyViews.buffer, at, 12);   // vec3<f32>: 12 bytes
  }

  /**
   * Run whole substeps for dt seconds of time (the remainder carries over);
   * returns how many. `timestampWrites`, if given, times the pass they run
   * in (only written when there is at least one).
   */
  step(dt, timestampWrites) {
    this.pending += dt;
    const n = Math.floor(this.pending / this.h + 1e-9);
    this.pending -= n * this.h;
    if (n > 0) this.substeps(n, timestampWrites);
    return n;
  }

  substeps(n, timestampWrites) {
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass(timestampWrites ? { timestampWrites } : {});
    const run = ({ pipeline, bindGroup }, count) => {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.max(1, Math.ceil(count / 64)));
    };
    for (let s = 0; s < n; s++) {
      run(this.stages.predict, this.particleCount);
      for (let k = 0; k < this.iterations; k++) run(this.stages.solveDistance, this.bodyCount);
      if (this.collides) {
        run(this.stages.pose, this.bodyCount);
        run(this.stages.clearContacts, 1);
        if (this.pairCount > 0) run(this.stages.detect, this.pairCount);
        for (let k = 0; k < this.contactRounds; k++) {
          run(this.stages.solveContacts, this.contactCapacity);
          run(this.stages.applyCorrections, this.particleCount);
          run(this.stages.solveDistance, this.bodyCount);
        }
      }
      run(this.stages.updateVelocity, this.particleCount);
      if (this.collides) {
        for (let k = 0; k < this.contactRounds; k++) {
          run(this.stages.solveContactVelocities, this.contactCapacity);
          run(this.stages.applyVelocityCorrections, this.particleCount);
        }
      }
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** The particles as they are now: [{ pos, vel }]. */
  async read() { return (await this.readState()).particles; }

  /**
   * The particles, [{ pos, vel }], and each body's orientation as the last
   * pose() left it, [[x, y, z, w]].
   */
  async readState() {
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.particles, 0, this.readBuf, 0, this.particleBytes);
    enc.copyBufferToBuffer(this.turns, 0, this.readBuf, this.particleBytes, this.readBuf.size - this.particleBytes);
    this.device.queue.submit([enc.finish()]);
    await this.readBuf.mapAsync(GPUMapMode.READ);
    const raw = this.readBuf.getMappedRange().slice(0);
    this.readBuf.unmap();
    const views = viewsOf(raw.slice(0, this.particleBytes));
    const particles = Array.from({ length: this.particleCount }, (_, i) => {
      const { pos, vel } = Particle.read(views, i);
      return { pos, vel };
    });
    const t = new Float32Array(raw, this.particleBytes);
    const turns = Array.from({ length: this.bodyCount }, (_, i) => Array.from(t.subarray(4 * i, 4 * i + 4)));
    return { particles, turns };
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
    for (const b of [this.particles, this.bodies, this.turns, this.params, this.readBuf, this.contacts,
                     this.contactCount, this.pairBuf, ...this.collision]) b.destroy();
  }
}
