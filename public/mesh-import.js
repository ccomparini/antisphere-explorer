// ---------------------------------------------------------------------------
// Mesh import
//
// A triangle mesh becomes a tree of plane nodes, by solid-leaf BSP.
//
// Take a triangle's own supporting plane as a node, put the triangles behind
// it on one side and those in front on the other, split whatever straddles,
// and recurse. For a closed mesh with outward normals, behind every face is
// inside it - so a branch that runs out of triangles behind a plane is
// solid, and one that runs out in front is void. That is exactly what this
// format means by an omitted "inside" and an omitted "outside", so the tree
// needs no leaf annotation at all.
//
// What this cannot do with nesting alone is a non-convex solid: nesting
// planes intersects half-spaces, which is always convex. Splitting is what
// handles concavity, and it is why an L-shaped prism comes out exact in
// eight nodes rather than as the box its faces have in common.
//
// A convex region, conversely, always comes out as a chain: no face plane of
// a convex solid divides its interior, so there is nothing to branch on.
// That is not a failure - it is what a convex solid is - and what matters
// there is how quickly a ray that misses can be turned away. Which is the
// other half of the idea: a face with nothing in front of it has a void
// outside, so it rejects every ray passing wide of it in one test. Taking
// those first, outermost first, is a bounding volume that costs no nodes of
// its own, because it is made of the model's own faces.
//
// The numbers are the hard part, not the structure. Splitting a triangle
// against a plane makes smaller triangles, splitting those makes smaller
// ones again, and a fixed epsilon eventually swallows the fragments: the
// geometry quietly goes missing and the model comes out hollow. Everything
// here is scaled to the model, and a fragment too small to matter is given
// whole to the side it is nearly on rather than cut into slivers.
// ---------------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
const length = (v) => Math.hypot(v[0], v[1], v[2]);

/** Twice the area of a triangle, which is what the cross product gives. */
const doubleArea = (tri) => length(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])));

/** The supporting plane of a triangle, normal pointing the way it faces. */
export function planeOfTriangle(tri) {
  const n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
  const len = length(n);
  if (len === 0) return null;                     // a degenerate triangle has none
  const normal = [n[0] / len, n[1] / len, n[2] / len];
  return { normal, offset: dot(normal, tri[0]) };
}

export function boundsOf(triangles) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const tri of triangles) {
    for (const v of tri) {
      for (let i = 0; i < 3; i++) {
        if (v[i] < lo[i]) lo[i] = v[i];
        if (v[i] > hi[i]) hi[i] = v[i];
      }
    }
  }
  return { lo, hi };
}

/** Eigenvectors of a symmetric 3x3 matrix, by Jacobi rotations. */
function eigenvectors(m) {
  const a = m.map((row) => row.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - sn * akq;
          a[k][q] = sn * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - sn * aqk;
          a[q][k] = sn * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - sn * vkq;
          v[k][q] = sn * vkp + c * vkq;
        }
      }
    }
  }
  return [0, 1, 2].map((j) => [v[0][j], v[1][j], v[2][j]]);
}

/**
 * A spheroid round a mesh's vertices, as a "spheroid" shape: { center,
 * axis, height, radius }. Tried about each principal axis of the vertices,
 * and as a sphere, and the least volume kept. About an axis, the centre is
 * the middle of the vertices' extent along it and across it, the shape is
 * that extent's, and it is grown until every vertex is inside.
 */
export function boundingSpheroid(triangles) {
  const points = triangles.flat();
  const n = points.length;
  const mean = [0, 1, 2].map((i) => points.reduce((sum, p) => sum + p[i], 0) / n);
  const cov = [0, 1, 2].map((i) => [0, 1, 2].map((j) =>
    points.reduce((sum, p) => sum + (p[i] - mean[i]) * (p[j] - mean[j]), 0) / n));
  const axes = eigenvectors(cov);

  let best = null;
  const keep = (center, axis, height, radius) => {
    const volume = height * radius * radius;
    if (!best || volume < best.volume) best = { volume, center, axis, height, radius };
  };
  for (let k = 0; k < 3; k++) {
    const frame = [axes[k], axes[(k + 1) % 3], axes[(k + 2) % 3]];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of points) {
      for (let i = 0; i < 3; i++) {
        const x = dot(frame[i], p);
        if (x < lo[i]) lo[i] = x;
        if (x > hi[i]) hi[i] = x;
      }
    }
    const mid = [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2);
    const center = [0, 1, 2].map((j) => frame[0][j] * mid[0] + frame[1][j] * mid[1] + frame[2][j] * mid[2]);
    const half = Math.max((hi[0] - lo[0]) / 2, 1e-12);
    let across = 1e-12;
    for (const p of points) {
      const q = sub(p, center), x = dot(frame[0], q);
      across = Math.max(across, Math.hypot(q[0] - x * frame[0][0], q[1] - x * frame[0][1], q[2] - x * frame[0][2]));
    }
    // Grown to take in every vertex, then by a hair, so that none sits on
    // the surface: a surface is no one's inside.
    let grow = 0;
    for (const p of points) {
      const q = sub(p, center), x = dot(frame[0], q);
      const r = Math.hypot(q[0] - x * frame[0][0], q[1] - x * frame[0][1], q[2] - x * frame[0][2]);
      grow = Math.max(grow, Math.hypot(x / half, r / across));
    }
    grow *= 1 + 1e-4;
    keep(center, frame[0], 2 * half * grow, across * grow);
  }
  const { lo, hi } = boundsOf(triangles);
  const center = [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2);
  const r = points.reduce((most, p) => Math.max(most, length(sub(p, center))), 0) * (1 + 1e-4);
  keep(center, [0, 0, 1], 2 * r, r);
  const { center: c, axis, height, radius } = best;
  return { center: c, axis, height, radius };
}

/**
 * Cut a polygon with a plane, keeping one side. Returns null when what is
 * left is smaller than `tiny`, since a sliver is not worth the nodes it
 * would cost and is where the arithmetic goes wrong first.
 */
function clipPolygon(poly, plane, keepFront, eps) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = dot(plane.normal, a) - plane.offset;
    const db = dot(plane.normal, b) - plane.offset;
    const aIn = keepFront ? da >= -eps : da <= eps;
    const bIn = keepFront ? db >= -eps : db <= eps;
    if (aIn) out.push(a);
    if (aIn !== bIn && da !== db) {
      // A vertex within eps of the plane counts as on either side, so an
      // edge can cross from "in" to "out" with both ends on the same side.
      // Unclamped, t then lands beyond the edge, the polygon folds over,
      // and a fragment fanned from it faces backwards - a face pointing
      // into the model, which turns a whole cell of the tree inside out.
      const t = Math.min(1, Math.max(0, da / (da - db)));
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
    }
  }
  return out.length >= 3 ? out : null;
}

/** A polygon as triangles, fanned from its first vertex. */
function fanOf(poly, tiny) {
  const tris = [];
  for (let i = 1; i < poly.length - 1; i++) {
    const tri = [poly[0], poly[i], poly[i + 1]];
    if (doubleArea(tri) > tiny) tris.push(tri);
  }
  return tris;
}

/**
 * Sort a triangle against a plane: 'front', 'back', or split into both.
 *
 * A triangle that crosses the plane by less than the tolerance, or whose
 * lesser part is a sliver, is given whole to the side it is essentially on.
 * That is what keeps repeated splitting from grinding the mesh into dust.
 */
function sortTriangle(tri, plane, eps, tiny, front, back, split = true) {
  const d = tri.map((v) => dot(plane.normal, v) - plane.offset);
  const anyFront = d.some((x) => x > eps);
  const anyBack = d.some((x) => x < -eps);

  if (!anyFront && !anyBack) return 'coplanar';
  if (!anyBack) { front.push(tri); return 'front'; }
  if (!anyFront) { back.push(tri); return 'back'; }

  if (!split) {
    // Whole, to both sides. The plane a triangle contributes is the same
    // plane however the triangle is cut, so the tree can be built without
    // ever cutting one - at the cost of carrying a triangle down branches
    // it may not reach into, and of the nodes that go with that.
    front.push(tri);
    back.push(tri);
    return 'both';
  }

  const ahead = clipPolygon(tri, plane, true, eps);
  const behind = clipPolygon(tri, plane, false, eps);
  const aheadTris = ahead ? fanOf(ahead, tiny) : [];
  const behindTris = behind ? fanOf(behind, tiny) : [];

  // If one side came out as nothing, the triangle belongs wholly to the
  // other: splitting it would lose the piece that vanished.
  if (!aheadTris.length) { back.push(tri); return 'back'; }
  if (!behindTris.length) { front.push(tri); return 'front'; }
  front.push(...aheadTris);
  back.push(...behindTris);
  return 'split';
}

/**
 * Which plane to take next: split when you can, bound when you can't.
 *
 * A plane with geometry on both sides divides the region, and dividing is
 * what turns a model into a tree rather than a list. When nothing divides -
 * which is what a convex region *is* - every remaining plane has the model
 * behind it, and such a plane's outside is void: one node that both carries
 * a face and turns away every ray passing wide of it. Then the question is
 * only which to ask first, and the answer is whichever rejects the most
 * space.
 *
 * So the bounding volume is not a thing wrapped round the model. It is the
 * model's own outermost faces, taken in the order that sheds the most space
 * soonest, and it costs no nodes of its own.
 */
function choosePlane(triangles, eps, sampleSize, box) {
  const corners = [];
  for (const x of [box.lo[0], box.hi[0]]) {
    for (const y of [box.lo[1], box.hi[1]]) {
      for (const z of [box.lo[2], box.hi[2]]) corners.push([x, y, z]);
    }
  }

  let divider = null, supporting = null, fallback = null;
  const step = Math.max(1, Math.floor(triangles.length / sampleSize));
  for (let i = 0; i < triangles.length; i += step) {
    const plane = planeOfTriangle(triangles[i]);
    if (!plane) continue;
    let splits = 0, front = 0, back = 0;
    for (const tri of triangles) {
      const d = tri.map((v) => dot(plane.normal, v) - plane.offset);
      const anyFront = d.some((x) => x > eps), anyBack = d.some((x) => x < -eps);
      if (anyFront && anyBack) splits++;
      else if (anyFront) front++;
      else if (anyBack) back++;
    }
    fallback ??= plane;

    if (front + splits > 0 && back + splits > 0) {
      const cost = splits * 8 + Math.abs(front - back);
      if (!divider || cost < divider.cost) divider = { plane, cost };
      continue;
    }
    if (!front && !splits) {
      // Nothing in front: a supporting plane. How much space does asking
      // about it get rid of? The depth of the slab of the box it sheds.
      let rejected = 0;
      for (const corner of corners) rejected += Math.max(0, dot(plane.normal, corner) - plane.offset);
      if (!supporting || rejected > supporting.rejected) supporting = { plane, rejected };
    }
  }
  return divider?.plane ?? supporting?.plane ?? fallback;
}

/**
 * Turn a triangle mesh into a node tree.
 *
 * `triangles` are [[x,y,z], [x,y,z], [x,y,z]] with outward normals by the
 * right-hand rule, describing a closed surface. Returns a subtree ready to
 * drop into a scene, or null for an empty mesh. It names no material: a
 * mesh says nothing about what fills it, so it is spatial division only,
 * and whatever uses it says what it is made of (a "material" on the use,
 * or one in scope around it).
 */
export function meshToTree(triangles, options = {}) {
  const {
    sampleSize = 12,            // how many candidate planes to weigh
    maxDepth = 5000,
    split = true,               // cut straddling triangles, or pass them whole
    bound = true,               // wrap the tree in a bounding spheroid
  } = options;

  const usable = triangles.filter((tri) => planeOfTriangle(tri));
  if (!usable.length) return null;

  // Tolerances scaled to the model: an absolute epsilon is meaningless when
  // the same mesh may arrive in millimetres or in kilometres. And to how
  // precisely its vertices are known: usually as float32 (STL's), rounded
  // to about 2^-24 of their size, so the two halves of a flat quad can be
  // that far out of each other's plane. A tolerance tighter than that
  // keeps them apart: the second becomes a plane of its own, a hair off
  // the first, and the two bound a sliver reaching right across the model,
  // which rays hit as specks in the air.
  const { lo, hi } = boundsOf(usable);
  const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-12);
  const reach = Math.max(...lo.map(Math.abs), ...hi.map(Math.abs));
  const eps = Math.max(extent * 1e-9, reach * 2 ** -20);
  const tiny = extent * extent * 1e-12;          // twice the area of a sliver

  const build = (tris, depth) => {
    if (!tris.length) return null;
    if (depth > maxDepth) return null;
    const plane = choosePlane(tris, eps, sampleSize, boundsOf(tris));
    if (!plane) return null;

    const front = [], back = [];
    for (const tri of tris) sortTriangle(tri, plane, eps, tiny, front, back, split);

    const node = { plane: { normal: plane.normal, offset: plane.offset } };
    // Whole triangles can leave a child with everything its parent had,
    // apart from the one consumed as coplanar. That still ends, since one
    // goes each time, but it can get deep, so the depth cap matters here.
    const behind = build(back, depth + 1);
    const ahead = build(front, depth + 1);
    if (behind) node.inside = behind;           // else omitted: solid
    if (ahead) node.outside = ahead;            // else omitted: void
    return node;
  };

  const tree = build(usable, 0);
  if (!tree || !bound) return tree;
  // A pure division round the whole mesh: its inside holds the tree, its
  // absent outside is empty. A ray that misses it passes the model in one
  // test, and whatever is grafted onto the model's absent outsides - the
  // next operand of a union, say - is tested against it from inside, rather
  // than walked through.
  return { spheroid: boundingSpheroid(usable), inside: tree };
}

/** Nodes, depth and leaves, for judging what an import cost. */
export function treeStats(node) {
  let nodes = 0, solid = 0, empty = 0;
  const walk = (n, depth) => {
    if (!n) return depth;
    nodes++;
    const left = 'inside' in n ? walk(n.inside, depth + 1) : (solid++, depth + 1);
    const right = 'outside' in n ? walk(n.outside, depth + 1) : (empty++, depth + 1);
    return Math.max(left, right);
  };
  const depth = walk(node, 0);
  return { nodes, depth, solidLeaves: solid, voidLeaves: empty };
}
