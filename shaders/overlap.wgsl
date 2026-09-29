// Overlap queries on the GPU: do two regions of the scene share interior?
//
// Its own shader, since it shares nothing with rendering but the nodes.
// Bindings: nodes, then the queries and their results.

#import "node.wgsl"

@group(0) @binding(0) var<storage, read> nodes : array<Node>;
// ---------------------------------------------------------------------------
// Overlap queries
//
// Do two regions share any interior? A region is a node and a sign: the
// inside of a node (sigma = +1) or its outside (sigma = -1), so the question
// is whether sigma_a H_a(R) < 0 and sigma_b H_b(R) < 0 can hold at once.
//
// Writing each as its 4x4 homogeneous matrix Q - H(R) = X^T Q X with
// X = (R, 1) - the answer has a certificate:
//
//   the interiors are disjoint  <=>  there is a mu >= 0 with Q_b + mu Q_a
//   positive semidefinite
//
// because then H_b + mu H_a >= 0 everywhere, and wherever H_a <= 0 the second
// term is <= 0, leaving H_b >= 0 there. This is the S-procedure, exact for
// two quadratics with no convexity needed, which is why cones, hyperboloids
// and complements are no harder here than spheres.
//
// Finding mu is a one-dimensional problem. Over the convex combination
// (1 - t) Q_b + t Q_a (mu = t / (1 - t)) the smallest eigenvalue is concave
// in t, and v^T (Q_a - Q_b) v, for its eigenvector v, is a supergradient: so
// bisect on that sign, one eigen-solve a step. The eigenvector also settles
// overlaps early: if v^T Q_a v and v^T Q_b v are both negative, v is (next
// to) a point interior to both.
//
// This always stops as soon as the answer is certain either way, since the
// callers want a verdict fast: margin > OVERLAP_TAU is proved apart,
// margin < -OVERLAP_TAU is an overlap, and in between is touching, to f32.
//
// overlap.js is the same algorithm in JS (its `decide` mode), and is the
// oracle this is checked against; keep the two in step.
// ---------------------------------------------------------------------------

struct OverlapQuery {
  node_a  : u32,
  node_b  : u32,
  sign_a  : f32,   // +1 for the node's inside, -1 for its outside
  sign_b  : f32,
};

struct OverlapResult {
  margin : f32,    // > 0 proved apart, ~0 touching, < 0 no certificate
  mu     : f32,    // the multiplier that proved it
};

@group(0) @binding(1) var<storage, read> overlapQueries : array<OverlapQuery>;
@group(0) @binding(2) var<storage, read_write> overlapResults : array<OverlapResult>;

// The homogeneous matrix of a node's region, as four columns.
fn regionMatrix(nd : Node, sign : f32) -> mat4x4<f32> {
  let c = 0.5 * nd.linear;                    // the node stores 2c
  let n = nd.axis;
  let dk = nd.curvature_delta;
  let k = nd.curvature_perp;
  let K0 = vec3<f32>(k + dk * n.x * n.x, dk * n.x * n.y, dk * n.x * n.z);
  let K1 = vec3<f32>(dk * n.y * n.x, k + dk * n.y * n.y, dk * n.y * n.z);
  let K2 = vec3<f32>(dk * n.z * n.x, dk * n.z * n.y, k + dk * n.z * n.z);
  return mat4x4<f32>(
    sign * vec4<f32>(K0, c.x),
    sign * vec4<f32>(K1, c.y),
    sign * vec4<f32>(K2, c.z),
    sign * vec4<f32>(c, nd.const_term));
}

fn largestEntry(m : mat4x4<f32>) -> f32 {
  var most = 0.0;
  for (var i = 0; i < 4; i = i + 1) {
    most = max(most, max(max(abs(m[i].x), abs(m[i].y)), max(abs(m[i].z), abs(m[i].w))));
  }
  return max(most, 1e-30);
}

// The smallest eigenvalue of a symmetric 4x4 and a unit eigenvector for it,
// by cyclic Jacobi: rotate each off-diagonal entry away in turn, accumulating
// the rotations as the eigenvectors. Orthogonal steps keep it accurate to f32
// rounding, repeated eigenvalues included. (The characteristic polynomial it
// replaced lost most of its digits near a repeated root and made false
// proofs.) A fixed sweep count, so every invocation does the same work.
struct Eigen {
  value  : f32,
  vector : vec4<f32>,
};

const JACOBI_SWEEPS : i32 = 5;

// One Jacobi rotation, zeroing a[q][p]. Always called with literal p and q
// (see smallestEigen), so once inlined every index here is a constant and
// both matrices can live in registers: indexing a local matrix by a runtime
// value pushes it out to scratch memory, which cost more than all the maths.
fn jacobiRotate(a : ptr<function, mat4x4<f32>>, v : ptr<function, mat4x4<f32>>,
                p : i32, q : i32) {
  let apq = (*a)[q][p];
  let app = (*a)[p][p];
  let aqq = (*a)[q][q];
  // Negligible next to the diagonal: skip, which also keeps theta (and theta
  // squared) finite below.
  if (abs(apq) <= 1e-12 * (abs(app) + abs(aqq)) || abs(apq) < 1e-30) { return; }
  let theta = (aqq - app) / (2.0 * apq);
  let t = select(1.0, -1.0, theta < 0.0) / (abs(theta) + sqrt(theta * theta + 1.0));
  let c = inverseSqrt(t * t + 1.0);
  let s = t * c;
  // Columns p and q, as whole vectors: (*a)[i] is column i.
  let colP = (*a)[p];
  let colQ = (*a)[q];
  (*a)[p] = c * colP - s * colQ;
  (*a)[q] = s * colP + c * colQ;
  // Then rows p and q; the matrix is symmetric again afterwards, with the
  // (p, q) entry exactly zero.
  for (var r = 0; r < 4; r = r + 1) {
    let apr = (*a)[r][p];
    let aqr = (*a)[r][q];
    (*a)[r][p] = c * apr - s * aqr;
    (*a)[r][q] = s * apr + c * aqr;
  }
  // And the eigenvectors, which are v's columns.
  let vP = (*v)[p];
  let vQ = (*v)[q];
  (*v)[p] = c * vP - s * vQ;
  (*v)[q] = s * vP + c * vQ;
}

fn smallestEigen(m : mat4x4<f32>) -> Eigen {
  var a = m;
  var v = mat4x4<f32>(vec4<f32>(1.0, 0.0, 0.0, 0.0), vec4<f32>(0.0, 1.0, 0.0, 0.0),
                      vec4<f32>(0.0, 0.0, 1.0, 0.0), vec4<f32>(0.0, 0.0, 0.0, 1.0));
  for (var sweep = 0; sweep < JACOBI_SWEEPS; sweep = sweep + 1) {
    jacobiRotate(&a, &v, 0, 1);
    jacobiRotate(&a, &v, 0, 2);
    jacobiRotate(&a, &v, 0, 3);
    jacobiRotate(&a, &v, 1, 2);
    jacobiRotate(&a, &v, 1, 3);
    jacobiRotate(&a, &v, 2, 3);
  }
  // The smallest diagonal entry, without indexing by a runtime value.
  var e = Eigen(a[0][0], v[0]);
  if (a[1][1] < e.value) { e = Eigen(a[1][1], v[1]); }
  if (a[2][2] < e.value) { e = Eigen(a[2][2], v[2]); }
  if (a[3][3] < e.value) { e = Eigen(a[3][3], v[3]); }
  return e;
}

const OVERLAP_STEPS : i32 = 24;
const OVERLAP_TAU : f32 = 1e-5;   // f32 Jacobi is good to about 1e-6 here

// The margin that settles the question: > OVERLAP_TAU proved apart,
// < -OVERLAP_TAU an overlap, between them touching.
fn overlapMargin(qa : mat4x4<f32>, qb : mat4x4<f32>, muOut : ptr<function, f32>) -> f32 {
  let a = qa * (1.0 / largestEntry(qa));
  let b = qb * (1.0 / largestEntry(qb));

  var lo = 0.0;
  var hi = 1.0;
  var margin = -1e30;
  var bestT = 0.0;
  for (var i = 0; i < OVERLAP_STEPS; i = i + 1) {
    let t = 0.5 * (lo + hi);
    let e = smallestEigen(b * (1.0 - t) + a * t);
    if (e.value > margin) { margin = e.value; bestT = t; }
    let onA = dot(e.vector, a * e.vector);
    let onB = dot(e.vector, b * e.vector);
    if (onA < -OVERLAP_TAU && onB < -OVERLAP_TAU) {
      margin = e.value;                       // a witness: this lambda is < -TAU
      bestT = t;
      break;
    }
    if (margin > OVERLAP_TAU) { break; }      // a certificate
    if (onA > onB) { lo = t; } else { hi = t; }
  }
  *muOut = bestT / (1.0 - bestT);
  return margin;
}

@compute @workgroup_size(64)
fn overlapFrom(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&overlapQueries)) { return; }
  let q = overlapQueries[i];
  var mu = 0.0;
  let margin = overlapMargin(regionMatrix(nodes[q.node_a], q.sign_a),
                             regionMatrix(nodes[q.node_b], q.sign_b),
                             &mu);
  overlapResults[i] = OverlapResult(margin, mu);
}
