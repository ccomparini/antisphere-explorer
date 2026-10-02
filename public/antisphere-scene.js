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

import { Light, Material, Node } from './gen/layouts.js';
import { regionsDisjoint } from './overlap.js';

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

// Rotationally symmetric ellipsoid: `height` end to end along the axis, and
// `radius` around it - measured the way a cylinder's radius and a slab's
// thickness are, so height is the whole extent and radius is half of one.
// height = 2 * radius gives a sphere back.
function spheroid(centre, axis, height, radius) {
  const semiAxial = height / 2;
  return about(axis, 1 / (semiAxial * semiAxial), 1 / (radius * radius),
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

// ---------------------------------------------------------------------------
// Inverses
//
// Each constructor above turns an author's description into the nine numbers;
// each function here turns the nine numbers back into that description, which
// is what a property editor, a scene writer or a debug print needs. They take
// the numbers positionally - the fields of a prim - and return the arguments
// their constructor takes, plus `inverseOk`.
//
// `inverseOk` says whether the numbers really describe a shape of that kind,
// not whether they are the exact numbers the constructor would have written.
// H is only defined up to a positive multiple, so a shape that has been scaled
// - or complemented, or built by hand as a "quadric" - still inverts, and
// still gives back the lengths you would measure on it. A false means the
// values are a best effort at something that is not really that shape: the
// axis of a sphere, the radius of a cone.
//
// Where a shape is written about a centre, the centre is recovered as
// -K^-1 c, and the size from E = -(c.C + d), which is what the surface
// u K u = E has to say about how big it is.
// ---------------------------------------------------------------------------

// How big the numbers are, so "close enough to zero" can mean something.
function primScale(k_par, k_perp, linear, constant) {
  return Math.max(Math.abs(k_par), Math.abs(k_perp), Math.abs(constant),
                  Math.abs(linear[0]), Math.abs(linear[1]), Math.abs(linear[2]), 1e-30);
}

const nearZero = (v, scale) => Math.abs(v) <= 1e-9 * scale;

// The centre of a shape written about one: K C = -c, solved with
// K^-1 = (1/k_perp) I + (1/k_par - 1/k_perp) n(x)n. Needs both curvatures.
function centreOf(axis, k_par, k_perp, linear) {
  const along = dot3(linear, axis);
  return linear.map((v, i) =>
    -(v / k_perp + (1 / k_par - 1 / k_perp) * along * axis[i]));
}

/** sphere(center, radius) */
export function fromSphere(axis, k_par, k_perp, linear, constant) {
  const scale = primScale(k_par, k_perp, linear, constant);
  const k = k_perp;
  const isotropic = nearZero(k_par - k_perp, scale);
  const center = nearZero(k, scale) ? [0, 0, 0] : linear.map((v) => -v / k);
  const E = -(dot3(linear, center) + constant);
  const squared = E / k;
  return {
    center,
    radius: Math.sqrt(Math.abs(squared)),
    inverseOk: isotropic && !nearZero(k, scale) && squared > 0,
  };
}

/** plane(normal, offset) */
export function fromPlane(axis, k_par, k_perp, linear, constant) {
  const scale = primScale(k_par, k_perp, linear, constant);
  const length = 2 * Math.hypot(linear[0], linear[1], linear[2]);
  const flat = nearZero(k_par, scale) && nearZero(k_perp, scale);
  return {
    normal: length > 0 ? linear.map((v) => 2 * v / length) : axis.slice(),
    offset: length > 0 ? -constant / length : 0,
    inverseOk: flat && length > 0,
  };
}

/** spheroid(centre, axis, height, radius) */
export function fromSpheroid(axis, k_par, k_perp, linear, constant) {
  const scale = primScale(k_par, k_perp, linear, constant);
  const closed = !nearZero(k_par, scale) && !nearZero(k_perp, scale)
                 && (k_par > 0) === (k_perp > 0);
  const centre = closed ? centreOf(axis, k_par, k_perp, linear) : [0, 0, 0];
  const E = -(dot3(linear, centre) + constant);
  return {
    centre,
    axis: axis.slice(),
    height: 2 * Math.sqrt(Math.abs(E / k_par)),
    radius: Math.sqrt(Math.abs(E / k_perp)),
    inverseOk: closed && E / k_perp > 0,
  };
}

/** cylinder(centre, axis, radius) */
export function fromCylinder(axis, k_par, k_perp, linear, constant) {
  const scale = primScale(k_par, k_perp, linear, constant);
  const along = dot3(linear, axis);
  const across = linear.map((v, i) => v - along * axis[i]);
  // No curvature along the axis, and nothing pulling the centre along it.
  const straight = nearZero(k_par, scale) && !nearZero(k_perp, scale)
                   && nearZero(along, scale);
  const centre = nearZero(k_perp, scale) ? [0, 0, 0] : across.map((v) => -v / k_perp);
  const E = dot3(across, across) / k_perp - constant;
  return {
    centre,
    axis: axis.slice(),
    radius: Math.sqrt(Math.abs(E / k_perp)),
    inverseOk: straight && E / k_perp > 0,
  };
}

/** slab(centre, axis, thickness) */
export function fromSlab(axis, k_par, k_perp, linear, constant) {
  const scale = primScale(k_par, k_perp, linear, constant);
  const along = dot3(linear, axis);
  const across = linear.map((v, i) => v - along * axis[i]);
  const flatAcross = nearZero(k_perp, scale) && !nearZero(k_par, scale)
                     && nearZero(Math.hypot(across[0], across[1], across[2]), scale);
  // Along the axis this is k_par x^2 + 2(c.n)x + d: two parallel faces where
  // it vanishes, so the gap between them is what the discriminant measures.
  const discriminant = along * along - k_par * constant;
  const midpoint = nearZero(k_par, scale) ? 0 : -along / k_par;
  return {
    centre: axis.map((v) => v * midpoint),
    axis: axis.slice(),
    thickness: 2 * Math.sqrt(Math.abs(discriminant)) / Math.abs(k_par || 1),
    inverseOk: flatAcross && discriminant > 0,
  };
}

/** cone(apex, axis, slope) */
export function fromCone(axis, k_par, k_perp, linear, constant) {
  const scale = primScale(k_par, k_perp, linear, constant);
  const opposed = !nearZero(k_par, scale) && !nearZero(k_perp, scale)
                  && (k_par > 0) !== (k_perp > 0);
  const apex = opposed ? centreOf(axis, k_par, k_perp, linear) : [0, 0, 0];
  // A cone is the hyperboloid whose surface passes through its own centre.
  const E = -(dot3(linear, apex) + constant);
  return {
    apex,
    axis: axis.slice(),
    slope: Math.sqrt(Math.abs(k_par / k_perp)),
    inverseOk: opposed && k_perp > 0 && nearZero(E, scale),
  };
}

/** paraboloid(vertex, axis, focal) */
export function fromParaboloid(axis, k_par, k_perp, linear, constant) {
  const scale = primScale(k_par, k_perp, linear, constant);
  const along = dot3(linear, axis);
  const across = linear.map((v, i) => v - along * axis[i]);
  const open = nearZero(k_par, scale) && !nearZero(k_perp, scale)
               && !nearZero(along, scale);
  // |u_perp|^2 = 4 focal x, so the linear term along the axis is what opens
  // it, and the perpendicular part only says where its axis sits.
  const focal = -along / (2 * k_perp);
  const acrossCentre = across.map((v) => -v / k_perp);
  const acrossSquared = dot3(across, across) / k_perp;
  // |u_perp|^2 = (-2 c.n / k_perp)(x - x0), so the vertex sits along the axis
  // at x0 = (|c_perp|^2/k_perp - d) / (2 c.n). Writing that in terms of focal
  // instead would drop a factor of k_perp, which is 1 only before scaling.
  const vertexAlong = open ? (acrossSquared - constant) / (2 * along) : 0;
  return {
    vertex: acrossCentre.map((v, i) => v + vertexAlong * axis[i]),
    axis: axis.slice(),
    focal,
    inverseOk: open && k_perp > 0 && focal > 0,
  };
}

/** hyperboloid(centre, axis, radius, semiAxial, sheets) */
export function fromHyperboloid(axis, k_par, k_perp, linear, constant) {
  const scale = primScale(k_par, k_perp, linear, constant);
  const opposed = !nearZero(k_par, scale) && !nearZero(k_perp, scale)
                  && (k_par > 0) !== (k_perp > 0);
  const centre = opposed ? centreOf(axis, k_par, k_perp, linear) : [0, 0, 0];
  const E = -(dot3(linear, centre) + constant);
  // E is what the surface u K u = E is worth: positive leaves a waist about
  // the axis, negative leaves two cups facing each other, and zero is the
  // cone between the two cases.
  return {
    centre,
    axis: axis.slice(),
    radius: Math.sqrt(Math.abs(E / k_perp)),
    semiAxial: Math.sqrt(Math.abs(E / k_par)),
    sheets: E > 0 ? 1 : 2,
    inverseOk: opposed && k_perp > 0 && !nearZero(E, scale),
  };
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
// crossed (antisphere-raycast.wgsls's main() does
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

const PATTERNS = {
  flat             : 0,
  checker          : 1,
  noise            : 2,
  industrialcarpet : 3,
};

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
//
// Memoized, as are complement() and the tree transforms below: a subtree
// reachable along several paths (every operand after the first, once a
// union has grafted it onto each of a tree's empty outsides) is rebuilt
// once and stays shared. Without it, folding a union of n objects rebuilt
// the earlier ones once per path, and the tree doubled with each: 16
// capsules in physlab compiled to 196,613 nodes.
function union(t, other, memo = new Map()) {
  if (!t) return other;
  if (memo.has(t)) return memo.get(t);
  const out = node(t.prim,
                   t.inside ? union(t.inside, other, memo) : null,
                   union(t.outside, other, memo),
                   t.material, t.env, t.prov);
  memo.set(t, out);
  return out;
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
function complement(t, memo = new Map()) {
  if (!t) return t;
  if (memo.has(t)) return memo.get(t);
  const out = node(complementSurface(t.prim),
                   complement(t.outside, memo),
                   complement(t.inside, memo),
                   t.material, t.env, t.prov);
  memo.set(t, out);
  return out;
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
function translateTree(t, offset, memo = new Map()) {
  if (!t) return t;
  if (memo.has(t)) return memo.get(t);
  const out = node(translatePrim(t.prim, offset),
                   translateTree(t.inside, offset, memo),
                   translateTree(t.outside, offset, memo),
                   t.material, t.env, t.prov);
  memo.set(t, out);
  return out;
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
  return mapTree(t, turn);
}

function scaleTree(t, factor, pivot) {
  if (!t) return t;
  const back = pivot.map((v) => -v);
  const grow = (prim) => translatePrim(scalePrim(translatePrim(prim, back), factor), pivot);
  return mapTree(t, grow);
}

// A copy of a subtree with every primitive changed by f, shared structure
// kept shared.
function mapTree(t, f) {
  const memo = new Map();
  const walk = (u) => {
    if (!u) return u;
    if (memo.has(u)) return memo.get(u);
    const out = node(f(u.prim), walk(u.inside), walk(u.outside), u.material, u.env, u.prov);
    memo.set(u, out);
    return out;
  };
  return walk(t);
}

// Resolves material and ambient-env inheritance once, here, instead of
// once per ray in antisphere-raycast.wgsls's trace(). Both follow the same
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

// Node 0 is reserved: "no child at all" - antisphere-raycast.wgsls's
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

// ---------------------------------------------------------------------------
// Imports
//
// A scene can borrow the objects of other scene files:
//
//   "import": ["parts/bolt.json", "parts/frame.json"],
//   ...
//   { "use": "bolt:hex-head" }
//
// The name before the colon says which file an object came from, so two
// files may both have a "body" without arguing about it. By default that
// name is the file's own, without its directory or extension; write the
// import as an object to choose it: { "frame": "parts/frame-v2.json" }.
//
// Only objects and materials cross over. An imported file's root, lights
// and camera are how *it* is looked at, not part of what it offers.
//
// Loading is the caller's business, not the compiler's: compileScene() is
// synchronous and reads no files, so the parsed files are handed to it in
// `options.imports`. importsOf() says what a spec needs and loadImports()
// will fetch them all, including what they import in turn.
// ---------------------------------------------------------------------------

const IMPORT_SEPARATOR = ':';

/** The name an imported file goes by, when the scene doesn't say. */
function aliasFor(path) {
  const file = String(path).split(/[\\/]/).pop();
  return file.replace(/\.[^.]*$/, '');
}

/**
 * What this spec imports, as { alias, path } - including nothing, which is
 * the usual answer.
 */
export function importsOf(spec) {
  const declared = spec?.import;
  if (!declared) return [];
  if (Array.isArray(declared)) {
    return declared.map((path) => ({ alias: aliasFor(path), path }));
  }
  if (typeof declared === 'object') {
    return Object.entries(declared).map(([alias, path]) => ({ alias, path }));
  }
  throw new Error('scene.json import: needs a list of files, or a map of name to file');
}

/**
 * Fetch every file a spec imports, and every file those import, as a map
 * from path to parsed spec - the shape compileScene() wants.
 *
 * `read` takes a path and returns the parsed JSON, however the caller
 * likes: fetch in a browser, readFile in node. Paths are resolved relative
 * to the file that named them, which `read` sees as given.
 */
export async function loadImports(spec, read, { from = '', seen = new Map() } = {}) {
  for (const { path } of importsOf(spec)) {
    const resolved = resolvePath(from, path);
    if (seen.has(resolved)) continue;
    seen.set(resolved, null);                      // claim it before recursing
    let imported;
    try {
      imported = await read(resolved);
    } catch (cause) {
      throw new Error(`cannot read imported scene "${resolved}": ${cause.message}`);
    }
    seen.set(resolved, imported);
    await loadImports(imported, read, { from: resolved, seen });
  }
  const loaded = {};
  for (const [path, value] of seen) if (value) loaded[path] = value;
  return loaded;
}

/** Where a path named inside `from` actually points. */
function resolvePath(from, path) {
  if (!from || path.startsWith('/')) return path;
  const directory = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  if (!directory) return path;
  const parts = (directory + path).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return (path.startsWith('/') ? '/' : '') + out.join('/');
}

/** Every array of subtrees a node can carry. */
const SUBTREE_ARRAYS = ['group', 'union', 'intersect', 'difference'];

/**
 * Copy a subtree, renaming the objects and materials it names. Everything
 * else - shapes, transforms, bounds - is carried over untouched.
 */
function renameWithin(def, renameObject, renameMaterial) {
  if (def === null || def === undefined) return def;
  if (typeof def === 'string') return renameObject(def);
  if (Array.isArray(def)) return def.map((d) => renameWithin(d, renameObject, renameMaterial));
  if (typeof def !== 'object') return def;

  const out = { ...def };
  if (typeof def.use === 'string') out.use = renameObject(def.use);
  if (typeof def.material === 'string') out.material = renameMaterial(def.material);
  if (typeof def.paint === 'string' && !LEGACY_PAINT_WORDS.includes(def.paint)) {
    out.paint = renameMaterial(def.paint);
  }
  for (const side of ['inside', 'outside']) {
    if (side in def) out[side] = renameWithin(def[side], renameObject, renameMaterial);
  }
  for (const op of SUBTREE_ARRAYS) {
    if (Array.isArray(def[op])) {
      out[op] = def[op].map((d) => renameWithin(d, renameObject, renameMaterial));
    }
  }
  return out;
}

/**
 * Fold every imported file's objects and materials into one spec, under
 * prefixed names. The result imports nothing and compiles like any other
 * scene, which is how the rest of the compiler stays unaware of all this.
 */
export function resolveImports(spec, imports = {}, { from = '', trail = [] } = {}) {
  const wanted = importsOf(spec);
  if (!wanted.length) return spec;

  // Two files under one name would quietly become one file. The fix is to
  // name them, so say so.
  const byAlias = new Map();
  for (const { alias, path } of wanted) {
    if (byAlias.has(alias) && byAlias.get(alias) !== path) {
      throw new Error(`scene.json import: "${byAlias.get(alias)}" and "${path}" would both ` +
                      `be called "${alias}". Name one of them: ` +
                      `"import": { "${alias}-2": "${path}" }`);
    }
    byAlias.set(alias, path);
  }

  const merged = { ...spec, objects: { ...(spec.objects || {}) },
                   materials: { ...(spec.materials || {}) } };
  delete merged.import;

  // What this scene says itself, which an import never overwrites: writing
  // "bolt:steel" here is how you re-skin an imported part without editing
  // the file it came from.
  const ownObjects = new Set(Object.keys(spec.objects || {}));
  const ownMaterials = new Set(Object.keys(spec.materials || {}));

  for (const { alias, path } of wanted) {
    const resolved = resolvePath(from, path);
    if (trail.includes(resolved)) {
      throw new Error(`scene.json import: "${resolved}" imports itself, by way of ` +
                      trail.join(' -> '));
    }
    const imported = imports[resolved] ?? imports[path];
    if (!imported) {
      throw new Error(`scene.json import: nothing supplied for "${resolved}". ` +
                      'Load it first - see loadImports() - and pass it in options.imports');
    }

    // Flatten what it imports before taking its objects, so a name it
    // borrowed arrives already spelled the way it spells it.
    const flat = resolveImports(imported, imports,
                                { from: resolved, trail: [...trail, resolved] });
    const prefixed = (name) => `${alias}${IMPORT_SEPARATOR}${name}`;
    const renameObject = (name) => (flat.objects && name in flat.objects ? prefixed(name) : name);
    const renameMaterial = (name) =>
      (flat.materials && name in flat.materials ? prefixed(name) : name);

    for (const [name, body] of Object.entries(flat.objects || {})) {
      const key = prefixed(name);
      if (ownObjects.has(key)) continue;                  // the scene's own wins
      merged.objects[key] = renameWithin(body, renameObject, renameMaterial);
    }
    for (const [name, material] of Object.entries(flat.materials || {})) {
      const key = prefixed(name);
      if (ownMaterials.has(key)) continue;                // likewise
      merged.materials[key] = material;
    }
  }
  return merged;
}

// -- gravity and spawn ---------------------------------------------------------------
//
// Not geometry, so the renderer and editor ignore them; whatever simulates
// the scene (physlab) reads them from compileScene()'s result.

const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const isPositive = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;

/**
 * A scene's gravity (scene-format.md), checked and normalized:
 *   { kind: 'uniform', down: unit [x, y, z], strength }  - the same everywhere
 *   { kind: 'central', center, strength, radius, gm }     - towards center,
 *     strength at radius, falling off as 1 / r^2 (gm = strength radius^2)
 * Absent, it is uniform, 9.81 down -Z. `at(path, message)` reports a problem.
 */
export function parseGravity(def, at = (path, msg) => { throw new Error(`${path}: ${msg}`); }) {
  if (def === undefined) return { kind: 'uniform', down: [0, 0, -1], strength: 9.81 };
  if (def === null || typeof def !== 'object' || Array.isArray(def)) at('gravity', 'must be an object');
  if (!isPositive(def.strength)) at('gravity.strength', `must be a positive number, got ${JSON.stringify(def.strength)}`);
  if ('down' in def === 'center' in def) at('gravity', 'needs one of "down" (uniform) or "center" (central)');
  if ('down' in def) {
    const len = isVec3(def.down) ? Math.hypot(...def.down) : 0;
    if (!(len > 0)) at('gravity.down', `must be a direction [x, y, z], got ${JSON.stringify(def.down)}`);
    return { kind: 'uniform', down: def.down.map((v) => v / len), strength: def.strength };
  }
  if (!isVec3(def.center)) at('gravity.center', `must be a point [x, y, z], got ${JSON.stringify(def.center)}`);
  if (!isPositive(def.radius)) at('gravity.radius', `must be a positive number, got ${JSON.stringify(def.radius)}`);
  return { kind: 'central', center: def.center.slice(), strength: def.strength, radius: def.radius,
           gm: def.strength * def.radius * def.radius };
}

/** A scene's spawn point (scene-format.md): { at, facing }, or null if it names none. */
export function parseSpawn(def, at = (path, msg) => { throw new Error(`${path}: ${msg}`); }) {
  if (def === undefined) return null;
  if (def === null || typeof def !== 'object' || !isVec3(def.at)) at('spawn.at', 'must be a point [x, y, z]');
  const facing = def.facing ?? [1, 0, 0];
  if (!isVec3(facing) || !(Math.hypot(...facing) > 0)) at('spawn.facing', `must be a direction [x, y, z], got ${JSON.stringify(def.facing)}`);
  return { at: def.at.slice(), facing: facing.slice() };
}

export function compileScene(rawSpec, options = {}) {
  const at = (path, msg) => { throw new Error(`scene compilation: ${path}: ${msg}`); };

  // Imported files are folded in before anything else looks at the spec, so
  // everything below sees one ordinary scene whose objects happen to have
  // colons in some of their names.
  const spec = resolveImports(rawSpec, options.imports ?? {}, { from: options.path ?? '' });
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
    const scale = def.scale ?? 1;
    if (!(typeof scale === 'number' && scale > 0 && Number.isFinite(scale))) {
      at(`materials.${name}.scale`, `must be a positive number, got ${JSON.stringify(def.scale)}`);
    }
    table.push({
      albedo:  def.albedo  ?? [0.7, 0.7, 0.7],
      albedo2: def.albedo2 ?? [0.3, 0.3, 0.3],
      scale,
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
      // Same words as a cylinder where they mean the same thing: radius is
      // around the axis, height is end to end along it. The default is the
      // unit sphere, though presumably some parameter will be given.
      def.center ??= [ 0.0, 0.0, 0.0 ];
      def.axis   ??= [ 0.0, 1.0, 0.0 ];
      def.height ??= 2.0;
      def.radius ??= 1.0;
      // We expect but do not require both to be > 0; warn, and let the author
      // see what comes out.
      const bads = [ ];
      if (def.height <= 0) bads.push('height');
      if (def.radius <= 0) bads.push('radius');
      if (bads.length) {
        const badstr = bads.map(bad => bad + " == " + def[bad]).join(', ');
        warn(path, `not a spheroid: ${badstr} should ${bads.length > 1 ? 'all ' : ''}be > 0`);
      }
      return spheroid(def.center, def.axis, def.height, def.radius);
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

  // "group" is a union, built so that each member hangs only where it can
  // be. Nodes only divide space, so this is said in their terms alone: a
  // member claims the regions its absent insides mark (whatever material
  // fills them - vacuum included), and defers everywhere else through its
  // absent outsides. Members are folded in in order, like union: each one,
  // B, is grafted into the absent outsides of the tree so far - never into
  // a claimed region, where the earlier claim stands - but only where B
  // may be. Going down, each node's region is tested against B, and once B
  // is proved clear of the region so far, nothing below is touched and it
  // stays shared; copies are made only on the way to where B goes.
  //
  // So each member's own surfaces divide the space around it for the
  // members after it: B hangs off only the faces of an earlier octahedron
  // that it is beyond, and those faces do double duty as its dividers.
  // Earlier members sit higher, so order is the tree's shape.
  //
  // A node reached by several ways in (shared) is grafted once for each
  // set of B's paths still possible on arrival, which is all that decides
  // what happens below it.
  //
  // Pruning only ever skips a slot B was proved clear of, so the result
  // is the union's whatever the proofs manage; a missed proof just costs a
  // graft. And where B reaches a region an earlier member A claims without
  // being proved clear of it, the two may overlap, and are reported:
  // `overlaps`, a broad phase for whatever cares what fills them (physics).
  //
  // The proofs: a node's region knocks B out if it is disjoint from B's
  // ball, or from one of the regions on each of B's paths to what it claims
  // (regionsDisjoint, exact for a pair). A member's "bounds", when given,
  // is its only test shape - it says where the member may be, which for a
  // moving body includes where it may move to. Otherwise its paths are
  // used, and its ball if what it claims is bounded.

  // How much grafting one member may do, in nodes visited, before it falls
  // back to a plain union (the same result, just unpruned, and then
  // reported against every member before it).
  const GRAFT_BUDGET = 20000;
  // Claimed paths past this many are not used for proofs (the ball still
  // is).
  const PROOF_PATHS = 64;

  const UNPROVEN = Symbol('unproven');

  // boundOf() asks which regions are solid; here every absent inside is a
  // claim, whatever fills it.
  const claimTable = new Proxy({}, { get: () => ({ solid: true }) });
  const claimMemo = new Map();

  // A member's claimed regions, as the paths down to them - [{ prim, sign }]
  // each - or null if there are more than `limit`.
  function treePaths(t, limit = PROOF_PATHS) {
    const out = [];
    let over = false;
    const walk = (n, carried) => {
      if (over) return;
      const inside = [...carried, { prim: n.prim, sign: 1 }];
      if (n.inside) walk(n.inside, inside);
      else {
        out.push(inside);
        if (out.length > limit) over = true;
      }
      if (n.outside) walk(n.outside, [...carried, { prim: n.prim, sign: -1 }]);
    };
    if (t) walk(t, []);
    return over ? null : out;
  }

  // What a member is tested as: { ball, paths, frame, bound }. `bound` is
  // its ball as { c, r }, or null if what it claims is unbounded. `frame` is where
  // the proofs measure: about the member's own ball, so that a small member
  // far from the origin, beside something big, is proved apart only where
  // it really is (see regionsDisjoint).
  function testShapeOf(t) {
    const b = boundOf(t, declared, claimMemo, claimTable);
    const bounded = b && b !== UNBOUNDED;
    const ball = bounded ? sphere(b.c, b.r * (1 + 1e-4) + 1e-6) : null;
    const frame = bounded ? { c: b.c, L: b.r } : null;
    const bound = bounded ? { c: b.c, r: b.r } : null;
    const grown = bounded ? { c: b.c, r: b.r * (1 + 1e-4) + 1e-6 } : null;   // as `ball` is
    if (declared.has(t)) return { ball, paths: null, frame, bound, grown };
    return { ball, paths: treePaths(t), frame, bound, grown };
  }

  // Whether a ball ({ c, r }) is clear of a region, where that is exact and
  // cheap: a half-space (a plane) or a sphere's inside or outside. Touching
  // counts as clear, as it does for regionsDisjoint. Undefined for any
  // other quadric, for the certificate to decide.
  function ballClear(prim, sign, ball) {
    const { k_par: kp, k_perp: k, linear: c, constant: d } = prim;
    if (kp !== k) return undefined;
    const p = ball.c, r = ball.r;
    if (k === 0) {
      // H = 2 c.x + d: over the ball, sign H is least at its centre less r |2c|.
      const h = 2 * (c[0] * p[0] + c[1] * p[1] + c[2] * p[2]) + d;
      return sign * h >= 2 * Math.hypot(c[0], c[1], c[2]) * r;
    }
    // H = k |x|^2 + 2 c.x + d: a sphere about q = -c / k, of radius R.
    const q = c.map((v) => -v / k);
    const R2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] - d / k;
    if (!(R2 > 0)) return undefined;
    const R = Math.sqrt(R2), apart = dist3(p, q);
    return sign * k > 0 ? apart >= R + r          // its inside: the two balls apart
                        : apart + r <= R;         // its outside: the ball within it
  }

  // Whether B is proved clear of a region once it is also inside `region`
  // ({ prim, sign }): the paths of B still alive are those no region so
  // far has knocked out. Returns the new alive list, or null once B is
  // clear. A shape with no paths to prove with (only a ball, or too many)
  // starts from UNPROVEN, which only the ball can clear.
  function knock(shape, alive, region) {
    if (shape.bound) {
      const quick = ballClear(region.prim, region.sign, shape.grown);
      if (quick === true) return null;
      if (quick === undefined && regionsDisjoint(region.prim, region.sign, shape.ball, 1, shape.frame)) return null;
    }
    if (alive === UNPROVEN) return alive;
    const left = alive.filter((p) => !p.some((r) => regionsDisjoint(region.prim, region.sign, r.prim, r.sign, shape.frame)));
    return left.length ? left : null;
  }

  // The longest chain of members a fold may make before they are divided
  // (see divide in buildGroup).
  const MAX_CHAIN = 4;

  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // Divider directions: planes square to the axes and the four body
  // diagonals (and spheres, see chooseDivider).
  const DIVIDER_DIRS = [[1,0,0], [0,1,0], [0,0,1], [1,1,1], [1,1,-1], [1,-1,1], [-1,1,1]]
    .map((d) => { const L = Math.hypot(...d); return d.map((v) => v / L); });

  // The plane that best divides `list`: members whose ball is wholly on its
  // inside go there, wholly outside go there, and the rest - crossing it,
  // or unbounded - go to both. Along each direction, a cut in a gap
  // between members is tried first (the most even one), crossing nothing:
  // a cut through members' centres, in a grid of beads, went through a
  // whole row of them and put each on both sides. With no gap, the
  // median. Best overall is the one whose bigger side is smallest; one
  // that leaves either side with everything makes no progress, and is no
  // divider. Null if none helps.
  function chooseDivider(list, presorted) {
    let best = null;
    // A candidate: xOf measures a member along it (1-Lipschitz, so a ball
    // of radius r spans at most x - r .. x + r), and `make` is the divider
    // at t, whose inside is where x < t.
    const consider = (xOf, make, t) => {
      const inside = [], outside = [];
      for (const m of list) {
        const b = m.shape.bound;
        const x = b ? xOf(m) : 0;
        if (b && x + b.r <= t) inside.push(m);
        else if (b && x - b.r >= t) outside.push(m);
        else { inside.push(m); outside.push(m); }
      }
      if (inside.length >= list.length || outside.length >= list.length) return;
      const cost = Math.max(inside.length, outside.length);
      if (!best || cost < best.cost) {
        const prim = make(t);
        if (prim) best = { prim, inside, outside, cost };
      }
    };
    // The cut along one candidate, from its bounded members sorted by x:
    // in a gap if there is one (the most even), else at the median.
    const cutAlong = (sorted, xOf, make) => {
      const n = sorted.length;
      if (n < 2) return;
      // pref[k]: the furthest reach of the first k + 1; suf[k]: the nearest
      // of the rest from k on. A gap before k when pref[k - 1] <= suf[k].
      const pref = [], suf = [];
      sorted.forEach((e, k) => { pref[k] = Math.max(k ? pref[k - 1] : -Infinity, e.x + e.r); });
      for (let k = n - 1; k >= 0; k--) suf[k] = Math.min(k < n - 1 ? suf[k + 1] : Infinity, sorted[k].x - sorted[k].r);
      let gap = null;
      for (let k = 1; k < n; k++) {
        if (pref[k - 1] > suf[k]) continue;
        const off = Math.abs(k - n / 2);
        if (!gap || off < gap.off) gap = { off, t: 0.5 * (pref[k - 1] + suf[k]) };
      }
      consider(xOf, make, gap ? gap.t : sorted[Math.floor(n / 2)].x);
    };
    // Planes: each direction's order is the group's, sorted once
    // (presorted), kept to this list's members.
    const here = new Set(list);
    DIVIDER_DIRS.forEach((d, i) => {
      const xs = presorted.xs[i];
      cutAlong(presorted.order[i].filter((e) => here.has(e.m)), (m) => xs.get(m), (t) => plane(d, t));
    });
    // Spheres about the members' middle, for things laid out round one.
    const bounded = list.filter((m) => m.shape.bound);
    const mid = [0, 1, 2].map((k) => bounded.reduce((sum, m) => sum + m.shape.bound.c[k], 0) / Math.max(1, bounded.length));
    const xOf = (m) => dist3(m.shape.bound.c, mid);
    cutAlong(bounded.map((m) => ({ m, x: xOf(m), r: m.shape.bound.r })).sort((p, q) => p.x - q.x),
             xOf, (t) => (t > 1e-6 ? sphere(mid, t) : null));
    return best;
  }

  // Each divider direction's order of a group's bounded members, sorted
  // once for every chooseDivider below it: { order[i]: [{ m, x, r }],
  // xs[i]: Map(member -> x) }.
  function presort(members) {
    const bounded = members.filter((m) => m.shape.bound);
    const order = [], xs = [];
    for (const d of DIVIDER_DIRS) {
      const along = new Map(bounded.map((m) => [m, dot3(m.shape.bound.c, d)]));
      xs.push(along);
      order.push(bounded.map((m) => ({ m, x: along.get(m), r: m.shape.bound.r })).sort((p, q) => p.x - q.x));
    }
    return { order, xs };
  }


  function buildGroup(def, path, where) {
    if (!Array.isArray(def.group)) {
      at(path, 'group takes an array of subtrees, or names of entries under "objects"');
    }
    if (def.inside !== undefined || def.outside !== undefined) {
      at(path, 'group is a whole subtree, so it takes no inside or outside');
    }
    if (def.overlapping !== undefined) {
      warn(`${path}.overlapping`, 'no longer needed: every group allows overlap and reports it');
    }

    const members = [];
    def.group.forEach((d, i) => {
      const p = `${path}.group[${i}]`;
      const label = typeof d === 'string' ? `"${d}"` : p;
      const t = operand(d, p, below(where, 'group', String(i)));
      if (t === BUILDING) at(p, `object ${label} refers to itself`);
      if (t) members.push({ index: i, tree: t });
    });

    const memberOf = new Map();            // node -> the member it is (a copy of) part of
    const mark = (t, index) => {
      const walk = (n) => {
        if (!n || memberOf.has(n)) return;
        memberOf.set(n, index);
        walk(n.inside);
        walk(n.outside);
      };
      walk(t);
    };
    const found = new Map();               // "i,j" -> [i, j], from the folds kept
    // Each fold collects its own reports, kept only if the fold is.
    let folding = null;
    const report = (a, b) => {
      if (a === undefined || a === b) return;
      const pair = a < b ? [a, b] : [b, a];
      folding.set(pair.join(), pair);
    };

    // Each member with a bound goes inside a sphere of its own: a pure
    // division - its inside holds the member, its outside defers - so a
    // ray that misses the ball passes the member with one test. Nothing
    // asks these balls to stay apart: where they overlap, members are
    // grafted inside each other's as anywhere else. (Measured: without
    // them, rays visited 20-85% more nodes, mostly members whose own top
    // node is unbounded, such as a house under its roof's plane.) A member
    // whose own top node already is such a sphere, with nothing outside
    // it, is left as it is; one with no bound (an octahedron given none)
    // keeps its own faces as the divisions round it.
    for (const m of members) {
      m.shape = testShapeOf(m.tree);
      const b = m.shape.grown;
      if (b && !(regionBall(m.tree.prim, true) && !m.tree.outside)) m.tree = node(sphere(b.c, b.r), m.tree, null);
    }

    // Fold `list` in, in order: each member grafted into the absent
    // outsides of what the ones before it made, where it may be.
    const fold = (list) => {
    folding = new Map();
    let acc = null;
    const earlier = [];
    for (const m of list) {
      if (!acc) {
        acc = m.tree;
      } else {
        const shape = m.shape;
        let budget = GRAFT_BUDGET;
        // What happens below a node depends only on which of B's paths are
        // still possible when it gets there (each region knocks paths out
        // on its own), so a result is reused for that pair: the same node
        // reached another way with the same paths possible. Keyed by node
        // alone, a node shared by two ways in would take the first way's
        // answer for both.
        const pathIndex = new Map((shape.paths ?? []).map((p, i) => [p, i]));
        const aliveKey = (alive) => (alive === UNPROVEN ? '*' : alive.map((p) => pathIndex.get(p)).join());
        const done = new Map();            // node -> Map(aliveKey -> result)
        const graft = (t, alive) => {
          let byAlive = done.get(t);
          if (!byAlive) { byAlive = new Map(); done.set(t, byAlive); }
          const key = aliveKey(alive);
          if (!byAlive.has(key)) byAlive.set(key, graftOnce(t, alive));
          return byAlive.get(key);
        };
        const graftOnce = (t, alive) => {
          if (--budget < 0) throw GRAFT_BUDGET;
          let inside = t.inside, outside = t.outside;
          const owner = memberOf.get(t);
          const inAlive = knock(shape, alive, { prim: t.prim, sign: 1 });
          if (inAlive !== null) {
            if (t.inside) inside = graft(t.inside, inAlive);
            else report(owner, m.index);           // a region `owner` claims: the claim stands
          }
          const outAlive = knock(shape, alive, { prim: t.prim, sign: -1 });
          if (outAlive !== null) outside = t.outside ? graft(t.outside, outAlive) : m.tree;
          if (inside === t.inside && outside === t.outside) return t;
          const copy = node(t.prim, inside, outside, t.material, t.env, t.prov);
          if (owner !== undefined) memberOf.set(copy, owner);
          return copy;
        };
        try {
          acc = graft(acc, shape.paths ?? UNPROVEN);
        } catch (e) {
          if (e !== GRAFT_BUDGET) throw e;
          acc = union(acc, m.tree);
          for (const i of earlier) report(i, m.index);
        }
      }
      mark(m.tree, m.index);
      earlier.push(m.index);
    }
    return { tree: acc, reports: folding };
    };

    // The most members met one after another on any way down a tree:
    // how many a ray may have to get through, one by one.
    const chainOf = (t) => {
      const memo = new Map();
      const walk = (n) => {
        if (!n) return 0;
        if (memo.has(n)) return memo.get(n);
        memo.set(n, 0);                    // (a cycle can't happen; this just guards)
        const own = memberOf.get(n);
        const next = (c) => (c ? walk(c) + (memberOf.get(c) !== own ? 1 : 0) : 0);
        const len = Math.max(next(n.inside), next(n.outside));
        memo.set(n, len);
        return len;
      };
      return t ? 1 + walk(t) : 0;
    };
    const keep = (folded) => {
      for (const [k, pair] of folded.reports) found.set(k, pair);
      return folded.tree;
    };

    // Fold first; divide only where that makes a long chain. Members whose
    // surfaces divide space (planes: a cube, an octahedron) spread the
    // later ones over their faces and need no dividers. But a member whose
    // outside is everything else (a sphere) leaves the next only its
    // outside, and so on: a chain, which rays walk member by member, and
    // which, long enough, overflows trace()'s stack. Then the members are
    // divided (chooseDivider) and each side tried the same way. Members
    // keep their order within each side, so where they overlap the earlier
    // claim still stands.
    //
    // A fold of members each topped by a sphere with nothing outside it (a
    // division sphere, a bare ball) chains them all - each one's outside is
    // everything else - so with more than MAX_CHAIN of those it is known to
    // chain without building it: a physlab world, a planet and 40 bodies,
    // built and threw away a whole fold at every level, half its compile.
    const closed = (m) => m.tree && !m.tree.outside && regionBall(m.tree.prim, true);
    const divide = (list) => {
      const chains = list.filter(closed).length > MAX_CHAIN;
      const folded = chains ? null : fold(list);
      if (folded && (list.length <= 1 || chainOf(folded.tree) <= MAX_CHAIN)) return keep(folded);
      const split = chooseDivider(list, sorted);
      if (!split) return keep(folded ?? fold(list));
      const inside = divide(split.inside), outside = divide(split.outside);
      // A divider has both children, or defers on one side: never an
      // absent inside, which would claim that side, and hide whatever is
      // later unioned with the group there. So an empty side goes outside.
      if (!inside) return node(complementSurface(split.prim), outside, null);
      return node(split.prim, inside, outside);
    };
    const sorted = presort(members);
    const acc = divide(members);
    for (const pair of found.values()) overlaps.push({ group: path, members: pair });
    return acc;
  }

  // The CSG combinations, all of them arrays of subtrees and all built the
  // same way: fold the operands together with the matching operator.
  // "group" is separate: a union too, but built to hang each member only
  // where it can be (buildGroup).
  // (Wrapped: reduce() passes an index and the array too, and union() would
  // take the index for its memo.)
  const COMBINERS = {
    union: (a, b) => union(a, b),
    intersect: (a, b) => intersect(a, b),
    difference: (a, b) => difference(a, b),
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
  const overlaps = [];
  const nodes = flatten(bakeScopes(tree(spec.root, 'root', { owner: ROOT_OWNER, segments: [] })));
  return {
    nodes,
    // provenance[i] is { owner, path } for authored node i, or null for
    // node 0 and for nodes the compiler invented.
    provenance: nodes.map((n) => n.prov),
    materials: table,
    lights: lightList,
    camera: spec.camera || null,
    gravity: parseGravity(spec.gravity, (path, msg) => at(path, msg)),
    spawn: parseSpawn(spec.spawn, (path, msg) => at(path, msg)),
    // For each group, the members that may overlap - whose overlap its
    // pruning couldn't rule out (buildGroup): { group: its path, members:
    // [i, j] }, indices into its array, i < j.
    overlaps,
  };
}

// A material as the GPU stores it: Material in shaders/antisphere-raycast.wgsls,
// written through the Material class generated from it. solid crosses as
// u32, since bool can't be shared with the GPU.
export function packMaterials(list) {
  const views = Material.allocate(list.length);
  list.forEach((m, j) => {
    Material.write(views, j, {
      kind: m.kind,
      pattern: m.pattern,
      params: m.params,
      albedo: m.albedo,
      scale: m.scale,
      albedo2: m.albedo2,
      solid: m.solid ? 1 : 0,
    });
  });
  return views.buffer;
}

// Where each node's coefficients are measured from: its anchor, a point
// near its own surface. Expanded about the world origin, a quadric 500 m
// out has terms of 250000 k that cancel to the small H near its surface,
// and in f32 that leaves few correct digits: hits wander by centimetres,
// grazing rays flip, and physlab's rocket flickered at rest. About a point
// near the surface nothing cancels, wherever the node is.
//
// A quadric's anchor is its centre where it has one - a sphere's, a
// spheroid's or a hyperboloid's centre, a cone's apex, a paraboloid's
// vertex. A cylinder or a slab has a centre line or plane but no point;
// its anchor is that one's point nearest the origin, which may be far from
// the object - but the shaders take a cylinder's H across its axis and a
// slab's along it, so the part of the anchor in the free direction never
// enters (see trace()). A plane's anchor is the origin, as before: its
// terms are linear, and don't cancel.
//
// And a shape whose centre is within twice its size of the origin keeps
// the origin, as before: about the origin is then as good, and better for
// a big one whose surface passes near it - a planetoid's surface is 500 m
// from its centre, but its points by the origin are right there.
export function anchorOf({ axis: n, k_par, k_perp, linear: c, constant }) {
  // A curvature negligible next to the other is none: turning a cylinder
  // leaves its k_par at 1e-16 or so, not 0, and dividing by that put its
  // anchor 4e15 m away.
  const most = Math.max(Math.abs(k_par), Math.abs(k_perp));
  if (most === 0) return [0, 0, 0];                               // a plane
  const curvedAlong = Math.abs(k_par) > 1e-9 * most;
  const curvedAcross = Math.abs(k_perp) > 1e-9 * most;
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const along = dot(n, c);
  let a = [0, 0, 0];
  if (curvedAlong) {
    // Along the axis: where the axial part of H turns.
    const s = -along / k_par - dot(n, a);
    a = a.map((v, i) => v + s * n[i]);
  }
  if (curvedAcross) {
    // Across it: on the axis (or, isotropic, at the centre).
    const t = dot(n, a);
    a = n.map((v, i) => t * v - (c[i] - along * v) / k_perp);
  }
  // A paraboloid's linear term along its axis is k times its focal length
  // or so; a cylinder's is 0, give or take rounding - which is a large part
  // of all of its linear term when its axis passes near the origin. So
  // compare with k times a length: a metre, or how far out the axis is.
  if (!curvedAlong && curvedAcross && Math.abs(along) > 1e-9 * most * Math.max(1, Math.hypot(...a))) {
    // A paraboloid: along its axis to its vertex, where H = 0.
    const s = -quadricAt({ axis: n, k_par, k_perp, linear: c, constant }, a) / (2 * along);
    a = a.map((v, i) => v + s * n[i]);
  }
  // Its size: how far its surface is from the centre, as for a sphere
  // (H = k (d^2 - r^2)) - 0 for a cone or a paraboloid, whose surface goes
  // through it.
  const size = Math.sqrt(Math.abs(quadricAt({ axis: n, k_par, k_perp, linear: c, constant }, a)) / most);
  return Math.hypot(...a) <= 2 * size ? [0, 0, 0] : a;
}

// H at a point, from a prim: x.K.x + 2 c.x + d.
function quadricAt({ axis: n, k_par, k_perp, linear: c, constant }, x) {
  const ax = n[0] * x[0] + n[1] * x[1] + n[2] * x[2];
  return k_perp * (x[0] * x[0] + x[1] * x[1] + x[2] * x[2]) + (k_par - k_perp) * ax * ax +
         2 * (c[0] * x[0] + c[1] * x[1] + c[2] * x[2]) + constant;
}

// Which nodes are the same surface, as a u32 per node: the same id for
// every copy of one - grafting and dividers copy nodes, sharing their prim -
// and for its complement, which negates every coefficient but the axis; ids
// from 1, and 0 for node 0. trace() uses them to recognise the surface a
// ray starts on, every copy of it, with one integer compare (see RayQuery in
// shaders/antisphere-raycast.wgsls). Keyed on the prim, its sign
// normalised: the first of its non-zero numbers made positive.
export function packSurfaces(list) {
  const ids = new Map();
  const out = new Uint32Array(Math.max(1, list.length));
  list.forEach((nd, j) => {
    if (j === 0 || !nd) return;
    const { axis, k_par, k_perp, linear, constant } = nd.prim;
    const signed = [k_perp, k_par, constant, ...linear];
    const first = signed.find((v) => v !== 0) ?? 1;
    const s = first < 0 ? -1 : 1;
    const key = [...axis, ...signed.map((v) => v * s + 0)].join();     // + 0: no -0
    if (!ids.has(key)) ids.set(key, ids.size + 1);
    out[j] = ids.get(key);
  });
  return out;
}

// A node as the GPU stores it: shaders/node.wgsls's Node, whose layout
// tools/build-shaders.mjs generates into the Node class, so the offsets and
// the 64-byte stride live in one place.
//
// What goes to the GPU is not quite what a node stores: k_par arrives as
// curvature_delta = k_par - k_perp, and c arrives doubled, because those are
// the forms every runtime formula wants (see Node and trace() in the
// shaders). Both are exactly recoverable, so nothing is lost, and the
// isotropic case falls out as curvature_delta == 0, which is also what tells
// the shader the axis can be ignored. And linear and const are about the
// node's anchor (anchorOf()): with R = anchor + u, H is u.K.u + 2 c'.u
// + d' for c' = K anchor + c and d' = H(anchor), worked out here in f64.
//
// inside/outside are 0 or a real index (see flatten()'s doc comment for
// what 0 means on each side).
export function packNodes(list) {
  const views = Node.allocate(list.length);
  list.forEach((nd, j) => {
    const { axis, k_par, k_perp, linear } = nd.prim;
    const a = anchorOf(nd.prim);
    const along = axis[0] * a[0] + axis[1] * a[1] + axis[2] * a[2];
    const shifted = [0, 1, 2].map((i) => k_perp * a[i] + (k_par - k_perp) * along * axis[i] + linear[i]);
    Node.write(views, j, {
      axis,
      curvature_perp: k_perp,
      linear: shifted.map((v) => 2 * v),                       // 2c', about the anchor
      curvature_delta: k_par - k_perp,
      const_term: quadricAt(nd.prim, a),
      anchor: a,
      inside: nd.inside,
      outside: nd.outside,
      material: nd.material,
      env: nd.env,
    });
  });
  return views.buffer;
}

// ---------------------------------------------------------------------------
// Lights
//
// Each light is a world position and an RGB color whose magnitude is its
// radiant power. Falloff is inverse square, so these run well above 1.
// If the list passed is empty, it will still pack a single light with color
// (0.0, 0.0, 0.0) to appease wgsl's requirement of buffer sizes > 0.
// ---------------------------------------------------------------------------

// A light as the GPU stores it: Light in shaders/antisphere-raycast.wgsls,
// written through the Light class generated from it.
export function packLights(list) {
  const views = Light.allocate(list.length || 1);
  list.forEach((lt, j) => Light.write(views, j, { pos: lt.pos, color: lt.color }));
  return views.f32;
}
