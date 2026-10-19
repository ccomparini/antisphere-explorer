// ---------------------------------------------------------------------------
// Tangency: slide one quadric along an axis until, where it meets another,
// their surfaces' normals agree - flush (the same way: a smooth join, a
// tube running into a flare) or touching (opposite: one resting against
// the other). The scene's "tangentTo" (antisphere-scene.js) rides on this.
//
// A quadric here is { axis, k_par, k_perp, linear, constant }:
//   H(R) = k_perp R.R + (k_par - k_perp)(R.a)^2 + 2 c.R + d,
// inside where H < 0, so grad H points out of it.
//
// B moved by t u meets A at a point x where both vanish; there the unit
// normals should match. So over x and t, least squares (Levenberg-
// Marquardt) on
//   H_A(x) / |grad H_A|,  H_B(x - t u) / |grad H_B|   - x on both surfaces
//   n_A(x) - s n_B(x - t u)                            - their normals agreeing
// (s = 1 flush, -1 touching). Where the two can be made exactly tangent,
// that comes to zero; where they can't, its least is the nearest they come
// - the best effort that is asked for. Several starts, since a pair can be
// tangent in more than one place; the one nearest where the author put it
// wins.
// ---------------------------------------------------------------------------

import { quadricAt, gradientAt } from './quadric.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

// The residual: distances from both surfaces, weighted so heavily that
// meeting comes first - with no exact fit, the least mismatch is wanted
// among points on both surfaces, not a point between them - then the
// normals' difference.
const MEET = 1e4;
function residual(A, B, u, s, z) {
  const x = [z[0], z[1], z[2]], y = sub(x, u.map((v) => v * z[3]));
  const gA = gradientAt(A, x), gB = gradientAt(B, y);
  const lA = Math.max(len(gA), 1e-12), lB = Math.max(len(gB), 1e-12);
  return [
    MEET * quadricAt(A, x) / lA,
    MEET * quadricAt(B, y) / lB,
    ...[0, 1, 2].map((i) => gA[i] / lA - s * gB[i] / lB),
  ];
}

const cost = (r) => r.reduce((sum, v) => sum + v * v, 0);

// Solve the 4x4 system M d = b (Gaussian elimination, partial pivoting).
function solve4(M, b) {
  const a = M.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    if (Math.abs(a[c][c]) < 1e-300) return null;
    for (let r = c + 1; r < 4; r++) {
      const f = a[r][c] / a[c][c];
      for (let k = c; k < 5; k++) a[r][k] -= f * a[c][k];
    }
  }
  const d = [0, 0, 0, 0];
  for (let r = 3; r >= 0; r--) {
    let v = a[r][4];
    for (let k = r + 1; k < 4; k++) v -= a[r][k] * d[k];
    d[r] = v / a[r][r];
  }
  return d;
}

// Levenberg-Marquardt from z, with t held where it is if `fixT`.
function minimise(A, B, u, s, z, scale, fixT = false) {
  let r = residual(A, B, u, s, z), c = cost(r), mu = 1e-3;
  for (let iter = 0; iter < 200 && c > 1e-26; iter++) {
    // A numeric Jacobian, central differences.
    const J = r.map(() => [0, 0, 0, 0]);
    for (let k = 0; k < 4; k++) {
      if (fixT && k === 3) continue;
      const h = 1e-7 * (Math.abs(z[k]) + scale);
      const zp = z.slice(), zm = z.slice();
      zp[k] += h; zm[k] -= h;
      const rp = residual(A, B, u, s, zp), rm = residual(A, B, u, s, zm);
      for (let i = 0; i < r.length; i++) J[i][k] = (rp[i] - rm[i]) / (2 * h);
    }
    const JtJ = [0, 1, 2, 3].map((a) => [0, 1, 2, 3].map((b) => J.reduce((sum, row) => sum + row[a] * row[b], 0)));
    const Jtr = [0, 1, 2, 3].map((a) => J.reduce((sum, row, i) => sum + row[a] * r[i], 0));
    let moved = false;
    for (let tries = 0; tries < 20; tries++) {
      const M = JtJ.map((row, i) => row.map((v, j) => v + (i === j ? mu * (JtJ[i][i] + 1e-12) : 0)));
      const d = solve4(M, Jtr.map((v) => -v));
      if (!d) { mu *= 10; continue; }
      if (fixT) d[3] = 0;
      const zn = z.map((v, k) => v + d[k]);
      const rn = residual(A, B, u, s, zn), cn = cost(rn);
      if (cn < c) {
        const step = Math.hypot(...d);
        z = zn; r = rn; c = cn; mu = Math.max(mu / 3, 1e-12); moved = true;
        if (step < 1e-15 * scale) iter = Infinity;
        break;
      }
      mu *= 4;
    }
    if (!moved) break;
  }
  return { z, r, c };
}

// The real roots of f(l) = 0, f quadratic in l (a quadric along a line), from
// three values of it.
function quadraticRoots(f) {
  const f0 = f(0), f1 = f(1), fm = f(-1);
  const a = (f1 + fm) / 2 - f0, b = (f1 - fm) / 2, c = f0;
  if (Math.abs(a) < 1e-14 * (Math.abs(b) + Math.abs(c) + 1e-300)) return Math.abs(b) > 0 ? [-c / b] : [];
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const q = -0.5 * (b + Math.sign(b || 1) * Math.sqrt(disc));
  return [q / a, ...(q !== 0 ? [c / q] : [])];
}

// Every direction to a neighbour on a cube's lattice: 26.
const DIRECTIONS = [];
for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
  if (x || y || z) { const l = Math.hypot(x, y, z); DIRECTIONS.push([x / l, y / l, z / l]); }
}

// Where to start: points that are on both surfaces already, some slide t
// apart - rays from each anchor onto its own surface, then along u to the
// other's. (Not the anchors themselves: an axis, a centre or an apex is
// where a gradient vanishes, and a normal means nothing.)
function startsFor(A, B, u, aA, aB, scale) {
  const starts = [];
  for (const d of DIRECTIONS) {
    for (const l of quadraticRoots((l) => quadricAt(A, aA.map((v, i) => v + l * d[i])))) {
      if (!(Math.abs(l) < 1e4 * scale)) continue;
      const x = aA.map((v, i) => v + l * d[i]);
      for (const t of quadraticRoots((t) => quadricAt(B, x.map((v, i) => v - t * u[i])))) {
        if (Math.abs(t) < 1e4 * scale) starts.push([...x, t]);
      }
    }
    for (const l of quadraticRoots((l) => quadricAt(B, aB.map((v, i) => v + l * d[i])))) {
      if (!(Math.abs(l) < 1e4 * scale)) continue;
      const y = aB.map((v, i) => v + l * d[i]);
      for (const t of quadraticRoots((t) => quadricAt(A, y.map((v, i) => v + t * u[i])))) {
        if (Math.abs(t) < 1e4 * scale) starts.push([...y.map((v, i) => v + t * u[i]), t]);
      }
    }
  }
  return starts;
}

/**
 * Slide B along u until it sits tangent to A: { t, angle, exact } - how far
 * along u, and how far apart the normals are left (radians), or { warn }.
 * `facing` is 'flush' or 'touching'; `anchors` are points near each
 * surface (antisphere-scene.js's anchorOf()), to start from.
 */
export function tangentSlide(A, B, u, { facing = 'flush', anchors = [] } = {}) {
  const s = facing === 'touching' ? -1 : 1;
  const ul = len(u);
  u = u.map((v) => v / ul);
  const [aA, aB] = anchors;
  const scale = Math.max(1e-3, len(sub(aA, aB)), 1);
  // B the same all along u (a cylinder along its own axis, a plane across
  // its normal): sliding it changes nothing.
  const probes = DIRECTIONS.slice(0, 8).map((d) => aB.map((v, i) => v + scale * d[i]));
  if (probes.every((y) => Math.abs(dot(gradientAt(B, y), u)) < 1e-9 * (1 + len(gradientAt(B, y))))) {
    return { warn: 'sliding along this axis changes nothing' };
  }
  const starts = startsFor(A, B, u, aA, aB, scale);
  if (!starts.length) return { warn: 'they never meet sliding along this axis' };
  // Starts with t nearest 0 first; at most 60 of them.
  starts.sort((a, b) => Math.abs(a[3]) - Math.abs(b[3]));
  const results = starts.slice(0, 60).map((z) => minimise(A, B, u, s, z, scale));
  // Meeting: the point on both surfaces; then the normals' mismatch.
  const meets = (r) => Math.abs(r[0]) < MEET * 1e-7 * scale && Math.abs(r[1]) < MEET * 1e-7 * scale;
  const mismatch = (r) => Math.hypot(r[2], r[3], r[4]);
  // Not where a gradient (nearly) vanishes - an apex, an axis - where the
  // normal compared means nothing.
  const sharp = (q, p) => len(gradientAt(q, p)) > 1e-6 * (len(q.linear) * 2 + 2 * Math.max(Math.abs(q.k_par), Math.abs(q.k_perp)) * scale);
  const regular = (x) => { const p = x.z.slice(0, 3); return sharp(A, p) && sharp(B, sub(p, u.map((v) => v * x.z[3]))); };
  const met = results.filter((x) => meets(x.r) && regular(x));
  if (!met.length) return { warn: 'they never meet sliding along this axis' };
  const exact = met.filter((x) => mismatch(x.r) < 1e-6);
  const angleOf = (m) => 2 * Math.asin(Math.min(1, m / 2));
  // Already tangent where it is (where a whole run of slides is - a flare
  // whose waist matches the tube anywhere along it): stay put.
  const here = startsFor(A, B, u, aA, aB, scale).map((z) => [z[0], z[1], z[2], 0]).slice(0, 30)
    .map((z) => minimise(A, B, u, s, z, scale, true))
    .filter((x) => meets(x.r) && regular(x));
  if (exact.length && here.some((x) => mismatch(x.r) < 1e-6)) return { t: 0, angle: 0, exact: true };
  if (exact.length) {
    const best = exact.reduce((a, b) => (Math.abs(b.z[3]) < Math.abs(a.z[3]) ? b : a));
    return { t: best.z[3], angle: angleOf(mismatch(best.r)), exact: true };
  }
  // Best effort - unless sliding makes no difference at all: the best
  // with t held at 0 is as good.
  const best = met.reduce((a, b) => (mismatch(b.r) < mismatch(a.r) ? b : a));
  const stillBest = here.length ? Math.min(...here.map((x) => mismatch(x.r))) : Infinity;
  if (stillBest - mismatch(best.r) < 1e-9) return { warn: 'sliding along this axis changes nothing' };
  return { t: best.z[3], angle: angleOf(mismatch(best.r)), exact: false };
}
