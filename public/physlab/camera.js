// A camera riding on a WorldObject.
//
// The renderer asks a camera only for basis() - eye, forward, right, up -
// plus fovY and projection, so this stands in for ASCamera without the
// renderer knowing the difference. The object's axes follow the world's
// Z-up habit: +Y is forward, +Z up and +X right, which is also how the
// renderer builds right and up from forward.
//
// Two modes:
//   'forward'  look along the object's +Y, with its +Z as up, tilted by
//              `pitch` radians about the object's +X (positive looks up):
//              a head on a body, so the object itself can stay level
//   'lookAt'   look from the object at `target`, a point held by reference:
//              give it another object's position array and the camera
//              follows that object as it moves. With no target it looks
//              forward instead.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(...v); return l ? v.map((x) => x / l) : v; };

export const CAMERA_MODES = ['forward', 'lookAt'];

export class AttachedCamera {
  /**
   * @param {WorldObject} object  what the camera rides on
   * @param {object} [opts]
   * @param {string} [opts.mode]       'forward' (default) or 'lookAt'
   * @param {number[]} [opts.target]   the point 'lookAt' looks at, kept by reference
   * @param {number} [opts.fovY]       vertical field of view, radians
   * @param {number} [opts.pitch]      'forward' only: radians up (+) or down (-)
   */
  constructor(object, { mode = 'forward', target = null, fovY = 0.9, pitch = 0 } = {}) {
    this.object = object;
    this.mode = mode;
    this.target = target;
    this.fovY = fovY;
    this.pitch = pitch;
    this.projection = 'perspective';
  }

  set mode(m) {
    if (!CAMERA_MODES.includes(m)) throw new Error(`camera mode "${m}": not one of ${CAMERA_MODES.join(', ')}`);
    this._mode = m;
  }
  get mode() { return this._mode; }

  basis() {
    const eye = this.object.position.slice();
    const { x, y, z } = this.object.axes();
    if (this.mode === 'forward' || !this.target) {
      const c = Math.cos(this.pitch), s = Math.sin(this.pitch);
      return {
        eye,
        forward: [c * y[0] + s * z[0], c * y[1] + s * z[1], c * y[2] + s * z[2]],
        right: x,
        up: [c * z[0] - s * y[0], c * z[1] - s * y[1], c * z[2] - s * y[2]],
      };
    }
    const forward = unit(sub(this.target, eye));
    // Up is the object's +Z, as near as it can be while square to the line
    // of sight. Looking straight along +Z or -Z leaves nothing to square it
    // with; then the object's +Y serves, so looking straight down puts
    // what the object faces at the top of the picture.
    let right = cross(forward, z);
    if (Math.hypot(...right) < 1e-6) right = cross(forward, y);
    right = unit(right);
    return { eye, forward, right, up: cross(right, forward) };
  }

  // What ASRenderer asks an orthographic camera; this one is perspective,
  // but answering keeps the two interchangeable.
  halfHeight() { return Math.tan(0.5 * this.fovY); }
}
