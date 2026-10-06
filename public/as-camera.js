// Camera state and the input bindings that drive it.
//
// A camera is plain state plus the maths to turn it into a basis. It holds no
// GPU resources and knows nothing about a renderer, so an editor can point
// several cameras at one scene, drive one from a UI and another from the
// mouse, or animate one with no renderer attached at all.
//
// Coordinates are right-handed with +z up, matching the scene format.

export const CAMERA_MODES = ['orbit', 'free', 'walk'];

const PITCH_LIMIT = 1.35;   // how far up or down rotateBy() turns, short of vertical

const unit = (v) => {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 0)) throw new Error(`camera direction [${v}] has no length`);
  return [v[0] / len, v[1] / len, v[2] / len];
};

/**
 * The direction an old scene file's yaw and pitch meant: yaw turning
 * about +Z from looking along -Y, pitch tilting down. Only for reading
 * those files (setFromSpec()); the camera itself keeps a direction.
 */
function yawPitchDirection(yaw, pitch) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return [-cp * Math.sin(yaw), -cp * Math.cos(yaw), -sp];
}

/**
 * Where the camera is and which way it looks: `position`, `direction`
 * (unit), and `distance`, how far along the direction the point it orbits
 * is (focus()). One set of state for every mode - orbit turns about the
 * focus, free and walk turn where they stand - so changing mode never
 * moves the view.
 */
export class ASCamera {
  constructor(opts = {}) {
    this.mode = opts.mode ?? 'orbit';
    // By default, the view it always had: from up and to one side, onto a
    // point just above the origin.
    this.direction = unit(opts.direction ?? yawPitchDirection(0.55, 0.30));
    this.distance = opts.distance ?? 6.4;
    if (opts.position) this.position = opts.position.slice();
    else this.aim({ focus: opts.focus ?? [0, 0, 0.15] });
    this.minDistance = opts.minDistance ?? 0.05;
    this.maxDistance = opts.maxDistance ?? 200;

    this.fovY = opts.fovY ?? 0.9;      // radians

    // Perspective or orthographic. A ray caster has no projection matrix, so
    // this only decides how the renderer lays out the rays; the position,
    // direction and modes above are the same either way.
    this.projection = opts.projection ?? 'perspective';
    // Half the visible height in world units, for orthographic views. Null
    // means "match the perspective framing", which keeps whatever sits at
    // the focus the same size across a switch.
    this.orthoHeight = opts.orthoHeight ?? null;
    this.fallVelocity = 0;             // walk mode only
  }

  /** The point orbit mode turns about: `distance` along the direction. */
  focus() {
    const { position: p, direction: d, distance: r } = this;
    return [p[0] + r * d[0], p[1] + r * d[1], p[2] + r * d[2]];
  }

  /**
   * Look along `direction` at `focus`, from `distance` back - the camera
   * placed by what it looks at. Any of the three may be left out, and keeps
   * what it was.
   */
  aim({ focus = this.focus(), direction = this.direction, distance = this.distance } = {}) {
    this.direction = unit(direction);
    this.distance = distance;
    this.position = focus.map((f, i) => f - distance * this.direction[i]);
  }

  /**
   * Half the visible height, in world units, for an orthographic view.
   * Derived from the field of view and the focus distance unless set, so
   * toggling projection leaves the framing at the focus alone.
   */
  halfHeight() {
    if (this.orthoHeight !== null) return this.orthoHeight;
    return Math.tan(0.5 * this.fovY) * this.distance;
  }

  /** Eye position and orientation: { eye, forward, right, up }. */
  basis() {
    return withFrame(this.position, this.direction);
  }

  /** Change mode. Every mode shares the camera's state, so nothing moves. */
  setMode(mode) {
    if (mode === this.mode || !CAMERA_MODES.includes(mode)) return;
    if (mode === 'walk') this.fallVelocity = 0;
    this.mode = mode;
  }

  /**
   * Turn, in radians: `dyaw` about +Z (positive turns right), `dpitch`
   * about the camera's right (positive tilts down), stopping short of
   * straight up or down. In orbit mode about the focus, which stays put;
   * otherwise where the camera stands.
   */
  rotateBy(dyaw, dpitch) {
    const focus = this.focus();
    const [x, y, z] = this.direction;
    const yaw = Math.atan2(-x, -y) + dyaw;
    const pitch = clamp(Math.asin(clamp(-z, -1, 1)) + dpitch, -PITCH_LIMIT, PITCH_LIMIT);
    const direction = yawPitchDirection(yaw, pitch);
    if (this.mode === 'orbit') this.aim({ focus, direction });
    else this.direction = direction;
  }

  /** Orbit only: multiply the distance to the focus, which stays put. */
  dolly(factor) {
    this.aim({ distance: clamp(this.distance * factor, this.minDistance, this.maxDistance) });
  }

  /**
   * Free/walk only: move along the view direction. In walk mode the direction
   * is flattened to the ground plane, so looking up or down doesn't change how
   * fast, or which way, you travel.
   */
  moveBy(distance) {
    if (this.mode === 'orbit') return;
    let dir = this.direction;
    if (this.mode === 'walk') {
      const len = Math.hypot(dir[0], dir[1]) || 1;
      dir = [dir[0] / len, dir[1] / len, 0];
    }
    for (let i = 0; i < 3; i++) this.position[i] += dir[i] * distance;
  }

  /**
   * Adopt a viewpoint from a scene file's optional `camera` block:
   * { position, direction, distance }, as toSpec() writes. Older files
   * said { target, yaw, pitch, distance } - what it looked at, and from
   * where round it - which is read too.
   */
  setFromSpec(spec) {
    if (!spec) return;
    if (spec.distance !== undefined) this.distance = spec.distance;
    if (spec.direction) this.direction = unit(spec.direction);
    if (spec.position) {
      this.position = spec.position.slice();
    } else if (spec.target || spec.yaw !== undefined || spec.pitch !== undefined) {
      const [x, y, z] = this.direction;
      this.aim({
        focus: spec.target ?? this.focus(),
        direction: yawPitchDirection(spec.yaw ?? Math.atan2(-x, -y), spec.pitch ?? Math.asin(clamp(-z, -1, 1))),
      });
    }
    if (spec.mode) this.setMode(spec.mode);
    if (spec.projection) this.projection = spec.projection;
    if (spec.orthoHeight !== undefined) this.orthoHeight = spec.orthoHeight;
  }

  /** A plain object suitable for a scene file's `camera` block. */
  toSpec() {
    const spec = {
      position: this.position.slice(),
      direction: this.direction.slice(),
      distance: this.distance,
    };
    // Only when it isn't the default, so an ordinary scene file stays plain.
    if (this.projection !== 'perspective') spec.projection = this.projection;
    if (this.orthoHeight !== null) spec.orthoHeight = this.orthoHeight;
    return spec;
  }
}

// Right is level - square to +Z - so the horizon stays level. Looking
// straight up or down there is no such direction; then right is -X, which
// is what looking down from just short of vertical, facing -Y, gives.
function withFrame(eye, forward) {
  let right = [forward[1], -forward[0], 0];        // cross(forward, +Z)
  const len = Math.hypot(right[0], right[1]);
  right = len > 1e-9 ? [right[0] / len, right[1] / len, 0] : [-1, 0, 0];
  const up = [                                     // cross(right, forward)
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];
  return { eye, forward, right, up };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

const MOVE_SPEED = 4;      // world units/sec in free and walk modes
const GRAVITY = 9.8;       // world units/sec^2, walk mode only
const EYE_HEIGHT = 1.6;    // walk mode's minimum height above the ground

/**
 * Bind mouse and keyboard input on one canvas to one camera.
 *
 * Kept apart from ASRenderer so an editor can give different panes different
 * controls, or none: a locked orthographic-ish reference view is just a view
 * with no controls attached.
 *
 * `probe(origin, direction)` is optional and only used by walk mode. It should
 * return a promise resolving to a hit distance, or a negative number for a
 * miss — ASScene.traceRay fits directly. Without it, walk mode behaves as free
 * mode with no gravity.
 *
 * Returns a handle with `update(dt)`, which the frame loop must call for
 * held-key movement and gravity, and `detach()`.
 */
export function attachCameraControls(canvas, camera, opts = {}) {
  const probe = opts.probe ?? null;
  const onNote = opts.onNote ?? (() => {});
  const enabled = opts.enabled ?? (() => true);

  let dragging = false, lastX = 0, lastY = 0;
  let moveFwd = false, moveBack = false;
  let groundZ = -Infinity, probePending = false, probeEye = null;

  const wantsLock = () => camera.mode !== 'orbit';
  const locked = () => document.pointerLockElement === canvas;

  function requestLook() {
    try {
      const p = canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => onNote('click the canvas to enable mouselook', true));
    } catch {
      onNote('click the canvas to enable mouselook', true);
    }
  }
  function releaseLook() {
    if (locked()) document.exitPointerLock();
  }

  const on = [];
  const listen = (target, type, fn, opt) => {
    target.addEventListener(type, fn, opt);
    on.push(() => target.removeEventListener(type, fn, opt));
  };

  listen(canvas, 'pointerdown', (e) => {
    if (!enabled()) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  listen(canvas, 'pointerup', () => { dragging = false; });
  listen(canvas, 'pointercancel', () => { dragging = false; });
  listen(canvas, 'pointermove', (e) => {
    if (!dragging || !enabled() || camera.mode !== 'orbit') return;
    camera.rotateBy((e.clientX - lastX) * 0.006, (e.clientY - lastY) * 0.005);
    lastX = e.clientX; lastY = e.clientY;
  });
  listen(canvas, 'wheel', (e) => {
    e.preventDefault();
    if (!enabled() || camera.mode !== 'orbit') return;   // free/walk move with keys
    camera.dolly(Math.exp(e.deltaY * 0.001));
  }, { passive: false });

  // Free/walk mouselook: the mouse rotates the view without a button held,
  // once the pointer is locked to the canvas. movementX/Y are only meaningful
  // while locked.
  listen(window, 'mousemove', (e) => {
    if (!enabled() || camera.mode === 'orbit' || !locked()) return;
    camera.rotateBy(e.movementX * 0.006, e.movementY * 0.005);
  });

  // Pointer lock needs a user gesture. Entering a look mode from a keypress
  // usually grants it; a click on the canvas recovers it if that was refused.
  listen(canvas, 'click', () => {
    if (enabled() && wantsLock() && !locked()) requestLook();
  });
  listen(document, 'pointerlockerror', () => {
    onNote('pointer lock failed — click the canvas', true);
  });
  // Browsers force-release the lock on Escape; treat that as the user asking
  // to leave the look mode.
  listen(document, 'pointerlockchange', () => {
    if (!locked() && wantsLock()) {
      camera.setMode('orbit');
      onNote('mouselook released — back to orbit');
    }
  });

  listen(window, 'keydown', (e) => {
    if (!enabled()) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (e.key === 'ArrowUp') moveFwd = true; else moveBack = true;
    }
  });
  listen(window, 'keyup', (e) => {
    if (e.key === 'ArrowUp') moveFwd = false;
    if (e.key === 'ArrowDown') moveBack = false;
  });

  // One probe in flight at a time. groundZ holds whichever answer arrived most
  // recently, which lags the camera by a frame or so rather than blocking the
  // render loop on a readback.
  function requestGround() {
    if (!probe || probePending) return;
    probePending = true;
    probeEye = camera.position.slice();
    probe(probeEye, [0, 0, -1])
      .then((t) => { groundZ = t >= 0 ? probeEye[2] - t : -Infinity; })
      .catch(() => {})
      .finally(() => { probePending = false; });
  }

  // Above the minimum height, gravity accelerates the descent; at or below it,
  // stand exactly on the ground with no velocity.
  function updateWalk(dt) {
    requestGround();
    const minZ = groundZ + EYE_HEIGHT;      // -Infinity stays -Infinity
    if (camera.position[2] > minZ) {
      camera.fallVelocity += GRAVITY * dt;
      camera.position[2] -= camera.fallVelocity * dt;
      if (camera.position[2] < minZ) {
        camera.position[2] = minZ;
        camera.fallVelocity = 0;
      }
    } else {
      camera.position[2] = minZ;
      camera.fallVelocity = 0;
    }
  }

  return {
    /** Held-key movement and gravity. Frame-rate independent; dt in seconds. */
    update(dt) {
      if (!enabled() || camera.mode === 'orbit') return;
      if (moveFwd || moveBack) {
        camera.moveBy(((moveFwd ? 1 : 0) - (moveBack ? 1 : 0)) * MOVE_SPEED * dt);
      }
      if (camera.mode === 'walk') updateWalk(dt);
    },
    /** Cycle orbit -> free -> walk, grabbing or releasing the pointer to suit. */
    cycleMode() {
      const next = CAMERA_MODES[(CAMERA_MODES.indexOf(camera.mode) + 1) % CAMERA_MODES.length];
      camera.setMode(next);
      if (wantsLock()) requestLook(); else releaseLook();
      return next;
    },
    setMode(mode) {
      camera.setMode(mode);
      if (wantsLock()) requestLook(); else releaseLook();
    },
    releaseLook,
    detach() { for (const off of on) off(); on.length = 0; },
  };
}
