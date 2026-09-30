// Tests for physlab's quaternions, world objects and attached camera. Run with:
//   node --test public/physlab/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identity, fromAxisAngle, multiply, rotate, axes, fromBasis, toAxisAngle, normalize } from './quat.js';
import { World, WorldObject } from './world.js';
import { AttachedCamera } from './camera.js';
import { compileScene } from '../antisphere-scene.js';

const near = (a, b, eps = 1e-9) => {
  if (Array.isArray(a)) a.forEach((v, i) => near(v, b[i], eps));
  else assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// A reproducible spread of orientations.
function* randomQuats(n) {
  let seed = 7;
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  for (let i = 0; i < n; i++) yield normalize([r(), r(), r(), r()]);
}

// -- quaternions ----------------------------------------------------------------

test('turns are right-handed, and multiply(a, b) turns by b first', () => {
  near(rotate(fromAxisAngle([1, 0, 0], Math.PI / 2), [0, 0, 1]), [0, -1, 0]);   // +Z to -Y about +X
  near(rotate(fromAxisAngle([0, 0, 1], Math.PI / 2), [1, 0, 0]), [0, 1, 0]);    // +X to +Y about +Z
  const aboutZ = fromAxisAngle([0, 0, 1], Math.PI / 2), aboutX = fromAxisAngle([1, 0, 0], Math.PI / 2);
  // +Y about Z first goes to -X, which about X stays -X.
  near(rotate(multiply(aboutX, aboutZ), [0, 1, 0]), [-1, 0, 0]);
  near(rotate(identity(), [1, 2, 3]), [1, 2, 3]);
});

test('axes, fromBasis and toAxisAngle all describe the same turn', () => {
  for (const q of randomQuats(50)) {
    const { x, y, z } = axes(q);
    near(cross(y, z), x, 1e-12);                          // right-handed
    const back = fromBasis(x, y, z);
    const sign = Math.sign(dot(back, q) + back[3] * q[3]) || 1;   // q and -q are the same turn
    near(back.map((v) => v * sign), q, 1e-9);
    const { axis, radians } = toAxisAngle(q);
    const again = fromAxisAngle(axis, radians);
    for (const v of [[1, 0, 0], [0.3, -2, 5]]) near(rotate(again, v), rotate(q, v), 1e-9);
  }
  assert.deepEqual(toAxisAngle(identity()), { axis: [0, 0, 1], radians: 0 });
});

test('fromBasis refuses a frame that is no rotation', () => {
  assert.throws(() => fromBasis([-1, 0, 0], [0, 1, 0], [0, 0, 1]), /right-handed/);   // a mirror
  assert.throws(() => fromBasis([1, 0, 0], [0.6, 0.8, 0], [0, 0, 1]), /orthonormal/);  // a shear
  assert.throws(() => fromBasis([2, 0, 0], [0, 0.5, 0], [0, 0, 1]), /orthonormal/);    // stretched
});

// -- world objects --------------------------------------------------------------

const ROCK = { materials: { rock: { albedo: [0.5, 0.5, 0.5] } } };
const ball = (r) => ({ sphere: { center: [0, 0, 0], radius: r }, material: 'rock' });

test('the scene holds exactly the objects that have geometry, each placed', () => {
  const world = new World();
  world.add(new WorldObject('planet', { geometry: ball(500) }));
  world.add(new WorldObject('mount', { position: [0, 0, 520] }));   // no geometry: not in the scene
  let spec = world.sceneSpec(ROCK);
  assert.deepEqual(Object.keys(spec.objects), ['planet']);
  assert.deepEqual(spec.root, { use: 'planet' });                   // no turn, at the origin: nothing added
  assert.equal(compileScene(spec).nodes.length, 2);                 // node 0 is reserved

  world.add(new WorldObject('rod', {
    position: [0, 0, 510],
    orientation: fromAxisAngle([1, 0, 0], Math.PI / 2),
    geometry: { cylinder: { center: [0, 0, 0], axis: [0, 0, 1], radius: 1 }, material: 'rock' },
  }));
  spec = world.sceneSpec(ROCK);
  assert.deepEqual(spec.root.union.map((u) => u.use), ['planet', 'rod']);
  // Placed by the scene compiler where the quaternion says: local +Z to world -Y.
  const rod = compileScene(spec).nodes.find((n) => n?.prim && n.prim.k_par !== n.prim.k_perp);
  near(rod.prim.axis.map(Math.abs), [0, 1, 0], 1e-9);
});

test('a world needs something to draw, and unique names', () => {
  const world = new World();
  world.add(new WorldObject('a'));
  assert.throws(() => world.sceneSpec(ROCK), /no object .* geometry/);
  assert.throws(() => world.add(new WorldObject('a')), /already has an object called "a"/);
});

test('setPosition moves an object without replacing its position array', () => {
  const o = new WorldObject('o', { position: [1, 2, 3] });
  const held = o.position;
  o.setPosition([4, 5, 6]);
  assert.equal(o.position, held);
  assert.deepEqual(held, [4, 5, 6]);
});

// -- the camera -------------------------------------------------------------------

// What the renderer assumes of a basis: unit, square to each other, and
// up = right x forward (as ASCamera's withFrame builds it).
function assertFrame({ forward, right, up }) {
  for (const v of [forward, right, up]) near(Math.hypot(...v), 1, 1e-9);
  near([dot(forward, right), dot(right, up), dot(up, forward)], [0, 0, 0], 1e-9);
  near(cross(right, forward), up, 1e-9);
}

test("'forward' looks along the object's +Y with its +Z up", () => {
  const mount = new WorldObject('m', { position: [1, 2, 3] });
  const cam = new AttachedCamera(mount);
  let b = cam.basis();
  assert.deepEqual(b.eye, [1, 2, 3]);
  near(b.forward, [0, 1, 0]); near(b.up, [0, 0, 1]); near(b.right, [1, 0, 0]);
  assertFrame(b);
  for (const q of randomQuats(20)) {
    mount.orientation = q;
    b = cam.basis();
    const { x, y, z } = axes(q);
    near(b.forward, y); near(b.up, z); near(b.right, x);
  }
});

test("'lookAt' looks at its target, keeping as much of the object's +Z up as it can", () => {
  const mount = new WorldObject('m', { position: [0, 0, 520] });
  const planet = new WorldObject('p', { position: [0, 0, 0] });
  const beacon = new WorldObject('b', { position: [100, 0, 520] });
  const cam = new AttachedCamera(mount, { mode: 'lookAt', target: beacon.position });

  let b = cam.basis();
  near(b.forward, [1, 0, 0]);
  near(b.up, [0, 0, 1]);                                             // level: the object's own up
  assertFrame(b);

  // The target is held by reference: move the beacon and the view follows.
  beacon.setPosition([0, 100, 620]);
  b = cam.basis();
  near(b.forward, [0, Math.SQRT1_2, Math.SQRT1_2]);
  assertFrame(b);
  assert.ok(dot(b.up, [0, 0, 1]) > 0, 'still the right way up');

  // Straight down, along -Z: the object's +Y becomes the top of the picture.
  cam.target = planet.position;
  b = cam.basis();
  near(b.forward, [0, 0, -1]);
  near(b.up, [0, 1, 0]);
  assertFrame(b);

  // With no target it looks forward.
  cam.target = null;
  near(cam.basis().forward, [0, 1, 0]);
});

test('an unknown camera mode is refused', () => {
  const cam = new AttachedCamera(new WorldObject('m'));
  assert.throws(() => { cam.mode = 'orbit'; }, /not one of forward, lookAt/);
});

// -- time ---------------------------------------------------------------------------

test('World.update gives every object its update, with dt and the world', () => {
  const world = new World();
  const calls = [];
  const spinner = world.add(new WorldObject('spinner', {
    update: (self, dt, w) => calls.push([self.name, dt, w === world]),
  }));
  world.add(new WorldObject('still'));                           // no behaviour: does nothing
  class Drifter extends WorldObject {
    update(dt) { this.setPosition([this.position[0] + dt, 0, 0]); }
  }
  const drifter = world.add(new Drifter('drifter'));
  world.update(0.25);
  world.update(0.5);
  assert.deepEqual(calls, [['spinner', 0.25, true], ['spinner', 0.5, true]]);
  assert.deepEqual(drifter.position, [0.75, 0, 0]);
  assert.equal(spinner.behaviour !== null, true);
});
