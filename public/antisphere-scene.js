// ---------------------------------------------------------------------------
// Antisphere representation
//
//   A node stores nine numbers: (n.xyz, k_par, k_perp, c.xyz, d)
//     n       unit axis of revolution
//     k_par   curvature along the axis
//     k_perp  curvature in every direction perpendicular to it
//     c       linear term; a free vector, not generally parallel to n
//     d       constant term
//
//   Implicit function:
//     H(R) = transpose(R) K R + 2 c.R + d,  K = k_perp I + (k_par-k_perp) n(x)n
//          = k_perp (R.R) + (k_par - k_perp)(R.n)^2 + 2 c.R + d
//
//   H(R) < 0 still means inside, and negating k_par, k_perp, c and d still
//   gives the exact complement.
//
//   The original five numbers (n, a, k) are the isotropic case of this, and
//   compile to exactly what they used to:
//     sphere  k_par = k_perp = 1/(2r),  c = -kC,  d = k(|C|^2 - r^2)
//     plane   k_par = k_perp = 0,       c = n/2,  d = -a
//
//   What the signs of the two curvatures mean (see hyperconic.md):
//     equal, non-zero      sphere
//     same sign, unequal   spheroid: oblate if k_par > k_perp, else prolate
//     both zero            plane
//     k_perp = 0           slab, or a parabolic cylinder when c has a
//                          perpendicular component
//     k_par = 0            cylinder, or a paraboloid when c has an axial one
//     opposite signs       hyperboloid of one or two sheets, or, where the
//                          surface passes through its own centre, a cone
//
//   Only sphere and spheroid enclose a bounded region, which is why
//   regionBall() checks the signs rather than just whether K inverts.
// ---------------------------------------------------------------------------

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function unitVector(v, fallback = [0, 0, 1]) {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 1e-12 ? v.map((x) => x / len) : fallback;
}

// K v, for K = k_perp I + (k_par - k_perp) n(x)n.
function applyCurvature(prim, v) {
  const delta = prim.k_par - prim.k_perp;
  const along = dot3(v, prim.axis);
  return v.map((x, i) => prim.k_perp * x + delta * along * prim.axis[i]);
}

/** A quadric straight from its stored numbers; the axis need not be unit. */
function quadric(axis, k_par, k_perp, linear, constant) {
  return { axis: unitVector(axis), k_par, k_perp, linear, constant };
}

/**
 * A quadric written about a point, which is how every shape below is easiest
 * to state: H(R) = u K u + localLinear.u + localConst, with u = R - centre.
 * Expanding that gives c = -K centre + localLinear/2 and
 * d = centre.K centre - localLinear.centre + localConst.
 */
function about(axis, k_par, k_perp, centre, localLinear = [0, 0, 0], localConst = 0) {
  const prim = quadric(axis, k_par, k_perp, [0, 0, 0], 0);
  const Kc = applyCurvature(prim, centre);
  prim.linear = Kc.map((v, i) => -v + 0.5 * localLinear[i]);
  prim.constant = dot3(centre, Kc) - dot3(localLinear, centre) + localConst;
  return prim;
}

// The isotropic pair, unchanged in meaning: H = k(|R - C|^2 - r^2) for a
// sphere, H = n.R - a for a plane.
function sphere(center, radius) {
  const k = 1 / (2 * radius);
  return about(unitVector(center), k, k, center, [0, 0, 0], -k * radius * radius);
}

function plane(normal, offset) {
  const n = unitVector(normal);
  return quadric(n, 0, 0, n.map((v) => v / 2), -offset / Math.hypot(normal[0], normal[1], normal[2]));
}

// Rotationally symmetric ellipsoid: semiAxial along the axis, semiRadial
// around it. Equal semi-axes give a sphere back.
function spheroid(centre, axis, semiAxial, semiRadial) {
  return about(axis, 1 / (semiAxial * semiAxial), 1 / (semiRadial * semiRadial),
               centre, [0, 0, 0], -1);
}

// Infinite right circular cylinder about the axis through `centre`.
function cylinder(centre, axis, radius) {
  return about(axis, 0, 1 / (radius * radius), centre, [0, 0, 0], -1);
}

// The region between two parallel planes, `thickness` apart, centred on
// `centre` and perpendicular to the axis.
function slab(centre, axis, thickness) {
  const half = thickness / 2;
  return about(axis, 1, 0, centre, [0, 0, 0], -half * half);
}

// Double cone with its apex on the axis; slope is radius gained per unit
// length along the axis, so a 45 degree cone has slope 1.
function cone(apex, axis, slope) {
  return about(axis, -slope * slope, 1, apex, [0, 0, 0], 0);
}

// Paraboloid of revolution opening along +axis from its vertex; `focal` is
// the focal length, so the surface is |R_perp|^2 = 4 focal x.
function paraboloid(vertex, axis, focal) {
  const n = unitVector(axis);
  return about(n, 0, 1, vertex, n.map((v) => -4 * focal * v), 0);
}

// One sheet (a waist of `radius` about the axis) or two (opening away from
// `centre` along it); semiAxial sets how fast they open.
function hyperboloid(centre, axis, radius, semiAxial, sheets) {
  return about(axis, -1 / (semiAxial * semiAxial), 1 / (radius * radius),
               centre, [0, 0, 0], sheets === 2 ? 1 : -1);
}

// Turns a single surface inside out: negate everything but the axis, which
// has no side to swap. One node's own geometry only - complement(), below,
// is what turns a whole region inside out, and is what a scene file's
// "complement" means.
function complementSurface(prim) {
  return {
    axis: prim.axis,
    k_par: -prim.k_par,
    k_perp: -prim.k_perp,
    linear: prim.linear.map((v) => -v),
    constant: -prim.constant,
  };
}

// ---------------------------------------------------------------------------
// Materials
//
// One table. A node's material - an index into this table, 0 being vacuum
// - is read at render time from whichever node's surface a ray actually
// crossed (antisphere-raycast.wgsl's main() does
// `materials[nodes[entry].material]`), so a hit's shading is always a
// direct table read, with no scope-threading left to do at render time.
//
// A node that doesn't name a material of its own inherits its nearest
// ancestor's, by descending through "inside" (bakeScopes() resolves this
// once, at compile time, using the same threading rule as ambient
// inheritance: "outside" always keeps whatever was already in scope above
// it, never the current node's own material). Naming a material
// explicitly - even one already in scope - opts back out of inheriting
// further, which is what lets one CSG object show several materials on
// its different surfaces. "material": null explicitly requests vacuum,
// likewise opting out of inheritance rather than picking up the
// surrounding scope.
//
// Surface parameterization always comes from the node that was crossed,
// never from the material, so a node's own (n, a, k) supplies the frame: a
// tangent basis for planes, a center for spheres.
//
// "paint" is a deprecated alias for "material", still accepted by
// materialAndEnvOf() for scenes not yet migrated; its old special value
// "inherit" now just means the same as omitting a material, and
// "partition"/"bare" still mean vacuum.
// ---------------------------------------------------------------------------

// Material 0 is reserved as vacuum (see compileScene()'s table).
const NO_MATERIAL = 0;

// Sentinel meaning "no material named here yet" prior to bakeScopes(),
// distinct from NO_MATERIAL (vacuum, which explicitly opts out of
// inheriting anything). Never survives past bakeScopes() - resolved there
// to a real index or to NO_MATERIAL. Node construction that isn't driven
// by scene.json (BVH split/bounding wrappers, translation, union) always
// passes a concrete material - see node()'s own default parameter - so
// only JSON-authored nodes ever start out holding this value.
const INHERIT_MATERIAL = -1;

// Recognized only via the deprecated "paint" field (see
// materialAndEnvOf()), for scenes not yet migrated to naming a material
// directly. Reserved as material names even so, to avoid a materials.foo
// entry silently shadowing what used to be special syntax.
const LEGACY_PAINT_WORDS = ['partition', 'inherit', 'bare'];

const PATTERNS = { flat: 0, checker: 1 };

// Each kind names a shading function in the shader. Adding one means a
// function and a switch arm there, plus an entry here and its parameters.
const KINDS = {
  lambert:  { id: 0, params: () => [0, 0] },
  glossy:   { id: 1, params: (d) => [d.shininess ?? 32, d.specular ?? 0.6] },
  emissive: { id: 2, params: (d) => [d.emission ?? 1, 0] },
  unlit:    { id: 3, params: () => [0, 0] },
  // An ambient container never shades. Naming one as a node's material
  // moves it into env instead, leaving that node a pure spatial split
  // whose albedo becomes the ambient level for everything inside it.
  ambient:  { id: 4, params: () => [0, 0] },
};
const KIND_AMBIENT = 4;

// ---------------------------------------------------------------------------
// Provenance
//
// Every node authored in scene.json remembers where it came from, so a ray
// hit can be traced back to something a user can select: { owner, path },
// where owner is the key of the named object the node belongs to (or
// ROOT_OWNER for the root subtree) and path is the literal keys from that
// object's body down to the node, joined with '/' - "inside/outside",
// "union/2/inside". That's the same addressing the editor's SceneDocument
// uses for selections, so a hit maps straight onto one.
//
// Provenance rides along on each node object and is copied by everything
// that copies a node (union, translation, scope baking), so it survives to
// flatten(). Nodes the compiler invents - group split surfaces and
// bounding wrappers - have none: they are never a surface a ray stops on.
//
// An instance - an object whose whole body is { use, translate } - gets
// nodes of its own attributed to it (see reown()), even when untranslated,
// so a hit can say which instance was struck rather than just which
// prototype. Sharing within one owner is unaffected.
// ---------------------------------------------------------------------------

export const ROOT_OWNER = '@root';

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

// A node: test f(R); f < 0 descends into `inside`, otherwise `outside`.
// prov is "provenance" and used to determine which object this node is
// part of.
function node(prim, inside, outside, material = NO_MATERIAL, env = 0, prov = null) {
  return { prim, inside, outside, material, env, prov };
}

// Union: returns a tree whose interior is the union of both interiors. A
// null child means no further subdivision, so on the inside it is a region
// in its own right and stays; on the outside it is where `other` goes.
function union(t, other) {
  if (!t) return other;
  return node(t.prim,
              t.inside ? union(t.inside, other) : null,
              union(t.outside, other),
              t.material, t.env, t.prov);
}

// Intersection: by De Morgan, what is inside both is what is outside
// neither. Not the most direct construction - it builds three intermediate
// trees - but it needs no case analysis of its own, and scene compilation is
// not where the time goes.
function intersect(t, other) {
  // A null tree is "no subdivision", which reads as the empty region here -
  // but its complement, everything, has no null of its own to be written as,
  // so De Morgan can't be trusted with one. Both identities are direct.
  if (!t || !other) return null;
  return complement(union(complement(t), complement(other)));
}

// The tree whose interior is the complement of this one's, and what a scene
// file's "complement" applies. A node's region is (P_in and I) or
// (P_out and O), so its complement is the same node with both children
// complemented - and complementing the node's own surface as well swaps
// which slot each child sits in, which is all it takes: a null child means
// "no further subdivision here" on either side, so it complements to itself.
//
// On a node with no children the two coincide, which is why scene files
// that only ever complemented bare primitives read as they always did.
//
// Materials and provenance are kept, so a complemented region carries its
// own look, and clicking a cut face still selects whatever cut it.
function complement(t) {
  if (!t) return t;
  return node(complementSurface(t.prim),
              complement(t.outside),
              complement(t.inside),
              t.material, t.env, t.prov);
}

// Difference: what is interior to t and not to other.
function difference(t, other) {
  if (!other) return t;                  // nothing taken away
  return intersect(t, complement(other));
}

// Rigid translation of a primitive by a world-space offset. Substituting
// R - t for R leaves the axis and both curvatures alone and moves only the
// linear and constant terms:
//   c' = c - K t,  d' = d - 2 c.t + t.K t
// which is exact for every shape in the family, and needs none of the
// re-derivation the old (n, a, k) form did: that form compressed the
// position into a single distance along the normal, which is precisely what
// stops working once a primitive has an axis of its own.
function translatePrim(prim, t) {
  const Kt = applyCurvature(prim, t);
  return {
    axis: prim.axis,
    k_par: prim.k_par,
    k_perp: prim.k_perp,
    linear: prim.linear.map((v, i) => v - Kt[i]),
    constant: prim.constant - 2 * dot3(prim.linear, t) + dot3(t, Kt),
  };
}

// Rotation by a 3x3 matrix, as rows. Only the two vectors turn: curvature
// is a property of the shape, not of where it points, and the constant term
// is about the origin, which rotation fixes.
function rotatePrim(prim, rows) {
  const turn = (v) => rows.map((row) => dot3(row, v));
  return {
    axis: turn(prim.axis),
    k_par: prim.k_par,
    k_perp: prim.k_perp,
    linear: turn(prim.linear),
    constant: prim.constant,
  };
}

// Uniform scale about the origin by a positive factor. Substituting R/s for
// R and clearing the 1/s^2 gives k -> k/s, c unchanged, d -> s d, which is
// the rule a sphere obeys: centre sC and radius sr means k/s, c = -kC as
// before, and d scaled by s. (Dividing all four by s, as one might expect,
// only scales H itself - the surface, being where H is zero, would not
// move at all.)
function scalePrim(prim, s) {
  return {
    axis: prim.axis,
    k_par: prim.k_par / s,
    k_perp: prim.k_perp / s,
    linear: prim.linear,
    constant: prim.constant * s,
  };
}

// Rotation matrix for a turn about a unit axis, by Rodrigues' formula, as
// rows so rotatePrim can dot with them.
function rotationRows(axis, radians) {
  const [x, y, z] = unitVector(axis);
  const c = Math.cos(radians), s = Math.sin(radians), t = 1 - c;
  return [
    [t * x * x + c,     t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c,     t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

// Rigid translation of a whole subtree: every node's own primitive moves,
// recursively, since each one's numbers are in the same global frame (see
// translatePrim). This is what "translate" (see tree()) rides on to place
// an object authored once under "objects" wherever it's needed, instead
// of copying and hand-editing every number in it per instance. A
// translated copy is genuinely different geometry from the original, so
// unlike a plain "use" it can't share nodes with it once flattened.
function translateTree(t, offset) {
  if (!t) return t;
  return node(translatePrim(t.prim, offset),
              translateTree(t.inside, offset),
              translateTree(t.outside, offset),
              t.material, t.env, t.prov);
}

// Re-attribute to `to` every node that `from` owns, copying them - and any
// node above them, so it can point at the copies - while leaving untouched
// subtrees shared. Used to give an instance nodes of its own (see the
// Provenance comment above). Memoized, so shared structure stays shared
// within the copy.
function reown(t, from, to, memo = new Map()) {
  if (!t) return t;
  if (memo.has(t)) return memo.get(t);
  const inside = reown(t.inside, from, to, memo);
  const outside = reown(t.outside, from, to, memo);
  const mine = t.prov?.owner === from;
  const out = (!mine && inside === t.inside && outside === t.outside)
    ? t
    : node(t.prim, inside, outside, t.material, t.env,
           mine ? { ...t.prov, owner: to } : t.prov);
  memo.set(t, out);
  return out;
}

// Rotation and scale of a whole subtree, about a pivot. Both work the same
// way as translateTree: every primitive in the subtree is transformed, since
// each one's numbers are in the same global frame. About a pivot other than
// the origin they are conjugated with a translation, which is all "rotate
// this object where it stands" means.
function rotateTree(t, rows, pivot) {
  if (!t) return t;
  const back = pivot.map((v) => -v);
  const turn = (prim) => {
    const local = translatePrim(prim, back);
    const turned = rotatePrim(local, rows);
    return translatePrim(turned, pivot);
  };
  const walk = (u) => (!u ? u
    : node(turn(u.prim), walk(u.inside), walk(u.outside), u.material, u.env, u.prov));
  return walk(t);
}

function scaleTree(t, factor, pivot) {
  if (!t) return t;
  const back = pivot.map((v) => -v);
  const grow = (prim) => translatePrim(scalePrim(translatePrim(prim, back), factor), pivot);
  const walk = (u) => (!u ? u
    : node(grow(u.prim), walk(u.inside), walk(u.outside), u.material, u.env, u.prov));
  return walk(t);
}

// Resolves material and ambient-env inheritance once, here, instead of
// once per ray in antisphere-raycast.wgsl's trace(). Both follow the same
// rule: descending into a node's *inside* adopts its own value as the
// scope for everything below it, unless that value means "inherit"
// (INHERIT_MATERIAL for material, 0 for env), in which case the incoming
// scope keeps threading through unchanged; *outside* always keeps the
// incoming scope, never the current node's own value. Baking both onto
// every node is what lets a hit's material and ambient level each be read
// directly off nodes[entry] (main() does exactly that) with no runtime
// threading left at all.
//
// Correct as long as the tree is static: nothing here moves a node between
// material/ambient regions after this bakes it in, so if scenes ever need
// runtime-mutable regions, this bake would need to move to (or be redone
// for) whatever does that mutating.
//
// Memoized by (subtree, materialScope, envScope): a subtree shared under
// one pair of scopes (by "use", "group", or "union") still collapses to
// one baked copy; only reuse under a genuinely different pair forces a
// separate one, which is required for correctness - the same subtree can
// resolve to different materials or ambient levels in different contexts.
function bakeScopes(tree) {
  const memo = new Map();   // "matScope:envScope" -> (subtree -> baked)
  const resolve = (t, matScope, envScope) => {
    if (!t) return t;
    const key = `${matScope}:${envScope}`;
    let byScope = memo.get(key);
    if (!byScope) { byScope = new Map(); memo.set(key, byScope); }
    if (byScope.has(t)) return byScope.get(t);
    const hereMat = t.material === INHERIT_MATERIAL ? matScope : t.material;
    const hereEnv = t.env !== 0 ? t.env : envScope;
    const out = node(t.prim,
                      resolve(t.inside, hereMat, hereEnv),
                      resolve(t.outside, matScope, envScope),
                      hereMat, hereEnv, t.prov);
    byScope.set(t, out);
    return out;
  };
  return resolve(tree, NO_MATERIAL, 0);
}

// Node 0 is reserved: "no child at all" - antisphere-raycast.wgsl's
// trace() special-cases it before ever touching a node's geometry. It's
// never a real node, so its own fields are dead weight, zeroed here.
//
// Clarification on "inside" and "outside":  a node can be looked at
// as a partition of space into 2 regions:  the "inside" region (which
// the node is concerned with) and everything else ("outside").  Both
// regions may have further partitions. If the node's "inside" has no
// further partitions, that node's material pertains to the space
// inside that node.
function flatten(tree) {
  const out = [{ prim: { axis: [0, 0, 1], k_par: 0, k_perp: 0, linear: [0, 0, 0], constant: 0 },
                 material: 0, env: 0, inside: 0, outside: 0, prov: null }];
  const memo = new Map();
  const walk = (t) => {
    if (!t) return 0;
    if (memo.has(t)) return memo.get(t);
    const idx = out.length;
    out.push(null);
    memo.set(t, idx);
    out[idx] = { prim: t.prim, material: t.material, env: t.env ?? 0,
                 inside: walk(t.inside), outside: walk(t.outside), prov: t.prov };
    return idx;
  };
  walk(tree);
  return out;
}

// ---------------------------------------------------------------------------
// Bounds
//
// The bounding sphere of a subtree's interior region, used by "group" to check
// the author's disjointness claim and to build the early-out tests. A node's
// own numbers already describe a ball whenever that side of it is bounded:
// the inside for positive curvature, the outside for negative. A half-space
// bounds neither side, and neither does anything with an axis it runs off
// along - a cylinder, a paraboloid, a hyperboloid or a cone.
//
// Returns NO_SOLID, UNBOUNDED, or { c, r }.
// ---------------------------------------------------------------------------

const NO_SOLID = null;
const UNBOUNDED = 'unbounded';

const dist3 = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);

// Only a sphere or a spheroid encloses anything: both curvatures non-zero
// and of one sign. Everything else - and the unbounded side of those - gets
// null, which boundOf() reads as "this side is not bounded by me", the same
// as a half-space always did.
function regionBall(prim, insideSide) {
  const { k_par, k_perp, linear: c } = prim;
  if (k_par === 0 || k_perp === 0) return null;
  if ((k_par > 0) !== (k_perp > 0)) return null;      // hyperboloid or cone
  if (insideSide !== (k_perp > 0)) return null;       // the side that runs off

  // Centre C = -K^-1 c, using K^-1 = (1/k_perp) I + (1/k_par - 1/k_perp) n(x)n.
  // About it the surface is u K u = E, so the semi-axes are sqrt(E/k_par)
  // along the axis and sqrt(E/k_perp) around it.
  const axial = dot3(c, prim.axis);
  const centre = c.map((v, i) =>
    -(v / k_perp + (1 / k_par - 1 / k_perp) * axial * prim.axis[i]));
  const E = -(dot3(c, centre) + prim.constant);
  if (E / k_perp <= 0) return null;                   // empty, or a single point
  return { c: centre, r: Math.max(Math.sqrt(E / k_par), Math.sqrt(E / k_perp)) };
}

// Bounding sphere of the intersection of two balls. Exact for containment,
// and for the lens case takes the ball around the lens's axial extent and
// widest cross-section.
function ballMeet(A, B) {
  const d = dist3(A.c, B.c);
  if (d >= A.r + B.r) return NO_SOLID;
  if (d + A.r <= B.r) return A;
  if (d + B.r <= A.r) return B;
  const x = (d*d - B.r*B.r + A.r*A.r) / (2*d);       // A.c to the radical plane
  const rho2 = Math.max(0, A.r*A.r - x*x);           // widest cross-section
  const lo = Math.max(-A.r, d - B.r), hi = Math.min(A.r, d + B.r);
  const xm = 0.5 * (lo + hi);
  const u = A.c.map((v, i) => (B.c[i] - v) / d);
  return {
    c: A.c.map((v, i) => v + u[i] * xm),
    r: Math.max(0.5 * (hi - lo), Math.sqrt(rho2 + (x - xm) ** 2)),
  };
}

function ballJoin(A, B) {
  const d = dist3(A.c, B.c);
  if (d + A.r <= B.r) return B;
  if (d + B.r <= A.r) return A;
  const R = 0.5 * (d + A.r + B.r);
  const t = (R - A.r) / d;
  return { c: A.c.map((v, i) => v + (B.c[i] - v) * t), r: R };
}

// `table` (the compiled materials list, in scope from compileScene()) is
// what lets this tell a genuinely empty default "inside" (a node whose own
// material happens to be non-solid) apart from an ordinary solid one.
function boundOf(t, declared, memo, table) {
  if (declared.has(t)) return declared.get(t);
  if (!t) return NO_SOLID;
  if (memo.has(t)) return memo.get(t);
  memo.set(t, UNBOUNDED);                          // conservative cycle guard
  // A null side means there's no further spacial subdivision on that side.
  // If the null side is "inside", the node's material applies to rays
  // crossing the surface of the node. If the null side is "outside",
  // this node doesn't care.
  const sideBound = (child, insideSide) => {
    if (!child) {
      if (!insideSide) return NO_SOLID;
      // A material still pending inheritance (INHERIT_MATERIAL) isn't
      // resolved yet at this point in compilation - assume solid, since
      // that's what inheritance overwhelmingly resolves to, and erring
      // toward "solid" only ever widens a bound, never narrows one enough
      // to clip real geometry.
      const solid = t.material === INHERIT_MATERIAL ? true : table[t.material].solid;
      return solid ? (regionBall(t.prim, true) || UNBOUNDED) : NO_SOLID;
    }
    const ball = regionBall(t.prim, insideSide);
    const b = boundOf(child, declared, memo, table);
    if (b === NO_SOLID) return NO_SOLID;
    if (!ball) return b;
    return b === UNBOUNDED ? ball : ballMeet(b, ball);
  };
  const bi = sideBound(t.inside, true);
  const bo = sideBound(t.outside, false);
  let out;
  if (bi === UNBOUNDED || bo === UNBOUNDED) out = UNBOUNDED;
  else if (bi === NO_SOLID) out = bo;
  else if (bo === NO_SOLID) out = bi;
  else out = ballJoin(bi, bo);
  memo.set(t, out);
  return out;
}

// ---------------------------------------------------------------------------
// Scene compiler
//
// Turns scene.json into flat node, material, and light tables. Named entries
// under "objects" are built once and shared by reference, so a subtree used
// in several places collapses to one set of nodes when flattened - unless
// it's placed with "translate", which moves it (see translateTree) and so
// can no longer share nodes with the original or with other instances.
// ---------------------------------------------------------------------------

export function compileScene(spec) {
  const at = (path, msg) => { throw new Error(`scene cmpilation: ${path}: ${msg}`); };
  const warn = (path, msg) => { console.warn(`warning: ${path}: ${msg}`); };

  // Material 0 is vacuum: never shaded, and not solid.
  //  trace() reads materials[material].solid
  // directly wherever a node's own default (unspecified) "inside" is what
  // decides solid-or-not (see flatten()'s doc comment), so an author-set
  // solid: false (water/glass, or a purely spatial-subdivision material)
  // is exactly what keeps that region from registering as a hit.
  const table = [{ albedo: [0, 0, 0], albedo2: [0, 0, 0],
                   pattern: 0, scale: 1, kind: 0, params: [0, 0], solid: false }];
  const matIndex = new Map();
  for (const [name, def] of Object.entries(spec.materials || {})) {
    if (LEGACY_PAINT_WORDS.includes(name)) at(`materials.${name}`, 'name is reserved');
    const pattern = PATTERNS[def.pattern ?? 'flat'];
    if (pattern === undefined) at(`materials.${name}`, `unknown pattern "${def.pattern}"`);
    const kind = KINDS[def.kind ?? 'lambert'];
    if (!kind) {
      at(`materials.${name}`, `unknown kind "${def.kind}". Known kinds: ` +
                              Object.keys(KINDS).join(', '));
    }
    table.push({
      albedo:  def.albedo  ?? [0.7, 0.7, 0.7],
      albedo2: def.albedo2 ?? [0.3, 0.3, 0.3],
      scale:   def.scale   ?? 1,
      kind:    kind.id,
      params:  kind.params(def),
      pattern,
      solid:   def.solid ?? true,   // e.g. water, glass, or a spatial-subdivision-only material
    });
    matIndex.set(name, table.length - 1);
  }

  const lightList = (spec.lights || []).map((lt, i) => {
    if (!lt.pos || !lt.color) at(`lights[${i}]`, 'needs pos and color');
    return { pos: lt.pos, color: lt.color };
  });

  function substrate(name, path) {
    const m = matIndex.get(name);
    if (m === undefined) at(path, `unknown material "${name}"`);
    return m;
  }

  // Returns { material, env }. An ambient-kind material moves into env
  // and leaves the node with no material of its own (NO_MATERIAL): an
  // ambient container is a pure spatial split, not a substance.
  function resolveMaterialName(name, path) {
    const m = substrate(name, path);
    if (table[m].kind === KIND_AMBIENT) return { material: NO_MATERIAL, env: m };
    return { material: m, env: 0 };
  }

  // "material": null explicitly names vacuum/NO_MATERIAL, opting out of
  // inheriting an ancestor's material - unlike simply omitting "material",
  // which instead inherits (see bakeScopes()). Most useful to give a
  // node's own default "inside" (see flatten()'s doc comment) an
  // explicitly non-solid material for a pure spatial-subdivision node,
  // even one nested inside a solid ancestor whose material would
  // otherwise apply.
  //
  // "paint" is a deprecated alias for "material". Of its old sentinel
  // values, "inherit" now just means the same as omitting a material
  // (which already inherits by default); "partition" and "bare" still
  // mean vacuum, though "bare" no longer has any separate leaf substrate
  // to reveal, so a node that relied on it to show through scope will
  // instead show whatever NO_MATERIAL resolves to - name the desired
  // material directly on that node to fix it.
  function materialAndEnvOf(def, path) {
    if (def.material === null) return { material: NO_MATERIAL, env: 0 };
    if (def.material !== undefined) return resolveMaterialName(def.material, `${path}.material`);
    if (def.paint === undefined) return { material: INHERIT_MATERIAL, env: 0 };
    console.warn(`scene.json ${path}.paint: "paint" is deprecated - use "material" instead.`);
    if (def.paint === 'inherit') return { material: INHERIT_MATERIAL, env: 0 };
    if (def.paint === 'partition' || def.paint === 'bare') {
      return { material: NO_MATERIAL, env: 0 };
    }
    return resolveMaterialName(def.paint, `${path}.paint`);
  }

  function pivotOf(def, path) {
    if (def.pivot === undefined) return [0, 0, 0];
    if (!Array.isArray(def.pivot) || def.pivot.length !== 3) {
      at(`${path}.pivot`, 'needs a [x, y, z] point');
    }
    return def.pivot;
  }

  // "scale": 2, or { "factor": 2, "pivot": [x, y, z] }. Uniform only: a
  // subtree's primitives can point any way they like, and scaling one axis
  // differently would leave most of them outside the family of revolution
  // quadrics a node can hold.
  function scaleSpec(def, path) {
    const spec = typeof def === 'number' ? { factor: def } : def;
    const factor = spec?.factor;
    if (!(factor > 0)) at(path, 'needs a positive factor, as a number or { factor, pivot }');
    return { factor, pivot: pivotOf(spec, path) };
  }

  // "rotate": { "axis": [x, y, z], "degrees": 90 }, or "radians", and an
  // optional pivot to turn about something other than the origin.
  function rotateSpec(def, path) {
    if (!def || !Array.isArray(def.axis)) at(path, 'needs an axis: { axis: [x, y, z], degrees }');
    if (!(Math.hypot(...def.axis) > 1e-12)) at(`${path}.axis`, 'has no direction');
    const hasDegrees = typeof def.degrees === 'number';
    const hasRadians = typeof def.radians === 'number';
    if (hasDegrees === hasRadians) at(path, 'needs exactly one of degrees or radians');
    const radians = hasDegrees ? def.degrees * Math.PI / 180 : def.radians;
    return { rows: rotationRows(def.axis, radians), pivot: pivotOf(def, path) };
  }

  // Every shape a node can be. Each is stated the way an author thinks of
  // it - a centre, an axis, some lengths - and turned into the nine numbers
  // by the constructors up top. "quadric" is the way out for anything the
  // named shapes don't cover, a parabolic cylinder for instance.
  // NOTE:  These may mutate the def passed in order to set defaults in
  // a way such that scene editors and such can see them.
  const SHAPES = {
    sphere: (def, path) => {
      // default is a unit sphere at 0,0,0:
      if (!def.center) def.center = [ 0.0, 0.0, 0.0 ];
      if (!Number.isFinite(def.radius))
        def.radius = 1.0; // note we're not explicitly disallowing negative radius
      return sphere(def.center, def.radius);
    },
    plane: (def, path) => {
      if (!def.normal) def.normal = [ 0.0, 0.0, 1.0 ];
      if (!def.offset) def.offset = 0.0;
      // default normal is up; so default is a sort of "ground" plane
      return plane(def.normal, def.offset);
    },
    spheroid: (def, path) => {
      // default actually is also a unit sphere at 0,0,0 but
      // presumably usually at least some parameter will have
      // been provided.
      def.center     ??= [ 0.0, 0.0, 0.0 ];
      def.axis       ??= [ 0.0, 1.0, 0.0 ];
      def.semiAxial  ??= 1.0;
      def.semiRadial ??= 1.0;
      // we expect but do not require that semiAxial and semiRadial
      // are both > 0; warn, but let the user see what comes out.
      // (would it be more intuitive to do each of these in terms of radii?)
      const bads = [ ];
      if (def.semiAxial <= 0)  bads.push('semiAxial');
      if (def.semiRadial <= 0) bads.push('semiRadial');
      if (bads) {
        const badstr = bads.map(bad => bad + " == " + def[bad]).join(',');
        warn(path, `not a sphereoid: ${badstr} should ${bads.length > 1?'all ':''}be > 0`);
      }
      return spheroid(def.center, def.axis, def.semiAxial, def.semiRadial);
    },
    cylinder: (def, path) => {
      // default is vertical, centered on x,y plane origin, radius 1.0::
      def.center ??= [ 0.0, 0.0, 0.0 ];
      def.axis   ??= [ 0.0, 0.0, 1.0 ];
      def.radius ??= 1.0;

      if (def.radius <= 0)
        warn(path, `cylinder has radius ${def.radius} which might cause surprises`);

      return cylinder(def.center, def.axis, def.radius);
    },
    slab: (def, path) => {
      // default slab is flat on the ground, like a plane, I guess.
      def.center    ??= [ 0.0, 0.0, 0.0 ];
      def.axis      ??= [ 0.0, 0.0, 1.0 ];
      def.thickness ??= 0.3;
      if (def.thickness <= 0) warn(path, 'needs a positive thickness');
      return slab(def.center, def.axis, def.thickness);
    },
    cone: (def, path) => {
      // default cone is vertical and.. well, this should be visible
      // in a scene where the camera is looking near the origin.
      def.apex  ??= [ 0.0, 0.0, 1.0 ];
      def.axis  ??= [ 0.0, 0.0, 1.0 ];
      def.slope ??= 0.25;

      if (def.slope <= 0)
        warn(path, 'needs a positive slope: radius gained per unit along the axis');
      return cone(def.apex, def.axis, def.slope);
    },
    paraboloid: (def, path) => {
      // this is analogous to the cone defaults:
      def.vertex ??= [ 0.0, 0.0, 1.0 ];
      def.axis   ??= [ 0.0, 0.0, 1.0 ];
      def.focal  ??= .25;

      if (def.focal <= 0) warn(path, 'needs a positive focal length');
      return paraboloid(def.vertex, def.axis, def.focal);
    },
    hyperboloid: (def, path) => {
      def.center    ??= [ 0.0, 0.0, 0.0 ];
      def.axis      ??= [ 0.0, 0.0, 1.0 ];
      def.radius    ??= 1.0;
      def.semiAxial ??= 1.0;
      def.sheets    ??= 1;

      if (def.radius <= 0)    warn(path, `needs positive radius (got ${def.radius})`);
      if (def.semiAxial <= 0) warn(path, `needs positive semiAxial (got ${def.semiAxial})`);

      // well, this one in a hard error:
      if (def.sheets !== 1 && def.sheets !== 2) at(path, 'sheets must be 1 or 2');
      return hyperboloid(def.center, def.axis, def.radius, def.semiAxial, def.sheets);
    },
    quadric: (def, path) => {
      const { axis, k_par, k_perp, c, d } = def;
      if (!axis || !c) at(path, 'needs axis and c');
      if (typeof k_par !== 'number' || typeof k_perp !== 'number' || typeof d !== 'number') {
        at(path, 'needs numeric k_par, k_perp and d');
      }
      if (k_par === 0 && k_perp === 0 && !c.some((v) => v !== 0)) {
        at(path, 'is zero everywhere, so it has no surface');
      }
      return quadric(axis, k_par, k_perp, c.slice(), d);
    },
  };

  function primOf(def, path) {
    const named = Object.keys(SHAPES).filter((shape) => def[shape] !== undefined);
    if (named.length === 0) {
      at(path, `needs a shape: one of ${Object.keys(SHAPES).join(', ')}`);
    }
    if (named.length > 1) at(path, `has more than one shape: ${named.join(' and ')}`);
    const shape = named[0];
    // NOTE: this can mutate def[shape] (in order to set defaults)
    var prim = SHAPES[shape](def[shape], `${path}.${shape}`);
    if (def[shape].complement) {
      // "complement" specified within the shape complements just the shape
      prim = complementSurface(prim);
    }
    return prim;
  }

  // Where a subtree sits for provenance: its owner, and the literal keys
  // from the owner's body down to it. `below` extends it by more keys.
  const below = (where, ...keys) =>
    ({ owner: where.owner, segments: [...where.segments, ...keys] });
  const provOf = (where) => ({ owner: where.owner, path: where.segments.join('/') });
  const isUseBody = (def) =>
    def !== null && typeof def === 'object' && typeof def.use === 'string';

  // Named objects are memoized so repeated use shares one subtree.
  // Distinct from null, which is a perfectly good tree meaning "no
  // subdivision here": an object may legitimately compile to one, and
  // reporting that as a cycle would be a puzzling error.
  const BUILDING = Symbol('building');
  const built = new Map();
  const declared = new Map();     // subtree -> author-declared bounding ball
  const boundMemo = new Map();
  const instanceBodies = new Map();   // identical-instance detection

  function named(name, path) {
    if (built.has(name)) return built.get(name);
    const def = (spec.objects || {})[name];
    if (!def) at(path, `unknown object "${name}"`);
    built.set(name, BUILDING);                   // cycle guard
    let t = tree(def, `objects.${name}`, { owner: name, segments: [] });

    // An instance gets nodes of its own, attributed to it, so a hit can say
    // which instance was struck (see the Provenance comment up top).
    if (isUseBody(def) && t) {
      t = reown(t, def.use, name);
      // Two instances with the same prototype and offset are the same
      // geometry in the same place: never what anyone means.
      const key = `${def.use}|${JSON.stringify(def.translate ?? [0, 0, 0])}`;
      const twin = instanceBodies.get(key);
      if (twin) {
        console.warn(`scene.json objects.${name}: identical to objects.${twin} ` +
                     '(same prototype, same place)');
      } else {
        instanceBodies.set(key, name);
      }
    }
    built.set(name, t);
    return t;
  }

  function operand(d, path, where) {
    if (!d) return null;
    return typeof d === 'string' ? named(d, path) : tree(d, path, where);
  }

  // Split candidates: planes along the axes and the four body diagonals, plus
  // spheres about the centroid. Each is tried at every gap between members
  // sorted along that projection.
  const SPLIT_DIRS = [[1,0,0], [0,1,0], [0,0,1], [1,1,1], [1,1,-1], [1,-1,1], [-1,1,1]]
    .map((d) => { const L = Math.hypot(...d); return d.map((v) => v / L); });

  // A split that separates every member without cutting any of them. Prefers
  // the most even one. `pref` is the running max of x+r from the low side,
  // `suf` the running min of x-r from the high side; a gap is clean when they
  // do not cross.
  function cleanSplit(items, project, makePrim) {
    const n = items.length;
    const arr = items.map((it, i) => ({ i, x: project(it.ball), r: it.ball.r }))
                     .sort((a, b) => a.x - b.x);
    const pref = new Array(n), suf = new Array(n);
    let m = -Infinity;
    for (let k = 0; k < n; k++) { m = Math.max(m, arr[k].x + arr[k].r); pref[k] = m; }
    m = Infinity;
    for (let k = n - 1; k >= 0; k--) { m = Math.min(m, arr[k].x - arr[k].r); suf[k] = m; }

    let cut = null;
    for (let k = 1; k < n; k++) {
      if (pref[k - 1] > suf[k]) continue;            // this gap would cut a member
      const bal = Math.abs(k - n / 2);
      if (!cut || bal < cut.bal) cut = { bal, k, t: 0.5 * (pref[k - 1] + suf[k]) };
    }
    if (!cut) return null;
    const prim = makePrim(cut.t);
    if (!prim) return null;
    return {
      prim,
      bal: cut.bal,
      inside:  arr.slice(0, cut.k).map((a) => items[a.i]),
      outside: arr.slice(cut.k).map((a) => items[a.i])
    };
  }

  // Fallback when nothing separates cleanly: split at the median and put any
  // member the surface crosses into *both* children. Subtree sharing makes
  // that one extra reference rather than a copy. Requires strict progress on
  // both sides so the recursion terminates.
  function looseSplit(items, project, makePrim) {
    const xs = items.map((it) => project(it.ball)).sort((a, b) => a - b);
    const t = xs[Math.floor(xs.length / 2)];
    const prim = makePrim(t);
    if (!prim) return null;
    const inside = [], outside = [];
    for (const it of items) {
      const x = project(it.ball), r = it.ball.r;
      if (x + r <= t) inside.push(it);
      else if (x - r >= t) outside.push(it);
      else { inside.push(it); outside.push(it); }
    }
    if (inside.length >= items.length || outside.length >= items.length) return null;
    return { prim, inside, outside, cost: Math.max(inside.length, outside.length) };
  }

  function chooseSplit(items) {
    const mid = [0, 1, 2].map((ax) =>
      items.reduce((s, it) => s + it.ball.c[ax], 0) / items.length);

    const tries = SPLIT_DIRS.map((d) => [
      (b) => b.c[0] * d[0] + b.c[1] * d[1] + b.c[2] * d[2],
      (t) => plane(d, t),
    ]);
    tries.push([(b) => dist3(b.c, mid), (t) => (t > 1e-6 ? sphere(mid, t) : null)]);

    let best = null;
    for (const [proj, mk] of tries) {
      const s = cleanSplit(items, proj, mk);
      if (s && (!best || s.bal < best.bal)) best = s;
    }
    if (best) return best;
    for (const [proj, mk] of tries) {
      const s = looseSplit(items, proj, mk);
      if (s && (!best || s.cost < best.cost)) best = s;
    }
    return best;
  }

  // If the root of the tree has no "outside" geomeetry and encloses no
  // points at infinity (i.e. it's a sphere or ellipsoid, in our system),
  // the tree is (trivially) self-bounded:
  const selfBounded = (t) =>
    t && !t.outside && regionBall(t.prim, true) !== null;

  // Memoized, so a member landing in two children stays one subtree. The
  // bounding sphere itself is never meant to be individually visible, so
  // NO_MATERIAL (vacuum) for it is correct, not just a placeholder: it.tree
  // supplies the real material wherever it actually gets hit, and the gap
  // between the two shows through as empty space either way.
  function wrap(it) {
    if (!it.wrapped) {
      it.wrapped = selfBounded(it.tree)
        ? it.tree
        : node(sphere(it.ball.c, it.ball.r), it.tree, null);
    }
    return it.wrapped;
  }

  function partition(items) {
    if (!items.length) return null;
    if (items.length === 1) return wrap(items[0]);
    const s = chooseSplit(items);
    if (!s) {                                      // no split makes progress
      let acc = null;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        acc = selfBounded(it.tree)
          ? node(it.tree.prim, it.tree.inside, acc, it.tree.material, it.tree.env, it.tree.prov)
          : node(sphere(it.ball.c, it.ball.r), it.tree, acc);
      }
      return acc;
    }
    return node(s.prim, partition(s.inside), partition(s.outside));
  }

  // "group" is a union plus an assertion: the members' bounding spheres are
  // mutually exterior. That claim is what lets a partition surface separate
  // them, giving a hierarchy instead of a linear chain. Because one node type
  // serves as both splitting surface and bounding volume, the result is a BSP
  // tree and a bounding volume hierarchy at the same time.
  function buildGroup(def, path, where) {
    if (!Array.isArray(def.group)) {
      at(path, 'group takes an array of subtrees, or names of entries under "objects"');
    }
    if (def.inside !== undefined || def.outside !== undefined) {
      at(path, 'group is a whole subtree, so it takes no inside or outside');
    }

    const parts = [];
    def.group.forEach((d, i) => {
      const p = `${path}.group[${i}]`;
      const label = typeof d === 'string' ? `"${d}"` : p;
      const t = operand(d, p, below(where, 'group', String(i)));
      if (t === BUILDING) at(p, `object ${label} refers to itself`);
      const b = boundOf(t, declared, boundMemo, table);
      if (b === NO_SOLID) return;                  // contributes nothing
      if (b === UNBOUNDED) {
        at(p, `${label} has no bounding sphere, so it cannot be a group member. ` +
              'Give it "bounds": { "center": [x, y, z], "radius": r }, or use union instead');
      }
      // Nudge outward so a surface lying exactly on its own bound is not
      // split by the test.
      parts.push({ label, tree: t, ball: { c: b.c, r: b.r * (1 + 1e-4) + 1e-6 } });
    });

    // A violated claim would silently drop geometry, so check it.
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const A = parts[i].ball, B = parts[j].ball;
        if (dist3(A.c, B.c) < A.r + B.r) {
          at(path, `${parts[i].label} and ${parts[j].label} are not mutually ` +
                   'exterior, so they cannot be grouped. Use union instead');
        }
      }
    }

    return partition(parts);
  }

  // The CSG combinations, all of them arrays of subtrees and all built the
  // same way: fold the operands together with the matching operator.
  // "group" is separate, being a union plus a disjointness claim.
  const COMBINERS = {
    union,
    intersect,
    difference,
  };

  const COMBINER_HELP = {
    union: 'keep everything inside both regions',
    intersect: 'keep only what\'s interior to both regions',
    difference: 'the first operand, minus every operand after it',
  };

  function buildCombination(def, path, where) {
    const op = Object.keys(COMBINERS).find((name) => def[name] !== undefined);
    const operands = def[op];
    if (!Array.isArray(operands)) {
      at(path, `${op} takes an array of subtrees, or names of entries under ` +
               `"objects": ${COMBINER_HELP[op]}`);
    }
    if (def.inside !== undefined || def.outside !== undefined) {
      at(path, `${op} is a whole subtree, so it takes no inside or outside`);
    }
    if (!operands.length) at(path, `${op} needs at least one operand`);
    return operands
      .map((d, i) => operand(d, `${path}.${op}[${i}]`, below(where, op, String(i))))
      .reduce(COMBINERS[op]);
  }

  function tree(def, path, where) {
    // Null or absent: no subdivision here.
    if (!def) return null;
    if (typeof def === 'string') at(path, `expected a subtree, got "${def}"`);

    let out;
    if (def.use !== undefined) {
      out = named(def.use, path);
      if (out === BUILDING) at(path, `object "${def.use}" refers to itself`);
    } else if (def.group !== undefined) {
      out = buildGroup(def, path, where);
    } else if (Object.keys(COMBINERS).some((op) => def[op] !== undefined)) {
      out = buildCombination(def, path, where);
    } else {
      // Both children default to null when unspecified - no further
      // subdivision - which the two slots still read differently: see
      // flatten()'s doc comment.
      const insideTree = tree(def.inside, `${path}.inside`, below(where, 'inside'));
      const outsideTree = tree(def.outside, `${path}.outside`, below(where, 'outside'));
      const { material, env } = materialAndEnvOf(def, path);
      out = node(primOf(def, path), insideTree, outsideTree, material, env, provOf(where));
    }

    // "complement" turns the whole subtree inside out: what was interior
    // becomes exterior and the other way about. Applied before any
    // transform, though the two commute - moving a region and then turning
    // it inside out is the same as doing it the other way round.
    //
    // On a bare primitive this is its own surface flipped, which is all it
    // used to do; on a node with children, or on a use, group, union,
    // intersect or difference, it now means what it says.
    if (def.complement) out = complement(out);

    // Places a subtree in the world by transforming every primitive in it -
    // see translateTree() and friends. These work on any of the branches
    // above, so an object built once under "objects" can be dropped wherever
    // it's needed via { "use": "name", "rotate": ..., "translate": ... }
    // rather than being copied and hand-edited per instance.
    //
    // When a node carries more than one, they apply in the order scale,
    // rotate, translate, which is what "make it this big, point it this way,
    // put it here" means. Anything else is expressible by nesting, since
    // each level transforms whatever the level below produced.
    if (def.scale !== undefined) {
      const { factor, pivot } = scaleSpec(def.scale, `${path}.scale`);
      out = scaleTree(out, factor, pivot);
    }

    if (def.rotate !== undefined) {
      const { rows, pivot } = rotateSpec(def.rotate, `${path}.rotate`);
      out = rotateTree(out, rows, pivot);
    }

    if (def.translate !== undefined) {
      if (!Array.isArray(def.translate) || def.translate.length !== 3) {
        at(`${path}.translate`, 'needs a [x, y, z] offset');
      }
      out = translateTree(out, def.translate);
    }

    if (def.bounds) {
      const { center, radius } = def.bounds;
      if (!center || !(radius > 0)) at(`${path}.bounds`, 'needs center and positive radius');
      declared.set(out, { c: center, r: radius });
    }
    return out;
  }


  if (!spec.root) at('root', 'missing');
  const nodes = flatten(bakeScopes(tree(spec.root, 'root', { owner: ROOT_OWNER, segments: [] })));
  return {
    nodes,
    // provenance[i] is { owner, path } for authored node i, or null for
    // node 0 and for nodes the compiler invented.
    provenance: nodes.map((n) => n.prov),
    materials: table,
    lights: lightList,
    camera: spec.camera || null,
  };
}

// 48 bytes per material:
//   u32 kind | u32 pattern | vec2 params | vec3 albedo | f32 scale | vec3 albedo2 | u32 solid
// Ordered so the two scalars and the vec2 fill the 16 bytes ahead of the first
// vec3, which has to start on a 16-byte boundary anyway.
export function packMaterials(list) {
  const buf = new ArrayBuffer(list.length * 48);
  const f = new Float32Array(buf), u = new Uint32Array(buf);
  list.forEach((m, j) => {
    const o = j * 12;
    u[o + 0] = m.kind;
    u[o + 1] = m.pattern;
    f[o + 2] = m.params[0];  f[o + 3]  = m.params[1];
    f[o + 4] = m.albedo[0];  f[o + 5]  = m.albedo[1];  f[o + 6]  = m.albedo[2];
    f[o + 7] = m.scale;
    f[o + 8] = m.albedo2[0]; f[o + 9]  = m.albedo2[1]; f[o + 10] = m.albedo2[2];
    u[o + 11] = m.solid ? 1 : 0;
  });
  return buf;
}

// 64 bytes per node: vec3 axis | f32 k_perp | vec3 linear | f32 k_delta |
//                    f32 const | u32 inside | u32 outside | i32 material |
//                    i32 env | 12 bytes pad.
//
// What goes to the GPU is not quite what a node stores: k_par arrives as
// curvature_delta = k_par - k_perp, and c arrives doubled, because those are
// the forms every runtime formula wants (see antisphere-raycast.wgsl's Node
// and trace()). Both are exactly recoverable, so nothing is lost, and the
// isotropic case falls out as curvature_delta == 0, which is also what tells
// the shader the axis can be ignored.
//
// inside/outside are 0 or a real index (see flatten()'s doc comment for
// what 0 means on each side); Int32Array vs. Uint32Array makes no
// difference here since they only ever hold small non-negative values -
// only antisphere-raycast.wgsl's own struct declaration needs to say u32.
//
// The 13 real words above are only 52 bytes, but WGSL's storage-array
// stride for a struct rounds up to a multiple of the struct's own
// alignment - 16, inherited from the leading vec3 - so the per-node
// stride is 64, not 52. Getting this wrong silently corrupts every node
// after the first, so if another field ever gets added here, recompute
// the stride the same way: lay out real words in order, then round the
// total up to the next multiple of 16.
export function packNodes(list) {
  const buf = new ArrayBuffer(list.length * 64);
  const f = new Float32Array(buf), i = new Int32Array(buf);
  list.forEach((nd, j) => {
    const o = j * 16;
    const { axis, k_par, k_perp, linear, constant } = nd.prim;
    f[o + 0] = axis[0];
    f[o + 1] = axis[1];
    f[o + 2] = axis[2];
    f[o + 3] = k_perp;
    f[o + 4] = 2 * linear[0];       // 2c
    f[o + 5] = 2 * linear[1];
    f[o + 6] = 2 * linear[2];
    f[o + 7] = k_par - k_perp;      // curvature_delta
    f[o + 8] = constant;
    i[o + 9] = nd.inside;
    i[o + 10] = nd.outside;
    i[o + 11] = nd.material;
    i[o + 12] = nd.env;
    // o+13..o+15 are the 12 bytes of trailing pad; left zeroed.
  });
  return buf;
}

// ---------------------------------------------------------------------------
// Lights
//
// Each light is a world position and an RGB color whose magnitude is its
// radiant power. Falloff is inverse square, so these run well above 1.
// If the list passed is empty, it will still pack a single light with color
// (0.0, 0.0, 0.0) to appease wgsl's requirement of buffer sizes > 0.
// ---------------------------------------------------------------------------

// 32 bytes per light: vec3 pos | pad | vec3 color | pad
export function packLights(list) {
  const buf = new ArrayBuffer((list.length || 1) * 32);
  const lval = new Float32Array(buf);
  list.forEach((lt, j) => {
    const o = j * 8;
    lval[o + 0] = lt.pos[0];
    lval[o + 1] = lt.pos[1];
    lval[o + 2] = lt.pos[2];
    lval[o + 4] = lt.color[0];
    lval[o + 5] = lt.color[1];
    lval[o + 6] = lt.color[2];
  });
  return lval;
}
