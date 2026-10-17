// Tests for the camera: position, direction, and the distance to what it
// orbits. Run with:
//   node --test as-camera.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASCamera } from './as-camera.js';

const close = (a, b, what, eps = 1e-9) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < eps, `${what}: [${a}] vs [${b}]`));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

test('by default, the view it always had', () => {
  const camera = new ASCamera();
  // Yaw 0.55 and pitch 0.3, from 6.4 back, onto [0, 0, 0.15].
  close(camera.focus(), [0, 0, 0.15], 'focus');
  close(camera.direction, [-0.4993, -0.8144, -0.2955], 'direction', 1e-4);
  assert.equal(camera.distance, 6.4);
});

test('orbiting turns about the focus; free and walk turn where they stand', () => {
  const camera = new ASCamera();
  const focus = camera.focus();
  camera.rotateBy(0.4, -0.2);
  close(camera.focus(), focus, 'orbit keeps the focus');

  camera.setMode('free');
  const position = camera.position.slice();
  camera.rotateBy(-0.7, 0.3);
  close(camera.position, position, 'free keeps the position');
  assert.ok(Math.abs(Math.hypot(...camera.direction) - 1) < 1e-12, 'direction stays unit');
});

test('turning: positive yaw turns right, positive pitch looks down, and stops short of vertical', () => {
  const camera = new ASCamera({ position: [0, 0, 0], direction: [0, 1, 0] });
  camera.setMode('free');
  camera.rotateBy(0.1, 0);
  const right = camera.basis().right;
  assert.ok(camera.direction[0] > 0 && right[0] > 0.9, 'from +Y, right is +X, and it turns that way');
  camera.rotateBy(0, 10);
  assert.ok(camera.direction[2] < -0.97 && camera.direction[2] > -0.99, `down, not straight: ${camera.direction}`);
});

test('dolly moves along the direction, the focus staying put', () => {
  const camera = new ASCamera();
  const focus = camera.focus();
  camera.dolly(2);
  close(camera.focus(), focus, 'focus');
  assert.equal(camera.distance, 12.8);
  camera.dolly(1e-6);
  assert.equal(camera.distance, camera.minDistance, 'and stops at minDistance');
});

test('changing mode never moves the view; walking stays level', () => {
  const camera = new ASCamera();
  const before = JSON.stringify(camera.basis());
  for (const mode of ['free', 'walk', 'orbit']) {
    camera.setMode(mode);
    assert.equal(JSON.stringify(camera.basis()), before, mode);
  }
  camera.setMode('walk');
  const z = camera.position[2];
  camera.moveBy(3);
  assert.equal(camera.position[2], z, 'looking down, walking stays level');
  camera.setMode('free');
  camera.moveBy(3);
  assert.ok(camera.position[2] < z, 'flying follows the look');
});

test('aim places the camera by what it looks at', () => {
  const camera = new ASCamera();
  camera.aim({ focus: [1, 2, 3], direction: [0, 0, -2], distance: 5 });
  close(camera.position, [1, 2, 8], 'position');
  close(camera.direction, [0, 0, -1], 'direction made unit');
});

test('straight down still has a frame: right -X, up -Y, as just short of it', () => {
  const { right, up, forward } = new ASCamera({ position: [0, 0, 5], direction: [0, 0, -1] }).basis();
  close(right, [-1, 0, 0], 'right');
  close(up, [0, -1, 0], 'up');
  assert.equal(dot(right, forward), 0);
});

test('a scene file\'s camera block round-trips, and an old one is read', () => {
  const camera = new ASCamera({ projection: 'orthographic' });
  camera.rotateBy(1, 0.2);
  camera.dolly(0.5);
  const again = new ASCamera();
  again.setFromSpec(JSON.parse(JSON.stringify(camera.toSpec())));
  assert.equal(JSON.stringify(again.basis()), JSON.stringify(camera.basis()));
  assert.equal(again.projection, 'orthographic');

  // { target, yaw, pitch, distance }: from that far round the target.
  const old = new ASCamera();
  old.setFromSpec({ target: [0, 0, 0.3], yaw: 0.9, pitch: 0.3, distance: 7 });
  close(old.focus(), [0, 0, 0.3], 'focus');
  const cp = Math.cos(0.3);
  close(old.direction, [-cp * Math.sin(0.9), -cp * Math.cos(0.9), -Math.sin(0.3)], 'direction', 1e-12);
});

test('panning slides square to the view: direction kept, focus carried along', () => {
  const camera = new ASCamera({ position: [0, 0, 5], direction: [0, 0, -1], projection: 'orthographic' });
  const { right, up } = camera.basis();
  const focus = camera.focus();
  camera.panBy(2, -1);
  close(camera.position, [2 * right[0] - up[0], 2 * right[1] - up[1], 5], 'position');
  close(camera.direction, [0, 0, -1], 'direction');
  close(camera.focus(), focus.map((f, i) => f + camera.position[i] - [0, 0, 5][i]), 'focus moved with it');
  assert.equal(camera.distance, 6.4, 'distance, and so the orthographic framing, unchanged');
});

test('a camera block can give where it is and what it looks at: the direction and distance follow', () => {
  const camera = new ASCamera();
  camera.setFromSpec({ position: [6, -8, 4], target: [0, 0, 1] });
  const len = Math.hypot(6, 8, 3);
  [-6, 8, -3].forEach((v, i) => assert.ok(Math.abs(camera.direction[i] - v / len) < 1e-12, `direction ${i}`));
  assert.ok(Math.abs(camera.distance - len) < 1e-12, 'distance');
  camera.focus().forEach((v, i) => assert.ok(Math.abs(v - [0, 0, 1][i]) < 1e-12, `it orbits the target: ${i}`));
  // Given as well, direction and distance give way to the target.
  camera.setFromSpec({ position: [6, -8, 4], target: [0, 0, 1], direction: [1, 0, 0], distance: 2 });
  assert.ok(Math.abs(camera.distance - len) < 1e-12, 'the target wins');
  // And toSpec() writes it as position, direction and distance, as ever.
  assert.deepEqual(Object.keys(camera.toSpec()).sort(), ['direction', 'distance', 'position']);
});

test('orbit mode dollies between a near and a far limit: given, or a sixteenth and four times the starting distance', () => {
  const camera = new ASCamera();
  camera.setFromSpec({ position: [0, -12, 0], target: [0, 0, 0] });
  assert.equal(camera.minDistance, 12 / 16);
  assert.equal(camera.maxDistance, 48);
  for (let i = 0; i < 100; i++) camera.dolly(1.5);
  assert.equal(camera.distance, 48, 'no further than four times');
  for (let i = 0; i < 100; i++) camera.dolly(0.5);
  assert.equal(camera.distance, 0.75, 'no nearer than a sixteenth');
  assert.ok(!('minDistance' in camera.toSpec()) && !('maxDistance' in camera.toSpec()), 'defaults are not written');

  const given = new ASCamera();
  given.setFromSpec({ position: [0, -12, 0], target: [0, 0, 0], minDistance: 2, maxDistance: 100 });
  for (let i = 0; i < 100; i++) given.dolly(1.5);
  assert.equal(given.distance, 100);
  const spec = given.toSpec();
  assert.equal(spec.minDistance, 2);
  assert.equal(spec.maxDistance, 100);
  const again = new ASCamera();
  again.setFromSpec(JSON.parse(JSON.stringify(spec)));
  assert.equal(again.minDistance, 2, 'and they round-trip');
  assert.equal(again.maxDistance, 100);
});
