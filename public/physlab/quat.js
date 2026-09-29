// Quaternions, as [x, y, z, w] arrays, for orientations.
//
// A unit quaternion q turns a vector v by q v q*. Composition reads like
// matrices: multiply(a, b) turns by b first, then by a.

export const identity = () => [0, 0, 0, 1];

/** Turn by `radians` about `axis` (any length but zero), right-handed. */
export function fromAxisAngle(axis, radians) {
  const len = Math.hypot(...axis);
  const s = Math.sin(radians / 2) / len;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(radians / 2)];
}

/** a then b is multiply(b, a): the result turns by b first, then a. */
export function multiply(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function normalize(q) {
  const len = Math.hypot(...q) || 1;
  return q.map((v) => v / len);
}

/** v turned by q. */
export function rotate(q, v) {
  // v + 2w (u x v) + 2 u x (u x v), with u the vector part: q v q*
  // without building the quaternion products.
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** Where q sends the unit axes: the turned frame's own x, y and z, in world terms. */
export function axes(q) {
  return { x: rotate(q, [1, 0, 0]), y: rotate(q, [0, 1, 0]), z: rotate(q, [0, 0, 1]) };
}

/**
 * The rotation taking the unit axes to x, y and z, which must be
 * orthonormal and right-handed (x = y cross z). The inverse of axes().
 */
export function fromBasis(x, y, z) {
  // A left-handed or skewed frame is a mirror or a shear, which no rotation
  // is; better to say so than to return a nearby wrong answer.
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const det = x[0] * (y[1] * z[2] - y[2] * z[1]) - x[1] * (y[0] * z[2] - y[2] * z[0])
            + x[2] * (y[0] * z[1] - y[1] * z[0]);
  // Unit x and y, all square to each other and det 1 leave z unit too.
  if (Math.abs(det - 1) > 1e-6 || Math.abs(dot(x, x) - 1) > 1e-6 || Math.abs(dot(y, y) - 1) > 1e-6 ||
      Math.abs(dot(x, y)) > 1e-6 || Math.abs(dot(y, z)) > 1e-6 || Math.abs(dot(z, x)) > 1e-6) {
    throw new Error('fromBasis needs orthonormal, right-handed axes (x = y cross z)');
  }
  // The rotation matrix has x, y, z as its columns; this is the usual
  // conversion, branching on the largest diagonal term to stay accurate.
  const [m00, m10, m20] = x, [m01, m11, m21] = y, [m02, m12, m22] = z;
  const trace = m00 + m11 + m22;
  let q;
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  return normalize(q);
}

/** The same turn as an axis and an angle: { axis, radians }, radians in [0, pi]. */
export function toAxisAngle(q) {
  let [x, y, z, w] = normalize(q);
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }       // the shorter way round
  const s = Math.hypot(x, y, z);
  if (s < 1e-12) return { axis: [0, 0, 1], radians: 0 };
  return { axis: [x / s, y / s, z / s], radians: 2 * Math.atan2(s, w) };
}
