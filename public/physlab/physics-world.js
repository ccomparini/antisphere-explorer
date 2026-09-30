// A World's objects, simulated: the bridge between world.js and the GPU
// simulation in physics.js.
//
// Objects with a `body` become two-particle bodies; objects with geometry
// but no body are static colliders. The simulation runs in its own
// coordinates, shifted by `origin` (a floating origin near the action, so
// f32 keeps its resolution); positions come back a frame late, without
// waiting, and each body object's pose follows its particles.

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
    this.origin = origin.slice();
    this.bodies = world.objects.filter((o) => o.body);
    const statics = world.objects.filter((o) => o.geometry && !o.body);
    const particles = [], bodies = [];
    this.placement = [];
    this.bodies.forEach((o, k) => {
      const b = o.body;
      const d = 2 * Math.sqrt(b.inertia);          // two half-masses: 2 (m/2) (d/2)^2 = I
      const u = rotate(o.orientation, [0, 1, 0]);
      const at = (y) => sub(add(o.position, scale(u, y)), this.origin);
      const a0 = (b.centre ?? 0) - d / 2, a1 = (b.centre ?? 0) + d / 2;
      particles.push({ pos: at(a0), invMass: 2 / b.mass, body: k }, { pos: at(a1), invMass: 2 / b.mass, body: k });
      bodies.push({
        p0: 2 * k, p1: 2 * k + 1, rest: d, compliance: b.compliance ?? 0,
        solid: compileSolid(o.geometry, materials), a0, a1, radius: b.radius, friction: b.friction ?? 0.5,
      });
      this.placement.push({ a0 });
    });
    const place = (o) => {
      const { axis, radians } = toAxisAngle(o.orientation);
      return { ...(radians ? { rotate: { axis, radians } } : {}), translate: sub(o.position, this.origin) };
    };
    this.sim = new PhysicsSim(device, module, {
      particles, bodies,
      statics: statics.map((o) => compileSolid(o.geometry, materials, place(o))),
      gravityCentre: sub(gravity.from.position, this.origin), gm: gravity.gm,
    });
    this.reading = null;
    this.latest = null;
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
