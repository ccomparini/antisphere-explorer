// Keys and the mouse, for a FlightControl (flight.js).
//
//   click          grab the pointer for mouse-look; Escape lets it go
//   mouse          turn (left/right) and look (up/down), while grabbed
//   W A S D        forward, left, back, right (arrow keys too)
//   E / Space      up        Q / C   down
//   Shift          faster
//   V              switch camera mode (forward / look-at)
//
// Keys are read by physical position (KeyboardEvent.code), so WASD is where
// it should be on any layout.

import { CAMERA_MODES } from './camera.js';

const KEYS = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  KeyE: 'up', Space: 'up',
  KeyQ: 'down', KeyC: 'down',
  ShiftLeft: 'fast', ShiftRight: 'fast',
};

// Radians per pixel of mouse movement, as the raycast page's mouse-look.
const TURN_PER_PIXEL = 0.006, LOOK_PER_PIXEL = 0.005;

/** Wire `canvas` and the window to `flight`; returns a function that unwires. */
export function attachFlightInput(canvas, flight) {
  const off = [];
  const listen = (target, type, fn, opt) => {
    target.addEventListener(type, fn, opt);
    off.push(() => target.removeEventListener(type, fn, opt));
  };
  const locked = () => document.pointerLockElement === canvas;

  listen(canvas, 'click', () => {
    if (locked()) return;
    try {
      const p = canvas.requestPointerLock();
      if (p?.catch) p.catch(() => {});        // refused: the next click tries again
    } catch { /* likewise */ }
  });
  listen(window, 'mousemove', (e) => {
    if (locked()) flight.look(e.movementX * TURN_PER_PIXEL, -e.movementY * LOOK_PER_PIXEL);
  });
  listen(window, 'keydown', (e) => {
    const action = KEYS[e.code];
    if (action) {
      e.preventDefault();                      // no scrolling on Space or the arrows
      flight.press(action);
    } else if (e.code === 'KeyV' && !e.repeat) {
      const { camera } = flight;
      camera.mode = CAMERA_MODES[(CAMERA_MODES.indexOf(camera.mode) + 1) % CAMERA_MODES.length];
    }
  });
  listen(window, 'keyup', (e) => {
    const action = KEYS[e.code];
    if (action) flight.release(action);
  });
  // A key let go while the window wasn't looking never sends keyup.
  listen(window, 'blur', () => flight.releaseAll());

  return () => off.forEach((f) => f());
}
