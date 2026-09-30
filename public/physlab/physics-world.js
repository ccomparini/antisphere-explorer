// A World's objects, simulated: the bridge between world.js and the GPU
// simulation in physics.js.
//
// Objects with a `body` become two-particle bodies; objects with geometry
// but no body are static colliders. The simulation runs in its own
// coordinates, shifted by `origin` (a floating origin near the action, so
// f32 keeps its resolution); positions come back a frame late, without
// waiting, and each body object's pose follows its particles. Bodies can
// be added as it runs (add()).

import { compileSolid, PhysicsSim } from './physics.js';
import { fromTo, multiply, normalize, rotate, toAxisAngle } from './quat.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const unit = (v) => scale(v, 1 / Math.hypot(...v));

export class PhysicsWorld {
  /**
   * @param {GPUDevice} device
   * @param {GPUShaderModule} module     gen/physics.wgsl
   * @param {World} world
   * @param {object} opts
   * @param {object} opts.materials       what the geometry names (solidity)
   * @param {number[]} opts.origin        world point the simulation is centred on
   * @param {{ from: WorldObject, gm: number }} opts.gravity  gm / r^2 towards `from`
   */
  constructor(device, module, world, { materials, origin, gravity }) {
    this.device = device;
    this.module = module;
    this.materials = materials;
    this.origin = origin.slice();
    this.gravity = gravity;
    this.solids = new Map();              // compiled solids, by geometry object
    this.bodies = [];
    this.placement = [];                  // per body: { a0, vel } until it is in a simulation
    for (const o of world.objects.filter((o) => o.body)) this._enlist(o, [0, 0, 0]);
    const place = (o) => {
      const { axis, radians } = toAxisAngle(o.orientation);
      return { ...(radians ? { rotate: { axis, radians } } : {}), translate: sub(o.position, this.origin) };
    };
    this.statics = world.objects.filter((o) => o.geometry && !o.body)
      .map((o) => compileSolid(o.geometry, materials, place(o)));
    this.sim = this._simulate([]);
    this.reading = null;
    this.latest = null;
    this.joining = [];                    // bodies added since the simulation was built
    this.rebuilding = null;
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
    this.placement.push({ a0: (b.centre ?? 0) - d / 2, d, vel });
  }

  _solidOf(geometry) {
    if (!this.solids.has(geometry)) this.solids.set(geometry, compileSolid(geometry, this.materials));
    return this.solids.get(geometry);
  }

  // A simulation of every body: those `from` has (its particles, as read)
  // carry on as they were; the rest start at their objects' poses.
  _simulate(from) {
    const particles = [], bodies = [];
    this.bodies.forEach((o, k) => {
      const b = o.body;
      const { a0, d, vel } = this.placement[k];
      const a1 = a0 + d;
      const u = rotate(o.orientation, [0, 1, 0]);
      const at = (y) => sub(add(o.position, scale(u, y)), this.origin);
      const inv = 2 / b.mass;
      if (2 * k + 1 < from.length) {
        particles.push({ ...from[2 * k], invMass: inv, body: k }, { ...from[2 * k + 1], invMass: inv, body: k });
      } else {
        particles.push({ pos: at(a0), vel, invMass: inv, body: k }, { pos: at(a1), vel, invMass: inv, body: k });
      }
      bodies.push({
        p0: 2 * k, p1: 2 * k + 1, rest: d, compliance: b.compliance ?? 0,
        solid: this._solidOf(o.geometry), a0, a1, radius: b.radius, friction: b.friction ?? 0.5,
      });
    });
    return new PhysicsSim(this.device, this.module, {
      particles, bodies, statics: this.statics,
      gravityCentre: sub(this.gravity.from.position, this.origin), gm: this.gravity.gm,
    });
  }

  // Read where everything has got to (after any read already on its way,
  // since they share a buffer), and carry on from there with the joiners.
  async _rebuild() {
    this.joining = [];
    if (this.reading) await this.reading;
    const qs = await this.sim.read();
    const old = this.sim;
    this._apply(qs);
    this.latest = null;
    this.sim = this._simulate(qs);
    old.destroy();
  }

  /** Whether an object is simulated here. */
  simulates(object) { return this.bodies.includes(object); }

  /** An extra acceleration on a body, in world axes (a motor), m/s^2. */
  setThrust(object, accel) {
    const k = this.bodies.indexOf(object);
    if (k >= 0) this.sim.setThrust(k, accel);
  }

  /**
   * Advance by dt seconds, and bring each body object to where its
   * particles were last read - a frame behind, since reading back waits for
   * the GPU and this doesn't. Returns how many substeps ran; with
   * `timestampWrites`, their pass is timed (see PhysicsSim.step).
   */
  update(dt, timestampWrites) {
    if (this.rebuilding) return 0;
    if (this.joining.length) {
      this.rebuilding = this._rebuild().finally(() => { this.rebuilding = null; });
      return 0;
    }
    const substeps = this.sim.step(dt, timestampWrites);
    if (this.latest) { this._apply(this.latest); this.latest = null; }
    if (!this.reading) {
      // A read can fail if the simulation is torn down under it; that one
      // is simply dropped.
      this.reading = this.sim.read().then((qs) => { this.latest = qs; }, () => {})
        .finally(() => { this.reading = null; });
    }
    return substeps;
  }

  // A body's pose from its particles: origin a0 back along the axis from
  // p0, and the old orientation turned the shortest way onto the new axis
  // (its roll doesn't show, and this keeps it from jumping).
  _apply(particles) {
    this.bodies.forEach((o, k) => {
      if (2 * k + 1 >= particles.length) return;           // not simulated yet
      const p0 = add(particles[2 * k].pos, this.origin);
      const p1 = add(particles[2 * k + 1].pos, this.origin);
      const u = unit(sub(p1, p0));
      o.setPosition(sub(p0, scale(u, this.placement[k].a0)));
      const was = rotate(o.orientation, [0, 1, 0]);
      o.orientation = normalize(multiply(fromTo(was, u), o.orientation));
    });
  }

  destroy() { this.sim.destroy(); }
}
