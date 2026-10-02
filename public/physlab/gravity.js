// A scene's gravity, for physlab: which way things fall, and which way is up.
//
// From compileScene()'s `gravity` (parseGravity() in antisphere-scene.js):
// uniform - the same everywhere - or central, towards a point and falling
// off as 1 / r^2, as on a planet. Up is the opposite of gravity: against
// `down`, or away from the centre. The camera's object is kept upright by
// it (flight.js), and the simulation is given it (physics-world.js).

const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };

/** A Gravity from a parsed scene gravity ({ kind: 'uniform' | 'central', ... }). */
export function gravityOf(parsed) {
  return parsed.kind === 'central' ? new Central(parsed) : new Uniform(parsed);
}

class Uniform {
  constructor({ down, strength }) {
    this.kind = 'uniform';
    this.down = unit(down);
    this.strength = strength;
    this.accel = this.down.map((v) => v * strength);
  }

  /** The acceleration at p, m/s^2. */
  at() { return this.accel.slice(); }

  /** Which way is up at p: a unit vector. */
  up() { return this.down.map((v) => -v); }

  /** What PhysicsSim takes, in coordinates shifted by `origin`. */
  simParams() { return { gm: 0, gravityUniform: this.accel.slice() }; }
}

class Central {
  constructor({ center, gm }) {
    this.kind = 'central';
    this.center = center.slice();
    this.gm = gm;
  }

  at(p) {
    const r = this.center.map((v, i) => v - p[i]);
    const d2 = Math.max(r[0] * r[0] + r[1] * r[1] + r[2] * r[2], 1e-9);
    return r.map((v) => (this.gm * v) / (d2 * Math.sqrt(d2)));
  }

  up(p) {
    const away = p.map((v, i) => v - this.center[i]);
    return Math.hypot(...away) > 1e-9 ? unit(away) : [0, 0, 1];
  }

  simParams(origin) {
    return { gm: this.gm, gravityCentre: this.center.map((v, i) => v - origin[i]) };
  }
}
