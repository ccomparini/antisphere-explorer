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
// The search runs over the convex combination P(t) = (1 - t) Q_b + t Q_a,
// t in [0, 1), which is the same pencil (mu = t / (1 - t)) but bounded, so it
// needs no rescaling as it goes. lambda_min of P(t) is a minimum of linear
// functions of t, hence concave, and for any unit eigenvector v of that
// smallest eigenvalue, v^T (Q_a - Q_b) v is a supergradient - valid even when
// the eigenvalue is repeated. So the maximum is found by bisecting on the
// sign of that one number: one eigen-solve per step.
//
// The same eigenvector answers the other way too. v^T P v = lambda, and if
// both v^T Q_a v < 0 and v^T Q_b v < 0 then X = v, or a point next to it if
// v's last coordinate is zero, is interior to both regions: an overlap,
// proved on the spot. Deciding pairs is therefore usually quick: far apart,
// some early t gives lambda > 0; deeply overlapping, some early eigenvector
// is a witness. Only near-touching pairs run the whole bisection.
//
// shaders/overlap.wgsls's overlapFrom() is a transcription of this file.
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
 * The smallest eigenvalue of a symmetric 4x4, and a unit eigenvector for it.
 *
 * Cyclic Jacobi: rotate away each off-diagonal entry in turn until the matrix
 * is diagonal, accumulating the rotations as the eigenvectors. Every step is
 * an orthogonal similarity, so the eigenvalues come out accurate to rounding
 * relative to the matrix's size, repeated or not. (The characteristic
 * polynomial this replaced lost most of its digits to cancellation near a
 * repeated eigenvalue, and in f32 on a GPU that made a false proof.) For 4x4
 * a handful of sweeps is enough; convergence is quadratic.
 */
export function smallestEigen(m, sweeps = 10) {
  const a = m.map((row) => row.slice());
  const v = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] * a[p][q];
    if (off < 1e-60) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 4; q++) {
        const apq = a[p][q];
        // Negligible next to the diagonal: rotating it away changes nothing
        // but would square a huge theta below.
        if (Math.abs(apq) <= 1e-12 * (Math.abs(a[p][p]) + Math.abs(a[q][q])) ||
            Math.abs(apq) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * apq);
        const t = (theta < 0 ? -1 : 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let r = 0; r < 4; r++) {              // columns p and q
          const arp = a[r][p], arq = a[r][q];
          a[r][p] = c * arp - s * arq;
          a[r][q] = s * arp + c * arq;
        }
        for (let r = 0; r < 4; r++) {              // then rows p and q
          const apr = a[p][r], aqr = a[q][r];
          a[p][r] = c * apr - s * aqr;
          a[q][r] = s * apr + c * aqr;
        }
        for (let r = 0; r < 4; r++) {              // and the eigenvectors
          const vrp = v[r][p], vrq = v[r][q];
          v[r][p] = c * vrp - s * vrq;
          v[r][q] = s * vrp + c * vrq;
        }
      }
    }
  }
  let k = 0;
  for (let i = 1; i < 4; i++) if (a[i][i] < a[k][k]) k = i;
  return { value: a[k][k], vector: [v[0][k], v[1][k], v[2][k], v[3][k]] };
}

export const smallestEigenvalue = (m) => smallestEigen(m).value;

/** x^T M x. */
function quadratic(m, x) {
  let sum = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) sum += x[i] * m[i][j] * x[j];
  return sum;
}

/**
 * How far the best certificate is from proving the two regions disjoint.
 *
 * Positive means proved disjoint, and the size is how much room the proof has;
 * zero means they touch; negative means no certificate was found, which for
 * two regions means they really do share interior. The multiplier that did it
 * comes back as well, since it is the proof, and `witness` says whether an
 * overlap was proved outright by a point interior to both.
 *
 * With `decide`, stop as soon as the verdict is certain either way - apart
 * or witnessed - which is what callers that only want a yes or no should use.
 * The margin is then a margin that settles it, not necessarily the best one.
 */
export function separation(qa, qb, { steps = 32, decide = false } = {}) {
  const a = qa.map((row) => row.map((v) => v / magnitude(qa)));
  const b = qb.map((row) => row.map((v) => v / magnitude(qb)));

  let lo = 0, hi = 1;
  let margin = -Infinity, bestT = 0, witness = false;
  for (let i = 0; i < steps; i++) {
    const t = 0.5 * (lo + hi);
    const pencil = b.map((row, r) => row.map((v, c) => (1 - t) * v + t * a[r][c]));
    const { value, vector } = smallestEigen(pencil);
    if (value > margin) { margin = value; bestT = t; }
    const onA = quadratic(a, vector), onB = quadratic(b, vector);
    if (onA < -CERTAIN && onB < -CERTAIN) {
      witness = true;
      // Report the lambda that came with the witness, which is below
      // -CERTAIN, rather than a better one from earlier in the search.
      if (decide) { margin = value; bestT = t; break; }
    }
    if (decide && margin > CERTAIN) break;
    if (onA > onB) lo = t; else hi = t;           // the supergradient's sign
  }
  return { margin, mu: bestT / (1 - bestT), witness };
}

/** Do these two regions share interior? A region is a primitive and a sign. */
export function regionsOverlap(primA, signA, primB, signB) {
  return separation(matrixOf(primA, signA), matrixOf(primB, signB), { decide: true })
    .margin < -CERTAIN;
}

/**
 * A matrix re-expressed in a frame at centre `c` with unit length `L`:
 * with R = c + L R', X = T X' for T = [L I, c; 0, 1], and H is X'^T T^T Q T X'.
 * A congruence, applied to both regions alike, keeps any certificate a
 * certificate (T^T (Q_b + mu Q_a) T is PSD exactly when the pencil is).
 */
export function inFrame(m, { c, L }) {
  const t = [[L, 0, 0, c[0]], [0, L, 0, c[1]], [0, 0, L, c[2]], [0, 0, 0, 1]];
  const mt = m.map((row) => [0, 1, 2, 3].map((j) => row.reduce((s, v, k) => s + v * t[k][j], 0)));
  return [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => t.reduce((s, row, k) => s + row[i] * mt[k][j], 0)));
}

/**
 * Proved apart, with room to spare. Touching counts as apart.
 *
 * `frame` ({ c, L }), if given, is where to measure: a centre and a length
 * near the smaller of the two. Far from the origin, or at very different
 * sizes, scaling each matrix by its largest entry leaves the pencil's
 * eigenvalues tiny - a 500 m planet's outside and a 2 m ball sitting in it
 * read a margin of -8e-11, which passed for touching (CERTAIN), and so for
 * disjoint. In the smaller one's own frame the same overlap reads clearly.
 */
export function regionsDisjoint(primA, signA, primB, signB, frame = null) {
  let qa = matrixOf(primA, signA), qb = matrixOf(primB, signB);
  if (frame) { qa = inFrame(qa, frame); qb = inFrame(qb, frame); }
  return separation(qa, qb, { decide: true }).margin > -CERTAIN;
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
