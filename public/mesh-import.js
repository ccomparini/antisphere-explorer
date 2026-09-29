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
      const t = da / (da - db);
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

function flatstr(obj) {  // XXX debugging
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [
      key,
      Array.isArray(value) ? '[Array]' :
      value !== null && typeof value === 'object' ? '[Object]' :
      value
    ])
  );
}
const fp = flatstr;
function dumpLp(obj) { // XXX debugging:  dump w/ low precision
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'number') {
      return value.toFixed(2).padStart(6); // columnation/precision reductions
    }
    return value;
  }, 2);
}

// like sortTriangle, but just categorizes it as "inside" or "outside"
// the plane, or both, or neither (coplanar).
// Returns a tuple of bools for (inside, outside)
function sortTriangleInOut(tri, plane, eps) {
  const d = tri.map((v) => dot(plane.normal, v) - plane.offset);
console.error(`sorting tri ${dumpLp(tri)} vs ${dumpLp(plane)} gave ${d}`);
  const inside  = d.some((x) => x < -eps);
  const outside = d.some((x) => x >  eps);
console.error(`SO ${inside} inside and ${outside} outside`);
  return [ inside, outside ];
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

function addTri(tree, tri, eps) {
  if(!tree) return {
    // new tree starting with the plane passed
    'plane': planeOfTriangle(tri), 
    'inside': null,
    'outside': null,
  };

// XXX what if they are coplanar and opposite facing?  make an example model to test.
  const [ inside, outside ] = sortTriangleInOut(tri, tree.plane, eps);
  if(inside)  tree.inside  = addTri(tree.inside,  tri, eps);
  if(outside) tree.outside = addTri(tree.outside, tri, eps);

  return tree;
}

/**
 * Turn a triangle mesh into a node tree.
 *
 * `triangles` are [[x,y,z], [x,y,z], [x,y,z]] with outward normals by the
 * right-hand rule, describing a closed surface. Returns a subtree ready to
 * drop into a scene, or null for an empty mesh.
 */
export function meshToTree(triangles, options = {}) {
  const {
    material,
    sampleSize = 12,            // how many candidate planes to weigh
    maxDepth = 5000,
    split = true,               // cut straddling triangles, or pass them whole
  } = options;

// XXX maybe kill this
  const usable = triangles.filter((tri) => planeOfTriangle(tri));
console.error(`we have ${usable.length} usable triangles (${usable})`);
  if (!usable.length) return null;

  // debugging:  get/show distinct planes
  const distinctPlanes = { };
  for (const tri of triangles) {
    const plane = planeOfTriangle(tri);
    if(plane) distinctPlanes[dumpLp(plane)] = true; // note low precision dump
  }
console.error(`${Object.keys(distinctPlanes).length} distinct planes:\n${JSON.stringify(Object.keys(distinctPlanes), null, 2)}`);

  // Tolerances scaled to the model: an absolute epsilon is meaningless when
  // the same mesh may arrive in millimetres or in kilometres.
  const { lo, hi } = boundsOf(usable);
  const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-12);
  //const eps = extent * 1e-9;
const eps = 1e-6;
//  const tiny = extent * extent * 1e-12;          // twice the area of a sliver
console.error(`   ... bounds: ${lo}, ${hi};  epsilon: ${eps}`);

  //while(const plane = choosePlane(tris, eps, sampleSize, boundsOf(tris))) {
  let tree = null;
  while(usable.length) {
    const tri = usable.pop();
    tree = addTri(tree, tri, eps);
    tree.material = material;
  }
console.error(`final tree: ${dumpLp(tree)}`);
  return tree;

/*
// XXX this won't work:  the tree needs to be built top down
// or we can't correctly elide coplanars 
  const build = (tris, depth) => {
    if (!tris.length) return null;
    if (depth > maxDepth) {
      console.warn(`hit max depth with ${tris.length} triangles remaining`);
      return null;
    }
    const plane = choosePlane(tris, eps, sampleSize, boundsOf(tris));
    if (!plane) {
      console.warn(`no suitable dividing plane found with ${tris.length} triangles remaining`);
      return null;
    }

    const front = [], back = [];
    for (const tri of tris)
      sortTriangle(tri, plane, eps, tiny, front, back, split);

    const node = { plane: { normal: plane.normal, offset: plane.offset }, material };
    // Whole triangles can leave a child with everything its parent had,
    // apart from the one consumed as coplanar. That still ends, since one
    // goes each time, but it can get deep, so the depth cap matters here.
    const behind = build(back, depth + 1);
    const ahead  = build(front, depth + 1);
    node.inside  = behind;  // null/falsy value -> nothing inside
    node.outside = ahead;   // null/falsy value -> nothing outside
    return node;
  };

  return build(usable, 0);
 */
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
