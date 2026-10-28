// Keyframed animation: tracks, and clips made of them.
//
// A track is a value over time, given at its keys:
//
//   { times: [t0, t1, ...],          seconds, ascending
//     values: [v0, v1, ...],         one per key: a vector, any size
//     interpolation: "linear" }      or "step" or "cubic"; linear by default
//
// Linear interpolates between keys (a rotation, a quaternion [x, y, z, w],
// by slerp); step holds each key's value until the next; cubic is glTF's
// CUBICSPLINE, a Hermite curve, each key's value then [in-tangent, value,
// out-tangent]. Before the first key a track is its first value, after the
// last its last.
//
// A clip:
//
//   { duration,                      seconds
//     loop: true,                    optional: played again from 0 at the end
//     markers: [{ name, time }],     optional: named moments, "foot down";
//                                    a name may come more than once
//     channels: { target: { property: track } } }
//
// A target is what a track moves - a figure's bone, by name - and a
// property what of it: "rotation" and "translation" for a bone. Nothing
// here knows what they are: a spheroid's "height" would be a track like any
// other, of size 1.

import { normalize, slerp, angleBetween } from './quat.js';

/** A track's value at time t (`rotation`: its values are quaternions). */
export function sampleTrack({ times, values, interpolation = 'linear' }, t, { rotation = false } = {}) {
  const n = times.length;
  const cubic = interpolation === 'cubic';
  const value = (k) => (cubic ? values[k][1] : values[k]);
  if (n === 1 || t <= times[0]) return value(0).slice();
  if (t >= times[n - 1]) return value(n - 1).slice();
  // The key at or before t: binary search.
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid; else hi = mid;
  }
  const dt = times[lo + 1] - times[lo], u = (t - times[lo]) / dt;
  if (interpolation === 'step') return value(lo).slice();
  if (cubic) {
    const p0 = values[lo][1], p1 = values[lo + 1][1];
    const m0 = values[lo][2], m1 = values[lo + 1][0];          // out-tangent of lo, in-tangent of lo + 1
    const u2 = u * u, u3 = u2 * u;
    const out = p0.map((_, c) => (2 * u3 - 3 * u2 + 1) * p0[c] + (u3 - 2 * u2 + u) * dt * m0[c]
                                + (-2 * u3 + 3 * u2) * p1[c] + (u3 - u2) * dt * m1[c]);
    return rotation ? normalize(out) : out;
  }
  return rotation ? slerp(value(lo), value(lo + 1), u) : value(lo).map((v, c) => v + (value(lo + 1)[c] - v) * u);
}

/** Time t (seconds since a clip started) as a time in the clip: wrapped if it loops, else clamped. */
export function clipTime(clip, t) {
  const d = clip.duration ?? 0;
  if (!(d > 0)) return 0;
  if (clip.loop) return ((t % d) + d) % d;
  return Math.min(Math.max(t, 0), d);
}

/**
 * The markers passed going from `from` to `to` (times since the clip
 * started, from < to), in order: those at times in (from, to], each pass of
 * a looping clip's again.
 */
export function markersBetween(clip, from, to) {
  const markers = [...(clip.markers ?? [])].sort((a, b) => a.time - b.time);
  const d = clip.duration ?? 0;
  if (!markers.length || !(to > from)) return [];
  if (!clip.loop || !(d > 0)) return markers.filter((m) => m.time > from && m.time <= to);
  const out = [];
  for (let lap = Math.floor(from / d); lap * d < to; lap++) {
    for (const m of markers) {
      const at = lap * d + m.time;
      if (at > from && at <= to) out.push(m);
    }
  }
  return out;
}

/**
 * A linear track with the keys left out that interpolation between those
 * kept reproduces within `tolerance`: an angle in radians for rotations,
 * a distance otherwise. The first and last keys always stay. Other
 * interpolations come back as they are.
 */
export function reduceTrack(track, tolerance, { rotation = false } = {}) {
  if ((track.interpolation ?? 'linear') !== 'linear' || track.times.length < 3 || !(tolerance > 0)) return track;
  const { times, values } = track;
  const error = rotation ? angleBetween : (a, b) => Math.hypot(...a.map((v, c) => v - b[c]));
  const keep = [0];
  for (let i = 0; i < times.length - 1;) {
    // From key i, as far on as one span reproduces every key between.
    let j = i + 1;
    while (j + 1 < times.length) {
      const span = { times: [times[i], times[j + 1]], values: [values[i], values[j + 1]] };
      let fits = true;
      for (let k = i + 1; k <= j && fits; k++) fits = error(sampleTrack(span, times[k], { rotation }), values[k]) <= tolerance;
      if (!fits) break;
      j++;
    }
    keep.push(j);
    i = j;
  }
  return { ...track, times: keep.map((k) => times[k]), values: keep.map((k) => values[k]) };
}
