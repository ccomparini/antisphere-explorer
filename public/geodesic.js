// The geodesic texel mapping (Chris's, from exoplanet-maker): a spherical
// texture's texels sit on the vertices of a subdivided icosahedron - level
// L has 10 * 4^L + 2 of them, evenly spread, with no poles and no seams.
//
// Each of the 20 faces, subdivided L times, holds its vertices on a
// triangular lattice: n = 2^L intervals along each edge, vertex (i, j) with
// i + j <= n. The face with corners A, B, C has (0, 0) at A, (n, 0) at B and
// (0, n) at C, and every other vertex where halving the triangle L times,
// each midpoint pushed out onto the unit sphere, puts it.
//
// A direction is found among them as the shader finds it (locate()): the
// best of the 20 faces, then L halvings, each keeping the one of four
// children the direction is most inside, by great-circle side tests - no
// trigonometry. Its colour is then the barycentric mix of the leaf's three
// corner texels. The shader's geodesicLocate() is this, step for step; its
// texels, for now, are made from each vertex's direction (the spherical
// patterns), not stored.

const T = (1 + Math.sqrt(5)) / 2;
const normalize = ([x, y, z]) => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; };

/** The icosahedron's 12 vertices, unit length, as exoplanet-maker has them. */
export const ICO_VERTS = [
  [-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0],
  [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T],
  [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1],
].map(normalize);

/** Its 20 faces, as vertex indices, corners A, B, C, in exoplanet-maker's order. */
export const ICO_FACES = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// A midpoint pushed onto the sphere: as the shader works it, in the same
// order, so both put a vertex in the same place.
const mid = (a, b) => normalize([(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5]);
// How far inside the spherical triangle a, b, c direction d is: the least of
// its three side tests (positive inside).
const inside = (d, a, b, c) => Math.min(dot(d, cross(a, b)), dot(d, cross(b, c)), dot(d, cross(c, a)));

// A triangle's four children, as [corner indices into (A, B, C, mAB, mBC,
// mCA)]: 0 at A, 1 at B, 2 at C, 3 the middle - exoplanet-maker's order.
const CHILDREN = [[0, 3, 5], [1, 4, 3], [2, 5, 4], [3, 4, 5]];

/** Lattice intervals along an edge at level L. */
export const span = (level) => 1 << level;

/**
 * Where direction `dir` (unit, or any length) falls at `level`: { face,
 * corners: the leaf's three corners as lattice [i, j], directions: their
 * unit directions, barycentric: [u, v, w] over them } - planar barycentrics
 * on the leaf's flat chord triangle, each 0 to 1, summing to 1.
 */
export function locate(dir, level) {
  const d = normalize(dir);
  let face = 0, best = -Infinity;
  ICO_FACES.forEach(([a, b, c], f) => {
    const s = inside(d, ICO_VERTS[a], ICO_VERTS[b], ICO_VERTS[c]);
    if (s > best) { best = s; face = f; }
  });
  const n = span(level);
  let P = ICO_FACES[face].map((v) => ICO_VERTS[v]);
  let L = [[0, 0], [n, 0], [0, n]];
  for (let k = 0; k < level; k++) {
    const six = [...P, mid(P[0], P[1]), mid(P[1], P[2]), mid(P[2], P[0])];
    const lat = [...L, ...[[0, 1], [1, 2], [2, 0]].map(([x, y]) => [(L[x][0] + L[y][0]) / 2, (L[x][1] + L[y][1]) / 2])];
    let child = 0, score = -Infinity;
    CHILDREN.forEach((c, i) => {
      const s = inside(d, six[c[0]], six[c[1]], six[c[2]]);
      if (s > score) { score = s; child = i; }
    });
    P = CHILDREN[child].map((i) => six[i]);
    L = CHILDREN[child].map((i) => lat[i]);
  }
  return { face, corners: L, directions: P, barycentric: barycentric(d, P) };
}

// Planar barycentrics of d on the chord triangle a, b, c: where the line
// from the origin along d meets its plane, clamped into the triangle.
function barycentric(d, [a, b, c]) {
  const n = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
  const t = dot(n, a) / dot(n, d);
  const p = d.map((v) => v * t);
  const v0 = b.map((v, i) => v - a[i]), v1 = c.map((v, i) => v - a[i]), v2 = p.map((v, i) => v - a[i]);
  const d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1);
  const den = d00 * d11 - d01 * d01;
  let v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
  v = Math.max(0, v); w = Math.max(0, w);
  const sum = v + w;
  if (sum > 1) { v /= sum; w /= sum; }
  return [1 - v - w, v, w];
}

/**
 * The unit direction of lattice vertex (i, j) of face `face` at `level`: by
 * the same halvings as locate(), each midpoint as the shader works it, so a
 * vertex shared by two faces (an edge's or a corner's) comes out the same
 * from either.
 */
export function vertexDirection(face, i, j, level) {
  const n = span(level);
  if (i < 0 || j < 0 || i + j > n) throw new Error(`vertex (${i}, ${j}) isn't on face ${face}'s lattice at level ${level}`);
  let P = ICO_FACES[face].map((v) => ICO_VERTS[v]);
  let L = [[0, 0], [n, 0], [0, n]];
  for (let k = 0; k < level; k++) {
    for (let c = 0; c < 3; c++) if (L[c][0] === i && L[c][1] === j) return P[c];
    const six = [...P, mid(P[0], P[1]), mid(P[1], P[2]), mid(P[2], P[0])];
    const lat = [...L, ...[[0, 1], [1, 2], [2, 0]].map(([x, y]) => [(L[x][0] + L[y][0]) / 2, (L[x][1] + L[y][1]) / 2])];
    // The child whose lattice triangle holds (i, j).
    const holds = (c) => {
      const [p, q, r] = c.map((x) => lat[x]);
      const side = (u, v) => (v[0] - u[0]) * (j - u[1]) - (v[1] - u[1]) * (i - u[0]);
      const s = [side(p, q), side(q, r), side(r, p)];
      return s.every((x) => x <= 0) || s.every((x) => x >= 0);
    };
    const child = CHILDREN.find(holds);
    P = child.map((x) => six[x]);
    L = child.map((x) => lat[x]);
  }
  const c = L.findIndex(([a, b]) => a === i && b === j);
  return P[c];
}
