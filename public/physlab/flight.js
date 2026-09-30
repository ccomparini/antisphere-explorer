// Free flight for a camera's mount, kept upright with respect to the
// planet: the mount's +Z always points straight away from the origin, so
// the horizon stays level wherever it flies. It turns only about that
// vertical (heading); looking up and down is the camera's pitch, a head
// tilting on a level body.
//
// Kinematic for now: keys set a velocity, and letting go stops. No DOM
// here - flight-input.js turns keys and the mouse into calls on this.

import { fromBasis } from './quat.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };

// Short of straight up or down, where heading stops meaning anything.
const PITCH_LIMIT = 1.45;

/**
 * The upright orientation at `position` facing as near `heading` as the
 * level plane there allows: +Z straight away from the origin, +Y the
 * heading carried onto the level plane, +X = +Y cross +Z.
 */
export function levelOrientation(position, heading) {
  const z = unit(position);
  let y = heading.map((v, i) => v - dot(heading, z) * z[i]);
  if (Math.hypot(...y) < 1e-9) {
    // Heading straight up or down: any level direction will do.
    y = Math.abs(z[0]) < 0.9 ? cross(z, [1, 0, 0]) : cross(z, [0, 1, 0]);
  }
  y = unit(y);
  return fromBasis(cross(y, z), y, z);
}

export const ACTIONS = ['forward', 'back', 'left', 'right', 'up', 'down', 'fast'];

export class FlightControl {
  /**
   * @param {AttachedCamera} camera  its object is what flies; its pitch is the look
   * @param {object} [opts]
   * @param {number} [opts.speed]  meters per second
   * @param {number} [opts.boost]  speed multiplier while 'fast' is held
   */
  constructor(camera, { speed = 20, boost = 5 } = {}) {
    this.camera = camera;
    this.speed = speed;
    this.boost = boost;
    this.held = new Set();
    this.pendingYaw = 0;          // radians to turn right, gathered until the next update
  }

  press(action) { if (ACTIONS.includes(action)) this.held.add(action); }
  release(action) { this.held.delete(action); }
  releaseAll() { this.held.clear(); }

  /**
   * Turn by a look movement: `right` radians to the right (applied at the
   * next update), `up` radians up (at once, and clamped).
   */
  look(right, up) {
    this.pendingYaw += right;
    const p = this.camera.pitch + up;
    this.camera.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p));
  }

  /** Turn, move by dt seconds of the held keys' velocity, and level again. */
  update(dt) {
    const body = this.camera.object;
    let { x, y, z } = body.axes();

    // Heading turns about the vertical: turning right is clockwise seen
    // from above, i.e. negative about +Z.
    if (this.pendingYaw) {
      const c = Math.cos(this.pendingYaw), s = Math.sin(this.pendingYaw);
      y = [c * y[0] + s * x[0], c * y[1] + s * x[1], c * y[2] + s * x[2]];
      this.pendingYaw = 0;
    }
    const heading = y;

    const held = (a) => (this.held.has(a) ? 1 : 0);
    const along = held('forward') - held('back');
    const across = held('right') - held('left');
    const vertical = held('up') - held('down');
    if (along || across || vertical) {
      // Forward is where the camera looks, pitch and all: fly where you look.
      const c = Math.cos(this.camera.pitch), s = Math.sin(this.camera.pitch);
      const view = [c * y[0] + s * z[0], c * y[1] + s * z[1], c * y[2] + s * z[2]];
      const right = cross(y, z);
      const step = this.speed * (this.held.has('fast') ? this.boost : 1) * dt;
      const move = [0, 1, 2].map((i) => (along * view[i] + across * right[i] + vertical * z[i]) * step);
      body.setPosition(body.position.map((v, i) => v + move[i]));
    }
    body.orientation = levelOrientation(body.position, heading);
  }
}
