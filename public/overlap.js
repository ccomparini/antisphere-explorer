// Do two regions share any interior?
//
// A node divides space with H(R) < 0 on one side, so a region is one node and
// a sign: sigma * H(R) < 0, with sigma = +1 for a node's inside and -1 for its
// outside. Asking whether two such regions meet is asking whether
//
//     sigma_a H_a(R) < 0   and   sigma_b H_b(R) < 0
//
// has a solution. Writing each as a 4x4 homogeneous matrix - H(R) = X^T Q X
// with X = (R, 1) - the answer has a certificate:
//
//     the two interiors are disjoint  <=>  exists mu >= 0 with Q_b + mu Q_a
//     positive semidefinite
//
// If such a mu exists then H_b + mu H_a >= 0 everywhere, and wherever H_a <= 0
// the second term is <= 0, so H_b >= 0 there: no point is inside both. The
// sign of mu is the whole trick; Q_b - mu Q_a proves nothing.
//
// This is the S-procedure, and for *two* quadratics it needs no convexity -
// which is why cones, hyperboloids and complements are handled like anything
// else, where a convex method would have to give up on them. For three or
// more constraints at once it is only sufficient: it can fail to find a
// certificate that exists, but it never certifies an overlap as disjoint. That
// is the safe direction for both pruning and the group check.
//
// Two facts make the search for mu easy. The positive semidefinite matrices
// are a convex set and the pencil Q_b + mu Q_a is a line through matrix space,
// so the feasible mu form an interval; and lambda_min of a symmetric matrix is
// a minimum of linear functions, hence concave in mu. Maximising a concave
// function of one variable is a ternary search.
//
// antisphere-raycast.wgsl's overlapFrom() is a transcription of this file.
// Keep them in step: the JS is the oracle the shader is checked against.

const CERTAIN = 1e-9;          // a margin this small is a touch, not an overlap

/** The 4x4 homogeneous matrix of a primitive, times a sign. */
export function matrixOf(prim, sign = 1) {
  const dk = prim.k_par - prim.k_perp;
  const n = prim.axis, c = prim.linear;
  const m = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      m[i][j] = sign * ((i === j ? prim.k_perp : 0) + dk * n[i] * n[j]);
    }
    m[i][3] = m[3][i] = sign * c[i];
  }
  m[3][3] = sign * prim.constant;
  return m;
}

/** The largest absolute entry, for scaling a matrix to a comparable size. */
function magnitude(m) {
  let most = 0;
  for (const row of m) for (const v of row) most = Math.max(most, Math.abs(v));
  return most || 1;
}

/**
 * The smallest eigenvalue of a symmetric 4x4.
 *
 * Newton from below on the characteristic polynomial. Left of the smallest
 * root the polynomial is positive, decreasing and convex - every factor
 * (lambda - lambda_i) is negative there, so the product of any two is
 * positive - which makes Newton from a point below all the roots converge
 * upward, monotonically, with no case analysis. Gershgorin supplies that
 * starting point.
 */
export function smallestEigenvalue(m) {
  // Characteristic polynomial lambda^4 - e1 lambda^3 + e2 lambda^2 - e3 lambda
  // + e4, whose coefficients are the sums of the principal minors.
  const e1 = m[0][0] + m[1][1] + m[2][2] + m[3][3];
  const minor2 = (i, j) => m[i][i] * m[j][j] - m[i][j] * m[j][i];
  const e2 = minor2(0,1) + minor2(0,2) + minor2(0,3) + minor2(1,2) + minor2(1,3) + minor2(2,3);
  const minor3 = (i, j, k) =>
      m[i][i] * (m[j][j] * m[k][k] - m[j][k] * m[k][j])
    - m[i][j] * (m[j][i] * m[k][k] - m[j][k] * m[k][i])
    + m[i][k] * (m[j][i] * m[k][j] - m[j][j] * m[k][i]);
  const e3 = minor3(0,1,2) + minor3(0,1,3) + minor3(0,2,3) + minor3(1,2,3);
  const e4 = determinant4(m);

  // Gershgorin: no eigenvalue is below this.
  let start = Infinity;
  for (let i = 0; i < 4; i++) {
    let radius = 0;
    for (let j = 0; j < 4; j++) if (j !== i) radius += Math.abs(m[i][j]);
    start = Math.min(start, m[i][i] - radius);
  }

  let x = start;
  for (let step = 0; step < 40; step++) {
    const p = (((x - e1) * x + e2) * x - e3) * x + e4;
    const dp = ((4 * x - 3 * e1) * x + 2 * e2) * x - e3;
    if (dp === 0) break;
    const next = x - p / dp;
    if (!(next > x)) break;                   // converged, or numerically stuck
    x = next;
  }
  return x;
}

function determinant4(m) {
  // Expansion by the first row, with the 3x3 minors written out.
  const sub = (r0, r1, r2, c0, c1, c2) =>
      m[r0][c0] * (m[r1][c1] * m[r2][c2] - m[r1][c2] * m[r2][c1])
    - m[r0][c1] * (m[r1][c0] * m[r2][c2] - m[r1][c2] * m[r2][c0])
    + m[r0][c2] * (m[r1][c0] * m[r2][c1] - m[r1][c1] * m[r2][c0]);
  return m[0][0] * sub(1,2,3, 1,2,3)
       - m[0][1] * sub(1,2,3, 0,2,3)
       + m[0][2] * sub(1,2,3, 0,1,3)
       - m[0][3] * sub(1,2,3, 0,1,2);
}

/**
 * How far the best certificate is from proving the two regions disjoint.
 *
 * Positive means proved disjoint, and the size is how much room the proof has;
 * zero means they touch; negative means no certificate was found, which for
 * two regions means they really do share interior. The multiplier that did it
 * comes back as well, since it is the proof.
 */
export function separation(qa, qb, steps = 48) {
  const a = qa.map((row) => row.map((v) => v / magnitude(qa)));
  const b = qb.map((row) => row.map((v) => v / magnitude(qb)));

  // mu runs over [0, infinity), so search t in [0, 1) and map it.
  const marginAt = (t) => {
    const mu = t / (1 - t);
    const pencil = b.map((row, i) => row.map((v, j) => v + mu * a[i][j]));
    return smallestEigenvalue(pencil) / Math.max(1, magnitude(pencil));
  };

  let lo = 0, hi = 1 - 1e-7;
  for (let i = 0; i < steps; i++) {
    const third = (hi - lo) / 3;
    if (marginAt(lo + third) < marginAt(hi - third)) lo += third; else hi -= third;
  }
  const t = 0.5 * (lo + hi);
  return { margin: marginAt(t), mu: t / (1 - t) };
}

/** Do these two regions share interior? A region is a primitive and a sign. */
export function regionsOverlap(primA, signA, primB, signB) {
  return separation(matrixOf(primA, signA), matrixOf(primB, signB)).margin < -CERTAIN;
}

/** Proved apart, with room to spare. Touching counts as apart. */
export function regionsDisjoint(primA, signA, primB, signB) {
  return separation(matrixOf(primA, signA), matrixOf(primB, signB)).margin > -CERTAIN;
}

// ---------------------------------------------------------------------------
// Whole subtrees
//
// A subtree's interior is the union of its root-to-interior-leaf paths, and
// each path is a conjunction of regions: "inside this node, outside that one,
// inside the next". Two subtrees therefore overlap only if some path of one
// and some path of the other can hold at once.
//
// Testing a pair of paths exactly would mean a feasibility question in many
// constraints at once, which the certificate above only answers one pair at a
// time. So the test here is conservative in the safe direction: if any single
// pair of constraints drawn from the two paths is provably disjoint, that pair
// of paths is empty. If every pair of paths is knocked out that way, the
// subtrees are proved apart; otherwise the answer is "may overlap".
// ---------------------------------------------------------------------------

/**
 * Every path to an interior leaf, as a list of { node, sign } constraints.
 * `solid` decides which leaves count as interior, since that is a question
 * about materials rather than geometry.
 */
export function interiorPaths(nodes, root, solid, limit = 4096) {
  const paths = [];
  const walk = (index, sign, carried) => {
    if (paths.length >= limit) return;
    if (index === 0) {
      // An absent child: inside, that is a region of this node's material.
      if (sign > 0 && carried.length && solid(carried[carried.length - 1].node)) {
        paths.push(carried);
      }
      return;
    }
    const node = nodes[index];
    walk(node.inside, 1, [...carried, { node: index, sign: 1 }]);
    walk(node.outside, -1, [...carried, { node: index, sign: -1 }]);
  };
  // The root is entered from nowhere, so start with both of its sides.
  walk(root, 1, []);
  return paths;
}

/**
 * Are these two subtrees provably apart?
 *
 * Each side brings its own paths and its own way of looking up a node's
 * primitive, because the two are compiled separately - the paths *within* one
 * tree already partition space, so comparing a tree against itself would
 * always say "apart" and mean nothing.
 *
 * Returns { apart, tested }. `apart` false means "may overlap", never
 * "definitely overlaps", except where both paths are single constraints, in
 * which case the certificate is exact.
 */
export function subtreesApart(pathsA, primsA, pathsB, primsB) {
  let tested = 0;
  for (const a of pathsA) {
    for (const b of pathsB) {
      let knockedOut = false;
      for (const ca of a) {
        for (const cb of b) {
          tested++;
          if (regionsDisjoint(primsA(ca.node), ca.sign, primsB(cb.node), cb.sign)) {
            knockedOut = true;
            break;
          }
        }
        if (knockedOut) break;
      }
      if (!knockedOut) return { apart: false, tested };
    }
  }
  return { apart: true, tested };
}
