// Keys and the mouse, for a FlightControl (flight.js).
//
//   click          grab the pointer for mouse-look; Escape lets it go
//   mouse          turn (left/right) and look (up/down), while grabbed
//   W A S D        forward, left, back, right
//   E              up        Q / C   down
//   Shift          faster
//
// plus whatever keys the page adds as `commands` (physlab.js uses the
// arrows, Space and P): run once per press, or held, with a release too. Keys are read by physical position
// (KeyboardEvent.code), so WASD is where it should be on any layout.

const KEYS = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  KeyE: 'up',
  KeyQ: 'down', KeyC: 'down',
  ShiftLeft: 'fast', ShiftRight: 'fast',
};

// Radians per pixel of mouse movement, as the raycast page's mouse-look.
const TURN_PER_PIXEL = 0.006, LOOK_PER_PIXEL = 0.005;

/**
 * Wire `canvas` and the window to `flight`; returns a function that unwires.
 * `commands` maps KeyboardEvent.code to a function run once per press, or
 * to { press, release } for a key that does something while it is held.
 */
export function attachFlightInput(canvas, flight, { commands = {} } = {}) {
  const off = [];
  const listen = (target, type, fn, opt) => {
    target.addEventListener(type, fn, opt);
    off.push(() => target.removeEventListener(type, fn, opt));
  };
  const locked = () => document.pointerLockElement === canvas;
  const held = new Set();                     // held commands' codes
  const release = (code) => {
    if (held.delete(code)) commands[code].release?.();
  };

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
      e.preventDefault();
      flight.press(action);
    } else if (commands[e.code]) {
      e.preventDefault();                      // no scrolling on Space or the arrows
      if (e.repeat) return;
      const command = commands[e.code];
      if (typeof command === 'function') {
        command();
      } else if (!held.has(e.code)) {
        held.add(e.code);
        command.press?.();
      }
    }
  });
  listen(window, 'keyup', (e) => {
    const action = KEYS[e.code];
    if (action) flight.release(action);
    else release(e.code);
  });
  // A key let go while the window wasn't looking never sends keyup.
  listen(window, 'blur', () => {
    flight.releaseAll();
    for (const code of [...held]) release(code);
  });

  return () => off.forEach((f) => f());
}
