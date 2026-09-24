// Camera state and the input bindings that drive it.
//
// A camera is plain state plus the maths to turn it into a basis. It holds no
// GPU resources and knows nothing about a renderer, so an editor can point
// several cameras at one scene, drive one from a UI and another from the
// mouse, or animate one with no renderer attached at all.
//
// Coordinates are right-handed with +z up, matching the scene format.

export const CAMERA_MODES = ['orbit', 'free', 'walk'];

/** The unit look direction for a yaw/pitch pair. */
export function lookDir(yaw, pitch) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return [-cp * Math.sin(yaw), -cp * Math.cos(yaw), -sp];
}

const PITCH_LIMIT = 1.35;   // short of straight up, where the basis degenerates

export class ASCamera {
  constructor(opts = {}) {
    this.mode = opts.mode ?? 'orbit';

    // Orbit state.
    this.target = (opts.target ?? [0, 0, 0.15]).slice();
    this.yaw = opts.yaw ?? 0.55;
    this.pitch = opts.pitch ?? 0.30;
    this.distance = opts.distance ?? 6.4;
    this.minDistance = opts.minDistance ?? 0.05;
    this.maxDistance = opts.maxDistance ?? 200;

    // Free/walk state. Both modes share it and differ only in how movement
    // is applied, so switching between them never moves the eye.
    this.freeEye = (opts.eye ?? [0, 0, 0]).slice();
    this.freeYaw = this.yaw;
    this.freePitch = this.pitch;

    this.fovY = opts.fovY ?? 0.9;      // radians

    // Perspective or orthographic. A ray caster has no projection matrix, so
    // this only decides how the renderer lays out the rays; the eye,
    // orientation and modes above are the same either way.
    this.projection = opts.projection ?? 'perspective';
    // Half the visible height in world units, for orthographic views. Null
    // means "match the perspective framing", which keeps whatever sits at
    // the orbit target the same size across a switch.
    this.orthoHeight = opts.orthoHeight ?? null;
    this.fallVelocity = 0;             // walk mode only
  }

  /**
   * Half the visible height, in world units, for an orthographic view.
   * Derived from the field of view and the orbit distance unless set, so
   * toggling projection leaves the framing at the target alone.
   */
  halfHeight() {
    if (this.orthoHeight !== null) return this.orthoHeight;
    return Math.tan(0.5 * this.fovY) * (this.distance ?? 8);
  }

  /** Eye position and orientation for whichever mode is active. */
  basis() {
    if (this.mode === 'orbit') {
      const forward = lookDir(this.yaw, this.pitch);
      const eye = [
        this.target[0] - this.distance * forward[0],
        this.target[1] - this.distance * forward[1],
        this.target[2] - this.distance * forward[2],
      ];
      return withFrame(eye, forward);
    }
    return withFrame(this.freeEye, lookDir(this.freeYaw, this.freePitch));
  }

  /**
   * Switch modes carrying the current eye and orientation across, so the view
   * never jumps. 'free' and 'walk' share state, so that pair needs no sync.
   */
  setMode(mode) {
    if (mode === this.mode || !CAMERA_MODES.includes(mode)) return;
    const wasLook = this.mode !== 'orbit', willLook = mode !== 'orbit';
    if (willLook && !wasLook) {
      const { eye } = this.basis();
      this.freeEye = eye.slice();
      this.freeYaw = this.yaw;
      this.freePitch = this.pitch;
    } else if (!willLook && wasLook) {
      const { eye, forward } = this.basis();
      this.yaw = this.freeYaw;
      this.pitch = this.freePitch;
      this.target = [
        eye[0] + this.distance * forward[0],
        eye[1] + this.distance * forward[1],
        eye[2] + this.distance * forward[2],
      ];
    }
    if (mode === 'walk') this.fallVelocity = 0;
    this.mode = mode;
  }

  /** Rotate, in radians, whichever pair of angles the current mode uses. */
  rotateBy(dyaw, dpitch) {
    if (this.mode === 'orbit') {
      this.yaw += dyaw;
      this.pitch = clamp(this.pitch + dpitch, -PITCH_LIMIT, PITCH_LIMIT);
    } else {
      this.freeYaw += dyaw;
      this.freePitch = clamp(this.freePitch + dpitch, -PITCH_LIMIT, PITCH_LIMIT);
    }
  }

  /** Orbit only: multiply the distance to the target. */
  dolly(factor) {
    this.distance = clamp(this.distance * factor, this.minDistance, this.maxDistance);
  }

  /**
   * Free/walk only: move along the view direction. In walk mode the direction
   * is flattened to the ground plane, so looking up or down doesn't change how
   * fast, or which way, you travel.
   */
  moveBy(distance) {
    if (this.mode === 'orbit') return;
    const forward = lookDir(this.freeYaw, this.freePitch);
    let dir = forward;
    if (this.mode === 'walk') {
      const len = Math.hypot(forward[0], forward[1]) || 1;
      dir = [forward[0] / len, forward[1] / len, 0];
    }
    for (let i = 0; i < 3; i++) this.freeEye[i] += dir[i] * distance;
  }

  /** Adopt a viewpoint from a scene file's optional `camera` block. */
  setFromSpec(spec) {
    if (!spec) return;
    if (spec.target) this.target = spec.target.slice();
    if (spec.yaw !== undefined) this.yaw = spec.yaw;
    if (spec.pitch !== undefined) this.pitch = spec.pitch;
    if (spec.distance !== undefined) this.distance = spec.distance;
    if (spec.mode) this.setMode(spec.mode);
    if (spec.projection) this.projection = spec.projection;
    if (spec.orthoHeight !== undefined) this.orthoHeight = spec.orthoHeight;
  }

  /** A plain object suitable for a scene file's `camera` block. */
  toSpec() {
    const spec = {
      target: this.target.slice(),
      yaw: this.yaw, pitch: this.pitch, distance: this.distance,
    };
    // Only when it isn't the default, so an ordinary scene file stays plain.
    if (this.projection !== 'perspective') spec.projection = this.projection;
    if (this.orthoHeight !== null) spec.orthoHeight = this.orthoHeight;
    return spec;
  }
}

function withFrame(eye, forward) {
  let right = [forward[1], -forward[0], 0];        // cross(forward, +Z)
  const len = Math.hypot(right[0], right[1]) || 1;
  right = [right[0] / len, right[1] / len, 0];
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
    probeEye = camera.freeEye.slice();
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
    if (camera.freeEye[2] > minZ) {
      camera.fallVelocity += GRAVITY * dt;
      camera.freeEye[2] -= camera.fallVelocity * dt;
      if (camera.freeEye[2] < minZ) {
        camera.freeEye[2] = minZ;
        camera.fallVelocity = 0;
      }
    } else {
      camera.freeEye[2] = minZ;
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
