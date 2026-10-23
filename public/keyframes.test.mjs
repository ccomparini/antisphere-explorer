// Tests for keyframed tracks and clips. Run with:
//   node --test public/keyframes.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTrack, clipTime, markersBetween, reduceTrack, angleBetween } from './keyframes.js';

const near = (got, want, what, tol = 1e-9) => {
  [want].flat().forEach((w, i) => assert.ok(Math.abs([got].flat()[i] - w) <= tol, `${what}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`));
};
const turnZ = (deg) => [0, 0, Math.sin(deg * Math.PI / 360), Math.cos(deg * Math.PI / 360)];

test('linear interpolates, step holds, and either is its end values beyond its keys', () => {
  const track = { times: [0, 1, 3], values: [[0], [10], [30]] };
  near(sampleTrack(track, 0.5), [5], 'halfway into the first span');
  near(sampleTrack(track, 2), [20], 'halfway into the second, twice as long');
  near(sampleTrack(track, -1), [0], 'before the first key');
  near(sampleTrack(track, 9), [30], 'after the last');
  const step = { ...track, interpolation: 'step' };
  near(sampleTrack(step, 0.99), [0], 'step: the key before');
  near(sampleTrack(step, 1), [10], 'step: at a key, that key');
  near(sampleTrack({ times: [2], values: [[7, 8]] }, 0), [7, 8], 'one key: always it');
  assert.notEqual(sampleTrack(track, 9), track.values[2], 'a copy, not the track\'s own array');
});

test('rotations slerp: the short way, at constant speed', () => {
  const track = { times: [0, 1], values: [turnZ(0), turnZ(90)] };
  near(sampleTrack(track, 0.5, { rotation: true }), turnZ(45), 'halfway: 45 degrees');
  near(sampleTrack(track, 0.25, { rotation: true }), turnZ(22.5), 'a quarter: 22.5');
  // The same 90 degrees with the second key's sign flipped goes the same way.
  const flipped = { times: [0, 1], values: [turnZ(0), turnZ(90).map((v) => -v)] };
  near(angleBetween(sampleTrack(flipped, 0.5, { rotation: true }), turnZ(45)), 0, 'not the long way round', 1e-9);
});

test('cubic follows its tangents, as glTF\'s CUBICSPLINE', () => {
  // y from 1 to 2 over 1 s, out-tangent 2 at the first key, in-tangent 0 at
  // the second: at u = 1/2 the Hermite basis is h00 = 1/2, h10 = 1/8, h01 = 1/2.
  const track = { times: [0, 1], interpolation: 'cubic', values: [[[0], [1], [2]], [[0], [2], [0]]] };
  near(sampleTrack(track, 0.5), [1.75], 'halfway');
  near(sampleTrack(track, 0), [1], 'at a key, its value');
  near(sampleTrack(track, 5), [2], 'past the end');
  // Over a span of 2 s the tangents are per second, so they count double.
  const slow = { ...track, times: [0, 2] };
  near(sampleTrack(slow, 1), [0.5 + 2 * 2 / 8 + 1], 'halfway, tangents scaled by the span');
});

test('a clip\'s time: a loop wraps, anything else holds its ends', () => {
  near(clipTime({ duration: 2, loop: true }, 5), 1, 'two and a half times round');
  near(clipTime({ duration: 2, loop: true }, -0.5), 1.5, 'before the start, from the end');
  near(clipTime({ duration: 2 }, 5), 2, 'once: held at the end');
  near(clipTime({ duration: 2 }, -1), 0, 'once: held at the start');
  near(clipTime({ duration: 0, loop: true }, 3), 0, 'no duration');
});

test('markers passed in a span: in order, and again each time round a loop', () => {
  const clip = { duration: 1, loop: true, markers: [{ name: 'right foot', time: 0.75 }, { name: 'left foot', time: 0.25 }] };
  assert.deepEqual(markersBetween(clip, 0, 0.5).map((m) => m.name), ['left foot']);
  assert.deepEqual(markersBetween(clip, 0.5, 1.5).map((m) => m.name), ['right foot', 'left foot'], 'across the loop');
  assert.deepEqual(markersBetween(clip, 0, 2).map((m) => m.name), ['left foot', 'right foot', 'left foot', 'right foot'], 'twice round');
  assert.deepEqual(markersBetween(clip, 0.25, 0.75).map((m) => m.name), ['right foot'], 'from a marker: not it; to one: it');
  assert.deepEqual(markersBetween({ ...clip, loop: false }, 0.5, 9).map((m) => m.name), ['right foot'], 'once: only the one left');
  assert.deepEqual(markersBetween({ duration: 1 }, 0, 1), [], 'no markers');
});

test('reducing a track keeps what interpolation can\'t reproduce, and both ends', () => {
  // A straight run from 0 to 10 and back: the turn is the only key between the ends.
  const times = Array.from({ length: 21 }, (_, i) => i / 10);
  const values = times.map((t) => [t <= 1 ? 10 * t : 10 * (2 - t)]);
  const reduced = reduceTrack({ times, values }, 1e-9);
  assert.deepEqual(reduced.times, [0, 1, 2]);
  times.forEach((t, i) => near(sampleTrack(reduced, t), values[i], `at ${t}`, 1e-9));
  // A curve: within the tolerance everywhere it was given.
  const curve = { times, values: times.map((t) => [Math.sin(3 * t)]) };
  const coarse = reduceTrack(curve, 0.01);
  assert.ok(coarse.times.length < times.length && coarse.times.length > 2, `${coarse.times.length} keys`);
  times.forEach((t, i) => near(sampleTrack(coarse, t), curve.values[i], `the curve at ${t}`, 0.01));
  // Rotations by angle: a steady turn is two keys.
  const turn = { times, values: times.map((t) => turnZ(45 * t)) };
  assert.deepEqual(reduceTrack(turn, 1e-6, { rotation: true }).times, [0, 2]);
  // Step and cubic tracks, and a tolerance of 0, are left as they are.
  const step = { ...curve, interpolation: 'step' };
  assert.equal(reduceTrack(step, 1), step);
  assert.equal(reduceTrack(curve, 0), curve);
});
