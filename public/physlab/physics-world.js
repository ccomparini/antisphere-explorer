// A World's objects, simulated: the bridge between world.js and the GPU
// simulation in physics.js.
//
// Objects with a `body` become two-particle bodies; objects with geometry
// but no body are static colliders. The simulation runs in its own
// coordinates, shifted by `origin` (a floating origin near the action, so
// f32 keeps its resolution); positions come back a frame late, without
// waiting, and each body object's pose follows its particles. Bodies can
// be added as it runs (add()).
//
// Which pairs are tested for contact can come from a broad phase: give
// each body's bounds (boundsOf()) to a group in the scene,
// and its overlaps back to setCandidates(). Until then, every pair is.
//
// An object whose geometry changes (WorldObject.setGeometry) is passed to
// reshape(). Where its tree keeps its shape - a sphere grown, say - only
// its nodes' coefficients change, and they are written in place (DESIGN.md,
// "Moving objects"); otherwise the simulation is rebuilt, as for add().

import { compileSolid, PhysicsSim } from './physics.js';
import { fromTo, multiply, normalize, rotate, toAxisAngle } from './quat.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const unit = (v) => scale(v, 1 / Math.hypot(...v));

/**
 * Whether two compiled solids are the same tree with (maybe) different
 * coefficients: the same nodes, children, materials and paths, so one can
 * be written over the other in place.
 */
export function sameShape(a, b) {
  if (a.nodes.length !== b.nodes.length || a.paths.length !== b.paths.length) return false;
  const same = (x, y) => x.inside === y.inside && x.outside === y.outside &&
                         x.material === y.material && x.env === y.env;
  return a.nodes.every((n, i) => same(n, b.nodes[i])) &&
         JSON.stringify(a.paths) === JSON.stringify(b.paths);
}

export class PhysicsWorld {
  /**
   * @param {GPUDevice} device
   * @param {GPUShaderModule} module     gen/physics-2pt.wgsl
   * @param {World} world
   * @param {object} opts
   * @param {object} opts.materials       what the geometry names (solidity)
   * @param {object} [opts.objects]       named subtrees the geometry may use
   * @param {number[]} opts.origin        world point the simulation is centred on
   * @param {object} opts.gravity       the scene's (gravity.js's gravityOf())
   * @param {number} [opts.lookahead]     seconds a body's bounds must cover its
   *   motion for (boundsOf): from the positions they're made from, a frame or
   *   two old, until the pairs they give are next replaced
   */
  constructor(device, module, world, { materials, objects = {}, origin, gravity, lookahead = 0.3 }) {
    this.device = device;
    this.module = module;
    this.materials = materials;
    this.objects = objects;
    this.origin = origin.slice();
    this.gravity = gravity;
    this.solids = new WeakMap();          // compiled solids, by geometry object
    this.bodies = [];
    this.lookahead = lookahead;
    this.placement = [];                  // per body: { a0, d, vel (until simulated), thrust, speed }
    for (const o of world.objects.filter((o) => o.body)) this._enlist(o, [0, 0, 0]);
    this.staticObjects = world.objects.filter((o) => o.geometry && !o.body);
    this.statics = this.staticObjects.map((o) => this._staticSolid(o));
    this.candidates = null;               // [[object, object]] from setCandidates, or every pair
    this.sim = this._simulate();
    this.reading = null;
    this.latest = null;
    this.joining = [];                    // bodies added since the simulation was built
    this.reshaped = new Set();            // objects whose geometry changed since
    this.rebuilding = null;
  }

  // A static object's solid, placed in simulation coordinates.
  _staticSolid(o) {
    const { axis, radians } = toAxisAngle(o.orientation);
    const place = { ...(radians ? { rotate: { axis, radians } } : {}), translate: sub(o.position, this.origin) };
    return compileSolid(o.geometry, this.materials, place, this.objects);
  }

  /**
   * Take up an object's new geometry (after WorldObject.setGeometry): at
   * the next update(), in place where the tree keeps its shape, else by a
   * rebuild. Objects this doesn't simulate are ignored.
   */
  reshape(object) {
    if (this.simulates(object) || this.staticObjects.includes(object)) this.reshaped.add(object);
  }

  // The reshaped objects' new solids, written over their old ones where
  // they can be; true if any can't, and the simulation must be rebuilt.
  _reshape() {
    let rebuild = false;
    for (const o of this.reshaped) {
      const s = this.staticObjects.indexOf(o);
      const solid = s >= 0 ? this._staticSolid(o) : this._solidOf(o.geometry);
      const index = s >= 0 ? this.sim.bodyCount + s : this.bodies.indexOf(o);
      if (s >= 0) this.statics[s] = solid;
      if (s < 0 && index >= this.sim.bodyCount) continue;   // not simulated yet: joins with it
      if (sameShape(this.simSolids[index], solid)) {
        this.sim.setNodes(index, solid.nodes);
        this.simSolids[index] = solid;
      } else {
        rebuild = true;
      }
    }
    this.reshaped.clear();
    return rebuild;
  }

  /**
   * Add a body object (already in the world) moving at `velocity`, world
   * axes, m/s. The simulation has fixed buffers, so this rebuilds it with
   * everything where it has got to, which takes a frame or two, during
   * which time stands still for the bodies (update() runs no substeps).
   */
  add(object, velocity = [0, 0, 0]) {
    this._enlist(object, velocity);
    this.joining.push(object);
  }

  _enlist(o, vel) {
    const b = o.body;
    const d = 2 * Math.sqrt(b.inertia);          // two half-masses: 2 (m/2) (d/2)^2 = I
    this.bodies.push(o);
    this.placement.push({ a0: (b.centre ?? 0) - d / 2, d, vel, thrust: [0, 0, 0], speed: Math.hypot(...vel) });
  }

  _solidOf(geometry) {
    if (!this.solids.has(geometry)) this.solids.set(geometry, compileSolid(geometry, this.materials, null, this.objects));
    return this.solids.get(geometry);
  }

  // A simulation of every body: those `from` has (a readState(): their
  // particles and orientations) carry on as they were; the rest start at
  // their objects' poses.
  _simulate(from = { particles: [], turns: [] }) {
    const particles = [], bodies = [];
    this.bodies.forEach((o, k) => {
      const b = o.body;
      const { a0, d, vel, thrust } = this.placement[k];
      const a1 = a0 + d;
      const u = rotate(o.orientation, [0, 1, 0]);
      const at = (y) => sub(add(o.position, scale(u, y)), this.origin);
      const inv = 2 / b.mass;
      const carried = k < from.turns.length;
      if (carried) {
        const q = from.particles;
        particles.push({ ...q[2 * k], invMass: inv, body: k }, { ...q[2 * k + 1], invMass: inv, body: k });
      } else {
        particles.push({ pos: at(a0), vel, invMass: inv, body: k }, { pos: at(a1), vel, invMass: inv, body: k });
      }
      bodies.push({
        p0: 2 * k, p1: 2 * k + 1, rest: d, compliance: b.compliance ?? 0, thrust,
        solid: this._solidOf(o.geometry), a0, a1, radius: b.radius, friction: b.friction ?? 0.5,
        turn: carried ? from.turns[k] : o.orientation,
      });
    });
    // What each solid in the simulation is, bodies' then statics', as
    // _reshape() compares against.
    this.simSolids = [...bodies.map((b) => b.solid), ...this.statics];
    return new PhysicsSim(this.device, this.module, {
      particles, bodies, statics: this.statics,
      ...this.gravity.simParams(this.origin),
    });
  }

  // Read where everything has got to (after any read already on its way,
  // since they share a buffer), and carry on from there with the joiners.
  async _rebuild() {
    this.joining = [];
    if (this.reading) await this.reading;
    const state = await this.sim.readState();
    // Whatever has been reshaped by now is compiled afresh just below;
    // anything reshaped after, the next update() takes up.
    for (const o of this.reshaped) {
      const s = this.staticObjects.indexOf(o);
      if (s >= 0) this.statics[s] = this._staticSolid(o);
    }
    this.reshaped.clear();
    const old = this.sim;
    this._apply(state);
    this.latest = null;
    this.sim = this._simulate(state);
    old.destroy();
    this._useCandidates();
  }

  /**
   * A body's bounds for a broad phase, in world coordinates: a ball about
   * its origin reaching past its geometry (body.radius) by as far as it
   * could move in `lookahead` seconds at its last known speed and under
   * gravity and its thrust. Null for anything not simulated here, whose
   * geometry bounds itself or doesn't move.
   */
  boundsOf(object) {
    const k = this.bodies.indexOf(object);
    if (k < 0) return null;
    const { speed, thrust } = this.placement[k];
    const accel = Math.hypot(...this.gravity.at(object.position)) + Math.hypot(...thrust);
    const t = this.lookahead;
    return { center: object.position.slice(), radius: object.body.radius + speed * t + 0.5 * accel * t * t + 0.05 };
  }

  /**
   * The pairs of objects that may touch - from a broad phase, such as an
   * group's overlaps - and so the only ones tested for contact
   * until the next call. Pairs of two static objects, and objects this
   * doesn't know, are ignored.
   */
  setCandidates(pairs) {
    this.candidates = pairs;
    this._useCandidates();
  }

  // The candidates in the simulation's numbering: a body by its index
  // (only if it has joined), a static by bodyCount + its index.
  _useCandidates() {
    if (!this.candidates) return;
    const n = this.sim.bodyCount;
    const id = (o) => {
      const k = this.bodies.indexOf(o);
      if (k >= 0) return k < n ? k : -1;
      const s = this.staticObjects.indexOf(o);
      return s >= 0 ? n + s : -1;
    };
    const pairs = [];
    for (const [a, b] of this.candidates) {
      let i = id(a), j = id(b);
      if (i < 0 || j < 0) continue;
      if (i >= n) [i, j] = [j, i];           // the body first
      if (i >= n) continue;                  // two statics
      pairs.push({ body: i, other: j });
    }
    this.sim.setPairs(pairs);
  }

  /** Path pairs tested for contact each substep. */
  get pairCount() { return this.sim.pairCount; }

  /** Whether an object is simulated here. */
  simulates(object) { return this.bodies.includes(object); }

  /** An extra acceleration on a body, in world axes (a motor), m/s^2. */
  // Kept here as well, so that a rebuild carries it over, and so a body
  // added but not yet in the simulation (add()) can have one: its thrust
  // goes in when it does, rather than past the end of the old simulation's
  // buffers.
  setThrust(object, accel) {
    const k = this.bodies.indexOf(object);
    if (k < 0) return;
    this.placement[k].thrust = accel.slice();
    if (k < this.sim.bodyCount) this.sim.setThrust(k, accel);
  }

  /**
   * Advance by dt seconds, and bring each body object to where its
   * particles were last read - a frame behind, since reading back waits for
   * the GPU and this doesn't. Returns how many substeps ran; with
   * `timestampWrites`, their pass is timed (see PhysicsSim.step).
   */
  update(dt, timestampWrites) {
    if (this.rebuilding) return 0;
    if (this.joining.length || (this.reshaped.size && this._reshape())) {
      this.rebuilding = this._rebuild().finally(() => { this.rebuilding = null; });
      return 0;
    }
    const substeps = this.sim.step(dt, timestampWrites);
    if (this.latest) { this._apply(this.latest); this.latest = null; }
    if (!this.reading) {
      // A read can fail if the simulation is torn down under it; that one
      // is simply dropped.
      this.reading = this.sim.readState().then((state) => { this.latest = state; }, () => {})
        .finally(() => { this.reading = null; });
    }
    return substeps;
  }

  // A body's pose from a readState(): origin a0 back along the axis from
  // p0, and the orientation the simulation carries (the roll it keeps)
  // turned the shortest way onto the particles' axis - as the next pose()
  // will, since the particles have moved on a little since the last one.
  _apply({ particles, turns }) {
    this.bodies.forEach((o, k) => {
      if (k >= turns.length) return;                       // not simulated yet
      this.placement[k].speed = Math.max(Math.hypot(...particles[2 * k].vel), Math.hypot(...particles[2 * k + 1].vel));
      const p0 = add(particles[2 * k].pos, this.origin);
      const p1 = add(particles[2 * k + 1].pos, this.origin);
      const u = unit(sub(p1, p0));
      o.setPosition(sub(p0, scale(u, this.placement[k].a0)));
      const q = normalize(turns[k]);
      o.orientation = normalize(multiply(fromTo(rotate(q, [0, 1, 0]), u), q));
    });
  }

  destroy() { this.sim.destroy(); }
}
