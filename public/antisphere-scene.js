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

import {
  Light, Material, Node,
  KIND_LAMBERT, KIND_GLOSSY, KIND_EMISSIVE, KIND_UNLIT, KIND_AMBIENT, KIND_GLOW_REGION,
  PATTERN_CHECKER, PATTERN_NOISE, PATTERN_INDUSTRIALCARPET, MATERIAL_SOLID, MATERIAL_OPTICAL,
  MATERIAL_INDEX, NODE_ENV,
} from './gen/layouts.js';
import * as layouts from './gen/layouts.js';
import { regionsDisjoint, interiorPaths } from './overlap.js';
import { tangentSlide, tangentScale } from './tangent.js';
import { quadricAt } from './quadric.js';
import { readSTL } from './stl.js';
import { meshToTree, boundsOf, boundingSpheroidOfPoints } from './mesh-import.js';

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

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
// materialOf() for scenes not yet migrated; its old special value
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

// A division the compiler puts round a subtree - a group member's sphere, a
// "wrap" - is vacuum itself, a pure division in empty space, never a face;
// but it passes the material round it on to what it holds, so that what
// inherits there inherits as it would without it. Resolved in bakeScopes()
// to NO_MATERIAL for the node itself. (A material, not a flag of its own,
// so that every copy of a node - grafting, transforms - keeps it.)
const PASS_MATERIAL = -2;

// Recognized only via the deprecated "paint" field (see
// materialOf()), for scenes not yet migrated to naming a material
// directly. Reserved as material names even so, to avoid a materials.foo
// entry silently shadowing what used to be special syntax.
const LEGACY_PAINT_WORDS = ['partition', 'inherit', 'bare'];

// The shader's PATTERN_* (flat, 0, is the absence of one).
const PATTERNS = {
  flat             : 0,
  checker          : PATTERN_CHECKER,
  noise            : PATTERN_NOISE,
  industrialcarpet : PATTERN_INDUSTRIALCARPET,
};

// Each kind names a shading function in the shader. Adding one means a
// function and a switch arm there, and a KIND_ const, plus an entry here and
// its parameters.
const KINDS = {
  lambert:  { id: KIND_LAMBERT, params: () => [0, 0] },
  glossy:   { id: KIND_GLOSSY, params: (d) => [d.shininess ?? 32, d.specular ?? 0.6] },
  emissive: { id: KIND_EMISSIVE, params: (d) => [d.emission ?? 1, 0] },
  unlit:    { id: KIND_UNLIT, params: () => [0, 0] },
  // An ambient material never shades, and is not solid by default. A node
  // that names one starts an env (bakeScopes()): its albedo is the ambient
  // level for everything inside it, added to `transmit` (default 0) times
  // the level around it.
  ambient:  { id: KIND_AMBIENT, params: (d) => [d.transmit ?? 0, 0] },
  // A glow region: a region like an ambient one, not solid by default, and
  // a node that names one starts an env - but lit from within: its albedo
  // is the light at its node's centre, falling to nothing at the node's
  // surface, worked out by the shader from the node itself (addGlow() in
  // the raycast shader). Its ambient is `transmit` (default 1) times the
  // level around it, and `fill` (default 0) times its glow, unshadowed:
  // light from its walls, roughly.
  glowRegion: { id: KIND_GLOW_REGION, params: (d) => [d.transmit ?? 1, d.fill ?? 0] },
};
// The kinds that make a region rather than a substance: a node naming one
// starts an env (bakeScopes()).
const isRegionKind = (kind) => kind === KIND_AMBIENT || kind === KIND_GLOW_REGION;

/**
 * The env a point is in, in a compiled scene, as the shader finds a hit's
 * (envAt() in antisphere-raycast.wgsls): walking down from the root as P
 * lies - inside or outside each node by the sign of H(P) - the last node
 * on the way that starts an env and holds P inside; 0 for none. An env
 * node's own env is the one round it, so following env from there walks
 * outward.
 */
export function envAt(built, P) {
  let i = 1, env = 0;
  for (let depth = 0; i && depth < 4096; depth++) {
    const nd = built.nodes[i];
    if (quadricAt(nd.prim, P) < 0) {
      if (startsEnv(nd, built.materials)) env = i;
      i = nd.inside;
    } else {
      i = nd.outside;
    }
  }
  return env;
}

/**
 * Whether a compiled node starts an env: names an ambient or glow-region
 * material, or carries lights. Its pack sets NODE_ENV, which trace() keeps
 * as a ray goes into its inside.
 */
export const startsEnv = (nd, materials) => !!nd.lights?.length || isRegionKind(materials[nd.material]?.kind);

/**
 * The trace flags a material can set, by the key a scene sets it with:
 * every MATERIAL_ constant in shaders/node.wgsls that is a single bit,
 * named without MATERIAL_ and camelCased - SOLID is "solid", IOR_GLASS
 * "iorGlass". A mask (INDEX, IOR) is more than one bit, so never a key; a
 * new flag is a key as soon as the shaders are built.
 */
export const MATERIAL_FLAG_KEYS = Object.freeze(Object.fromEntries(
  Object.entries(layouts)
    .filter(([name, v]) => name.startsWith('MATERIAL_') && Number.isInteger(v) && v !== 0 && (v & (v - 1)) === 0)
    .map(([name, v]) => [name.slice('MATERIAL_'.length).toLowerCase().replace(/_(.)/g, (_, c) => c.toUpperCase()), v >>> 0])));

/** Whether a compiled material is there physically (MATERIAL_SOLID). */
export const isSolid = (m) => (m.flags & MATERIAL_SOLID) !== 0;

// The ambient level outside every env: ambient() in the raycast shader
// uses the same, and an outermost lit region with no level of its own
// keeps it (bakeScopes()).
const DEFAULT_AMBIENT = [0.13, 0.13, 0.14];

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
// lights: the lights it carries, if any (a scene file's node-level
// "lights"), which make it an env (see bakeScopes()) - [{ pos, color }].
function node(prim, inside, outside, material = NO_MATERIAL, env = 0, prov = null, lights = null) {
  return { prim, inside, outside, material, env, prov, lights };
}

/**
 * A light as scene.json gives it - { pos, color }, a point light, or
 * { direction, color }, a directional one, its light travelling along
 * direction - as the shader takes it: { pos, color, pos_w }, in
 * homogeneous form. A point light has pos_w 1, at pos; a directional one
 * pos_w 0, pos the unit vector towards it. `fail(message)` reports a
 * problem.
 */
export function compileLight(lt, fail = (msg) => { throw new Error(msg); }) {
  if (!lt || typeof lt !== 'object') fail('a light is { "pos" or "direction": [x, y, z], "color": [r, g, b] }');
  if (!isVec3(lt.color)) fail('needs a color, [r, g, b]');
  if ((lt.pos === undefined) === (lt.direction === undefined)) {
    fail('needs one of "pos" (a point light) or "direction" (a directional light, the way its light travels)');
  }
  if (lt.pos !== undefined) {
    if (!isVec3(lt.pos)) fail(`pos must be a point [x, y, z], got ${JSON.stringify(lt.pos)}`);
    return { pos: lt.pos.slice(), color: lt.color.slice(), pos_w: 1 };
  }
  const length = isVec3(lt.direction) ? Math.hypot(...lt.direction) : 0;
  if (!(length > 0)) fail(`direction must be a direction [x, y, z], got ${JSON.stringify(lt.direction)}`);
  return { pos: lt.direction.map((v) => -v / length), color: lt.color.slice(), pos_w: 0 };
}

/**
 * A node's lights, each moved by `move` (a point to a point); null stays
 * null. A directional light's direction turns as the node does, but doesn't
 * move or grow: move(pos) - move(0), made unit length again.
 */
const movedLights = (lights, move) => lights && lights.map((lt) => {
  if (lt.pos_w !== 0) return { ...lt, pos: move(lt.pos) };
  const origin = move([0, 0, 0]);
  const turned = move(lt.pos).map((v, i) => v - origin[i]);
  const length = Math.hypot(...turned);
  return { ...lt, pos: turned.map((v) => v / length) };
});

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
                   t.material, t.env, t.prov, t.lights);
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
                   t.material, t.env, t.prov, t.lights);
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
export function translatePrim(prim, t) {
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
export function rotatePrim(prim, rows) {
  const turn = (v) => rows.map((row) => dot3(row, v));
  return {
    axis: turn(prim.axis),
    k_par: prim.k_par,
    k_perp: prim.k_perp,
    linear: turn(prim.linear),
    constant: prim.constant,
  };
}

/**
 * A primitive moved rigidly: turned about the origin by `rotate` ({ axis,
 * radians }, or none), then moved by `translate` - as a subtree's "rotate"
 * and "translate" place it, and as figure.js gives a part's motion.
 */
export function movePrim(prim, { rotate = null, translate = [0, 0, 0] } = {}) {
  const turned = rotate ? rotatePrim(prim, rotationRows(rotate.axis, rotate.radians)) : prim;
  return translatePrim(turned, translate);
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
export function rotationRows(axis, radians) {
  const [x, y, z] = unitVector(axis);
  const c = Math.cos(radians), s = Math.sin(radians), t = 1 - c;
  return [
    [t * x * x + c,     t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c,     t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

/**
 * The rotation of Euler angles [x, y, z] (radians), as rows: about the
 * world's x axis by x, then y by y, then z by z - R = Rz Ry Rx, Blender's
 * "XYZ Euler" (and ROS's roll, pitch, yaw). With z up the last is the
 * heading: tipped first, then turned to face.
 */
export function eulerRows([x, y, z]) {
  const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
  return mul(rotationRows([0, 0, 1], z), mul(rotationRows([0, 1, 0], y), rotationRows([1, 0, 0], x)));
}

/**
 * A rotation's axis and angle (radians, 0 to pi), from its rows: the
 * editor shows a turn given as Euler angles that way. The identity gives
 * angle 0 and an axis of [0, 0, 1].
 */
export function axisAngleOf(R) {
  const angle = Math.acos(Math.max(-1, Math.min(1, (R[0][0] + R[1][1] + R[2][2] - 1) / 2)));
  if (angle < 1e-9) return { axis: [0, 0, 1], radians: 0 };
  if (Math.PI - angle < 1e-6) {
    // A half turn: R = 2 a a^T - I, so a's largest part is on the largest diagonal.
    const d = [R[0][0], R[1][1], R[2][2]], i = d.indexOf(Math.max(...d));
    const a = [0, 1, 2].map((j) => (j === i ? Math.sqrt((R[i][i] + 1) / 2) : (R[i][j] + R[j][i]) / 4 / Math.sqrt((R[i][i] + 1) / 2)));
    return { axis: a, radians: angle };
  }
  const s = 2 * Math.sin(angle);
  return { axis: [(R[2][1] - R[1][2]) / s, (R[0][2] - R[2][0]) / s, (R[1][0] - R[0][1]) / s], radians: angle };
}

// A transform's pivot, scale and rotation as a scene gives them, read with
// `at` for complaints: compileScene()'s, and resolveTangents()', which
// folds a scale into a node's own transforms.
function pivotSpec(def, path, at) {
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
function scaleSpecOf(def, path, at) {
  const spec = typeof def === 'number' ? { factor: def } : def;
  const factor = spec?.factor;
  if (!(factor > 0)) at(path, 'needs a positive factor, as a number or { factor, pivot }');
  return { factor, pivot: pivotSpec(spec, path, at) };
}

// "rotate": { axis, degrees | radians }, an angle about an axis; or
// { degrees | radians: [x, y, z] }, Euler angles (eulerRows()), with no
// axis; and an optional pivot to turn about something other than the
// origin.
function rotateSpecOf(def, path, at) {
  if (def && (Array.isArray(def.degrees) || Array.isArray(def.radians))) {
    if (def.axis !== undefined) at(path, 'Euler angles, [x, y, z], need no axis: give one or the other');
    if (def.degrees !== undefined && def.radians !== undefined) at(path, 'needs exactly one of degrees or radians');
    const unit = def.degrees !== undefined ? 'degrees' : 'radians';
    const angles = def[unit];
    if (angles.length !== 3 || !angles.every(Number.isFinite)) at(`${path}.${unit}`, `Euler angles are [x, y, z], three numbers, not ${JSON.stringify(angles)}`);
    return { rows: eulerRows(angles.map((v) => (unit === 'degrees' ? v * Math.PI / 180 : v))), pivot: pivotSpec(def, path, at) };
  }
  if (!def || !Array.isArray(def.axis)) at(path, 'needs an axis: { axis: [x, y, z], degrees }, or Euler angles: { degrees: [x, y, z] }');
  if (!(Math.hypot(...def.axis) > 1e-12)) at(`${path}.axis`, 'has no direction');
  const hasDegrees = typeof def.degrees === 'number';
  const hasRadians = typeof def.radians === 'number';
  if (hasDegrees === hasRadians) at(path, 'needs exactly one of degrees or radians');
  const radians = hasDegrees ? def.degrees * Math.PI / 180 : def.radians;
  return { rows: rotationRows(def.axis, radians), pivot: pivotSpec(def, path, at) };
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
                   t.material, t.env, t.prov,
                   movedLights(t.lights, (p) => p.map((v, i) => v + offset[i])));
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
           mine ? { ...t.prov, owner: to } : t.prov, t.lights);
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
  const turnPoint = (p) => rows.map((row) => dot3(row, p.map((v, i) => v - pivot[i]))).map((v, i) => v + pivot[i]);
  return mapTree(t, turn, turnPoint);
}

function scaleTree(t, factor, pivot) {
  if (!t) return t;
  const back = pivot.map((v) => -v);
  const grow = (prim) => translatePrim(scalePrim(translatePrim(prim, back), factor), pivot);
  return mapTree(t, grow, (p) => p.map((v, i) => pivot[i] + factor * (v - pivot[i])));
}

// A copy of a subtree with every primitive changed by f, and every light
// moved by g (the same transformation, of a point), shared structure kept
// shared.
function mapTree(t, f, g) {
  const memo = new Map();
  const walk = (u) => {
    if (!u) return u;
    if (memo.has(u)) return memo.get(u);
    const out = node(f(u.prim), walk(u.inside), walk(u.outside), u.material, u.env, u.prov,
                     movedLights(u.lights, g));
    memo.set(u, out);
    return out;
  };
  return walk(t);
}

// Resolves material inheritance once, here, instead of once per ray in
// antisphere-raycast.wgsls's trace(), so a hit's material is read directly
// off its node; and works out which nodes start envs, and how they nest.
//
// Material: descending into a node's *inside* adopts its own material as
// the scope for everything below it, unless it inherits (INHERIT_MATERIAL),
// in which case the incoming scope keeps threading through; *outside*
// always keeps the incoming scope, never the current node's own.
//
// Env: a node that itself names an ambient or glow-region material, or
// carries lights, starts an env - its inside is the env's region, its
// material the ambient level there, its lights the env's own - and records
// as its own `env` the env enclosing it, so following env from env node to
// env node walks outward. No other node records one: the env a hit is in
// is found by where it is (envAt(), in the shader and here), so a subtree
// starting no env is the same in every env. A lit node naming no material
// takes the enclosing env's ambient material (or a default one, appended
// to `table` when needed), so lighting a region leaves its ambient level as
// it was. Which nodes start one is a question about materials and lights,
// asked here because this is where materials are resolved; the tree's
// divisions are untouched. `table` is the compiled materials list.
//
// Memoized by subtree, by the material scope only if something in it
// inherits one, and by the env only if something in it starts one: a
// subtree that names its own materials and starts no env - most of them -
// is one baked copy wherever it is used. One with an env in it is baked
// per env it is in, since its env nodes record the env round them and its
// level.
function bakeScopes(tree, table) {
  const memo = new Map();       // "material:env id" -> (subtree -> baked)
  const envIds = new Map();     // env node -> a number for the memo key
  // An env's ambient level, as it is there: its own, plus its material's
  // transmit (params[0]) times the level around it - an ambient material's
  // own is its albedo, a glow region's nothing (its fill varies from point
  // to point, so the shader adds it). Each env node names a copy of its
  // material carrying that level (`ambient`), one per level it comes to.
  const levels = new Map();     // env node -> its level
  const copies = new Map();     // "material:level" -> the copy's index
  const withLevel = (material, level) => {
    const key = `${material}:${level.join()}`;
    if (!copies.has(key)) {
      table.push({ ...table[material], ambient: level });
      copies.set(key, table.length - 1);
    }
    return copies.get(key);
  };
  // A node with lights and no material of its own: a region with no level
  // of its own, letting all of the level around it in.
  let passing = 0;
  const passThrough = () => {
    if (!passing) {
      table.push({ ...table[0], albedo: [0, 0, 0], kind: KIND_AMBIENT, params: [1, 0], flags: 0 });
      passing = table.length - 1;
    }
    return passing;
  };
  // Whether a subtree holds a node that starts an env. One that doesn't is
  // the same whatever env it is in - a hit's env is found by where it is
  // (envAt() in the shader), not read from its node - so it is resolved
  // once per material scope, and shared by every env that has it: a world
  // reused under six ambient bubbles is one set of nodes, not six. Only
  // env nodes record the env round them (env), for the shader's walk
  // outward through enclosing envs, and their level.
  const startsEnvHere = (t) => t.lights?.length > 0
    || (t.material !== INHERIT_MATERIAL && t.material !== PASS_MATERIAL && isRegionKind(table[t.material]?.kind));
  const holdsEnv = new Map();
  const hasEnv = (t) => {
    if (!t) return false;
    if (!holdsEnv.has(t)) {
      holdsEnv.set(t, false);                    // a cycle can't hold one more
      holdsEnv.set(t, startsEnvHere(t) || hasEnv(t.inside) || hasEnv(t.outside));
    }
    return holdsEnv.get(t);
  };
  // Likewise whether it depends on the material round it: whether a node in
  // it inherits one - names none, and isn't a pass-through or lit - where
  // nothing above it within the subtree names one. One that names all its
  // own is the same in any material scope, and is shared too.
  const named = (t) => t.material !== INHERIT_MATERIAL && t.material !== PASS_MATERIAL;
  const inheritsOf = new Map();
  const inherits = (t) => {
    if (!t) return false;
    if (!inheritsOf.has(t)) {
      inheritsOf.set(t, false);
      const lit = t.lights?.length > 0;
      const own = !named(t) && t.material !== PASS_MATERIAL && !lit;
      inheritsOf.set(t, own || inherits(t.outside) || (!named(t) && !lit && inherits(t.inside)));
    }
    return inheritsOf.get(t);
  };
  const resolve = (t, matScope, envNode) => {
    if (!t) return t;
    if (!hasEnv(t)) envNode = null;
    const key = `${inherits(t) ? matScope : '-'}:${envNode ? envIds.get(envNode) : 0}`;
    let byScope = memo.get(key);
    if (!byScope) { byScope = new Map(); memo.set(key, byScope); }
    if (byScope.has(t)) return byScope.get(t);
    const passes = t.material === PASS_MATERIAL;
    const named = t.material !== INHERIT_MATERIAL && !passes;
    const lit = t.lights?.length > 0;
    let hereMat = named ? t.material : matScope;
    if (lit && !named) hereMat = passThrough();
    const startsEnv = lit || (named && isRegionKind(table[t.material].kind));
    let level = null;
    if (startsEnv) {
      const m = table[hereMat];
      const around = envNode ? levels.get(envNode) : DEFAULT_AMBIENT;
      const own = m.kind === KIND_AMBIENT ? m.albedo : [0, 0, 0];
      level = own.map((v, i) => v + m.params[0] * around[i]);
      hereMat = withLevel(hereMat, level);
    }
    const out = node(t.prim, null, null, passes ? NO_MATERIAL : hereMat, startsEnv ? envNode : null, t.prov, t.lights);
    byScope.set(t, out);
    if (startsEnv) {
      envIds.set(out, envIds.size + 1);
      levels.set(out, level);
    }
    out.inside = resolve(t.inside, hereMat, startsEnv ? out : envNode);
    out.outside = resolve(t.outside, matScope, envNode);
    return out;
  };
  return resolve(tree, NO_MATERIAL, null);
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
    // An env is an ancestor (bakeScopes()), so it already has its index.
    const env = t.env ? memo.get(t.env) : 0;
    if (env === undefined) throw new Error('flatten: a node\'s env was not above it');
    out[idx] = { prim: t.prim, material: t.material, env,
                 inside: walk(t.inside), outside: walk(t.outside), prov: t.prov, lights: t.lights };
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

// ---------------------------------------------------------------------------
// Extents, for "wrap"
//
// Points whose convex hull holds every region a subtree claims (each absent
// inside, whatever fills it - as group counts claims), for a wrapper to be
// fitted round: or null, where no bound can be proved. boundOf() above
// knows balls only, from spheres and spheroids; a cylinder cut by a slab -
// every pedestal and column - is beyond it. This reads more of the family:
//
// Every node is a quadric of revolution about an axis a. Measured along a
// (s) and from it (rho), H = k_perp rho^2 + k_par s^2 + 2 (c.a) s + d', so
// inside one with k_perp > 0 - sphere, spheroid, cylinder, cone,
// paraboloid, hyperboloids - rho^2 < f(s), f quadratic: bounded wherever s
// is. A slab, or an ellipsoid, bounds s along its axis; a plane, one side
// of it. So on each path down to a claimed region, the constraints bound
// it as a capped cylinder (an axis, an interval along it, a radius), or a
// parallelepiped (three independent directions bounded), and the smaller
// of the two is kept. A path neither bounds makes the whole subtree null.
// ---------------------------------------------------------------------------

const EXTENT_PATHS = 4096;
const parallel = (a, b) => Math.abs(Math.abs(dot3(a, b)) - 1) < 1e-9;

// What a node's inside says about where it is: [{ kind: 'axial', a, lo, hi }]
// (lo or hi may be infinite) and, for k_perp > 0, a 'radial' bound: rho^2 <
// f2 s^2 + f1 s + f0 about the axis line through `o`, s measured along a
// from o.
function insideConstraints(prim) {
  const { axis: a, k_par, k_perp, linear: c, constant: d } = prim;
  const ca = dot3(c, a);
  const cPerp = c.map((v, i) => v - ca * a[i]);
  const out = [];
  if (k_perp === 0 && k_par === 0) {                  // a half-space: n.R < bound
    const len = Math.hypot(...c);
    if (len > 0) out.push({ kind: 'axial', a: c.map((v) => v / len), lo: -Infinity, hi: -d / (2 * len) });
    return out;
  }
  if (k_perp === 0) {                                 // a slab, if c lies along a
    if (Math.hypot(...cPerp) > 1e-12 * (Math.abs(ca) + 1) || k_par < 0) return out;
    const disc = ca * ca - k_par * d;
    if (disc <= 0) return [{ kind: 'empty' }];
    const sq = Math.sqrt(disc);
    out.push({ kind: 'axial', a, lo: (-ca - sq) / k_par, hi: (-ca + sq) / k_par });
    return out;
  }
  if (k_perp < 0) return out;                         // inside runs off sideways
  // About the axis line through o = -cPerp / k_perp (s measured from o, so
  // c.a s needs o.a = 0, which it is).
  const o = cPerp.map((v) => -v / k_perp);
  const dPrime = d - dot3(cPerp, cPerp) / k_perp;
  const f2 = -k_par / k_perp, f1 = -2 * ca / k_perp, f0 = -dPrime / k_perp;
  out.push({ kind: 'radial', a, o, f2, f1, f0 });
  if (f2 < 0) {                                       // an ellipsoid: f > 0 only between its roots
    const disc = f1 * f1 - 4 * f2 * f0;
    if (disc <= 0) return [{ kind: 'empty' }];
    const sq = Math.sqrt(disc);
    const r1 = (-f1 + sq) / (2 * f2), r2 = (-f1 - sq) / (2 * f2);
    out.push({ kind: 'axial', a, lo: Math.min(r1, r2) + dot3(o, a), hi: Math.max(r1, r2) + dot3(o, a) });
  }
  return out;
}

const perpBasis = (a) => {
  const t = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = cross3(a, t), ul = Math.hypot(...u);
  const e1 = u.map((v) => v / ul);
  return [e1, cross3(a, e1)];
};

// Hull points for one path's constraints, [] if it is empty, or null if
// they bound nothing.
function pathPoints(constraints) {
  if (constraints.some((k) => k.kind === 'empty')) return [];
  // Intervals by direction, each in the frame of the first of its kind.
  const dirs = [];
  for (const k of constraints) {
    if (k.kind !== 'axial') continue;
    const at = dirs.find((d) => parallel(d.a, k.a));
    const flip = at && dot3(at.a, k.a) < 0;
    const lo = flip ? -k.hi : k.lo, hi = flip ? -k.lo : k.hi;
    if (at) { at.lo = Math.max(at.lo, lo); at.hi = Math.min(at.hi, hi); }
    else dirs.push({ a: k.a, lo, hi });
  }
  if (dirs.some((d) => d.lo >= d.hi)) return [];
  const finite = dirs.filter((d) => Number.isFinite(d.lo) && Number.isFinite(d.hi));
  const candidates = [];

  // Capped cylinders: each radial constraint's axis, bounded along it.
  for (const k of constraints) {
    if (k.kind !== 'radial') continue;
    const along = finite.find((d) => parallel(d.a, k.a));
    if (!along) continue;
    const sign = dot3(along.a, k.a) < 0 ? -1 : 1;
    const oa = dot3(k.o, k.a);
    // s about o along k.a, from the interval about the origin along along.a.
    const s0 = Math.min(sign * along.lo, sign * along.hi) - oa;
    const s1 = Math.max(sign * along.lo, sign * along.hi) - oa;
    let rho2 = Infinity;
    // Every radial constraint coaxial with this one bounds rho too.
    for (const q of constraints) {
      if (q.kind !== 'radial' || !parallel(q.a, k.a)) continue;
      const off = q.o.map((v, i) => v - k.o[i]);
      const offPerp = off.map((v, i) => v - dot3(off, k.a) * k.a[i]);
      if (Math.hypot(...offPerp) > 1e-9 * (1 + Math.hypot(...k.o))) continue;
      const qs = (s) => { const t = dot3(q.a, k.a) < 0 ? -s : s; const u = t + dot3(k.o, q.a) - dot3(q.o, q.a); return (q.f2 * u + q.f1) * u + q.f0; };
      let most = Math.max(qs(s0), qs(s1));
      if (q.f2 < 0) {                                 // a maximum inside the interval
        const v = -q.f1 / (2 * q.f2) - dot3(k.o, q.a) + dot3(q.o, q.a);
        const vs = dot3(q.a, k.a) < 0 ? -v : v;
        if (vs > s0 && vs < s1) most = Math.max(most, qs(vs));
      }
      rho2 = Math.min(rho2, most);
    }
    if (rho2 <= 0) return [];
    const rho = Math.sqrt(rho2) / Math.cos(Math.PI / 16);   // a 16-gon round the circle
    const [e1, e2] = perpBasis(k.a);
    const pts = [];
    for (const sv of [s0, s1]) {
      for (let j = 0; j < 16; j++) {
        const th = (2 * Math.PI * j) / 16, x = rho * Math.cos(th), y = rho * Math.sin(th);
        pts.push(k.o.map((v, i) => v + sv * k.a[i] + x * e1[i] + y * e2[i]));
      }
    }
    candidates.push(pts);
  }

  // Parallelepipeds: any three independent bounded directions.
  for (let i = 0; i < finite.length; i++) {
    for (let j = i + 1; j < finite.length; j++) {
      for (let k = j + 1; k < finite.length; k++) {
        const [A, B, C] = [finite[i], finite[j], finite[k]];
        const det = dot3(A.a, cross3(B.a, C.a));
        if (Math.abs(det) < 1e-6) continue;
        const pts = [];
        for (const x of [A.lo, A.hi]) for (const y of [B.lo, B.hi]) for (const z of [C.lo, C.hi]) {
          // R with A.a.R = x, B.a.R = y, C.a.R = z.
          const bc = cross3(B.a, C.a), ca = cross3(C.a, A.a), ab = cross3(A.a, B.a);
          pts.push([0, 1, 2].map((m) => (x * bc[m] + y * ca[m] + z * ab[m]) / det));
        }
        candidates.push(pts);
      }
    }
  }
  if (!candidates.length) return null;
  const boxVolume = (pts) => [0, 1, 2].reduce((v, m) => v * (Math.max(...pts.map((p) => p[m])) - Math.min(...pts.map((p) => p[m]))), 1);
  return candidates.reduce((best, pts) => (boxVolume(pts) < boxVolume(best) ? pts : best));
}

// The hull points for everything a subtree claims, or null (see above).
function extentPoints(t) {
  const points = [];
  let paths = 0, unbounded = false;
  const walk = (nd, constraints) => {
    if (unbounded) return;
    const inside = [...constraints, ...insideConstraints(nd.prim)];
    if (nd.inside) walk(nd.inside, inside);
    else {
      if (++paths > EXTENT_PATHS) { unbounded = true; return; }
      const pts = pathPoints(inside);
      if (pts === null) { unbounded = true; return; }
      points.push(...pts);
    }
    if (nd.outside) walk(nd.outside, [...constraints, ...insideConstraints(complementSurface(nd.prim))]);
  };
  if (t) walk(t, []);
  return unbounded ? null : points;
}

// Every axis in a subtree, for a wrapping slab to choose among.
function axesOf(t, out = [], seen = new Set()) {
  if (!t || seen.has(t)) return out;
  seen.add(t);
  if (!out.some((a) => parallel(a, t.prim.axis))) out.push(t.prim.axis);
  axesOf(t.inside, out, seen);
  axesOf(t.outside, out, seen);
  return out;
}

// Whether a ball ({ c, r }) is clear of a region, where that is exact and
// cheap: a half-space (a plane) or a sphere's inside or outside. Touching
// counts as clear, as it does for regionsDisjoint. Undefined for any
// other quadric, for the certificate to decide. (group's, and drop's.)
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

/**
 * Which sides of a primitive a spheroid ({ center, axis, height, radius },
 * as a scene's "spheroid" or boundingSpheroidOfPoints() gives one) may
 * reach: "inside", "outside", or "both" - by overlap.js's certificate,
 * measured in the spheroid's own frame, and "both" whenever neither side is
 * proved clear, which is always safe. Touching a side counts as clear of
 * it.
 */
export function spheroidSide(prim, reach) {
  const { center, height, radius } = reach;
  const region = spheroidPrim(reach);
  const frame = { c: center, L: Math.max(height / 2, radius) };
  if (regionsDisjoint(region, 1, prim, 1, frame)) return 'outside';
  if (regionsDisjoint(region, 1, prim, -1, frame)) return 'inside';
  return 'both';
}

/** A spheroid ({ center, axis, height, radius }) as a primitive. */
export const spheroidPrim = ({ center, axis, height, radius }) => spheroid(center, axis, height, radius);

// ---------------------------------------------------------------------------
// Drops: "drop": true
//
// An object dropped is moved along the scene's gravity until it first
// touches something solid: the furthest it can go and still be apart, by
// the certificates of overlap.js - exact where they prove two things
// apart, and touching counts as apart (DESIGN.md), so it comes to rest on
// what it lands on. They are conservative the other way: where only two
// constraints of a path together keep it clear (a box's corner by a ball)
// they may say "may overlap" early, so an object can stop a little short,
// never inside anything.
//
// It falls in steps that can't pass anything: a ball round each of the
// object's paths, swept over the step, proved apart from everything, or
// the step halved; down to 1/64 of the object's size, where the object
// itself is tested at the step's end, and once it may overlap, bisected
// back to where it is apart. (A feature thinner than that 1/64, met only
// within one smallest step, can be passed.)
// ---------------------------------------------------------------------------

// How far an object may fall, or rise out of what it starts in: placing
// is for a few units, and the worst case - falling beside a wall, where
// only the smallest steps prove anything - takes time with the distance
// (about 250 ms for 10 units on this machine).
const DROP_MAX = 10;
const DROP_STEPS = 20000;        // smallest steps before giving up

const ballOfPoints = (pts) => {
  const lo = [0, 1, 2].map((m) => Math.min(...pts.map((p) => p[m])));
  const hi = [0, 1, 2].map((m) => Math.max(...pts.map((p) => p[m])));
  const c = lo.map((v, m) => (v + hi[m]) / 2);
  return { c, r: Math.max(...pts.map((p) => dist3(p, c))) };
};

// A compiled scene's solid paths: [{ cons: [{ prim, sign }], ball, pts }],
// ball and pts null where a path is unbounded; null if there are too many.
// A bounded path's ball is offered to the certificates as one constraint
// more (apartAt(), sweptApart()): it holds the path, so whatever it is
// proved apart from the path is too, and it is what proves a box of slabs
// clear of a sky shell, which no one of its slabs - each unbounded - can.
function solidPaths(built) {
  const solid = (i) => isSolid(built.materials[built.nodes[i].material]);
  const paths = interiorPaths(built.nodes, 1, solid, EXTENT_PATHS);
  if (paths.length >= EXTENT_PATHS) return null;
  const out = [];
  for (const path of paths) {
    const cons = path.map(({ node: i, sign }) => ({ prim: built.nodes[i].prim, sign }));
    const pts = pathPoints(cons.flatMap(({ prim, sign }) => insideConstraints(sign > 0 ? prim : complementSurface(prim))));
    if (pts && !pts.length) continue;          // empty
    const ball = pts ? ballOfPoints(pts) : null;
    const knock = ball ? [{ prim: sphere(ball.c, ball.r * (1 + 1e-6)), sign: 1 }, ...cons] : cons;
    out.push({ cons, pts, ball, knock });
  }
  return out;
}

// Whether points' hull is clear of a region, where that is exact and cheap
// from the points alone: a half-space, either side of a plane, or a slab's
// inside, all of them beyond one face (both convex, so the hull is clear
// if its corners are). Undefined otherwise. Touching counts as clear.
function hullClear(prim, sign, pts) {
  const { axis: a, k_par: kp, k_perp: k, linear: c, constant: d } = prim;
  if (k === 0 && kp === 0) {
    return pts.every((p) => sign * (2 * dot3(c, p) + d) >= 0) || undefined;
  }
  if (k === 0 && kp > 0 && sign > 0) {
    const ca = dot3(c, a);
    if (Math.hypot(c[0] - ca * a[0], c[1] - ca * a[1], c[2] - ca * a[2]) > 1e-12 * (Math.abs(ca) + 1)) return undefined;
    const q = Math.sqrt(Math.max(0, ca * ca - kp * d));
    const lo = (-ca - q) / kp, hi = (-ca + q) / kp;
    const s = pts.map((p) => dot3(a, p));
    return s.every((x) => x >= hi) || s.every((x) => x <= lo) || undefined;
  }
  return undefined;
}

// Whether the object's paths, moved by v, are proved apart from the world's.
function apartAt(objPaths, worldPaths, v) {
  for (const o of objPaths) {
    const c = o.ball.c.map((x, i) => x + v[i]);
    const moved = o.cons.map(({ prim, sign }) => ({ prim: translatePrim(prim, v), sign }));
    const ball = { c, r: o.ball.r * (1 + 1e-6) }, ballPrim = sphere(ball.c, ball.r);
    // Measured about the object's own ball, as group does (see
    // regionsDisjoint): far from the origin, a ball inside a pipe otherwise
    // reads as touching it, and so as apart.
    const frame = { c, L: o.ball.r };
    for (const w of worldPaths) {
      if (w.ball && dist3(c, w.ball.c) >= o.ball.r + w.ball.r) continue;
      // The ball first - ballClear() answers most pairs exactly, and at once
      // - then the path's own constraints.
      const byBall = (b) => { const q = ballClear(b.prim, b.sign, ball); return q !== undefined ? q : regionsDisjoint(ballPrim, 1, b.prim, b.sign, frame); };
      // Then the path's hull corners against the world's planes and slabs.
      const pts = o.pts.map((p) => p.map((x, i) => x + v[i]));
      if (w.knock.some((b) => hullClear(b.prim, b.sign, pts))) continue;
      if (w.pts && moved.some((a) => hullClear(a.prim, a.sign, w.pts))) continue;
      if (w.knock.some(byBall)) continue;
      if (!moved.some((a) => w.knock.some((b) => regionsDisjoint(a.prim, a.sign, b.prim, b.sign, frame)))) return false;
    }
  }
  return true;
}

// Whether every object path's ball, swept along g from t to t + d, is
// proved apart from the world: then nothing is met in between.
function sweptApart(objPaths, worldPaths, g, t, d) {
  for (const o of objPaths) {
    const c = o.ball.c.map((x, i) => x + (t + d / 2) * g[i]);
    const r = o.ball.r + d / 2 + 1e-9;
    const ball = sphere(c, r), frame = { c, L: r };
    for (const w of worldPaths) {
      if (w.ball && dist3(c, w.ball.c) >= r + w.ball.r) continue;
      if (!w.knock.some((b) => { const q = ballClear(b.prim, b.sign, { c, r }); return q !== undefined ? q : regionsDisjoint(ball, 1, b.prim, b.sign, frame); })) return false;
    }
  }
  return true;
}

/**
 * How far to move a dropped object: { offset } or { warn }. `world` and
 * `object` are compiled scenes - the world without this drop or any after
 * it, the object alone where its own transforms put it - and `gravity` is
 * parseGravity()'s.
 */
function resolveDrop(world, object, gravity) {
  const objPaths = solidPaths(object), worldPaths = solidPaths(world);
  if (!objPaths || !worldPaths) return { warn: 'too many regions to drop' };
  if (!objPaths.length) return { warn: 'nothing solid to drop' };
  if (objPaths.some((o) => !o.ball)) return { warn: "unbounded, so it can't be dropped" };
  const whole = ballOfPoints(objPaths.flatMap((o) => o.pts));
  let g = gravity.kind === 'central' ? gravity.center.map((v, i) => v - whole.c[i]) : gravity.down;
  const glen = Math.hypot(...g);
  if (!(glen > 0)) return { warn: 'at the centre of gravity, so it has nowhere to fall' };
  g = g.map((v) => v / glen);
  const fine = (2 * whole.r) / 64;
  const at = (t) => apartAt(objPaths, worldPaths, g.map((v) => v * t));
  // Between a t that is apart and one that may overlap, the furthest apart.
  const bisect = (apart, over) => {
    for (let i = 0; i < 60 && Math.abs(over - apart) > 1e-7 * (1 + Math.abs(apart)); i++) {
      const mid = (apart + over) / 2;
      if (at(mid)) apart = mid; else over = mid;
    }
    return apart;
  };
  if (!at(0)) {
    // Starting inside: up, against gravity, until apart - if ever.
    let t = 0, steps = 0;
    while (!at(t - fine)) {
      t -= fine;
      if (-t > DROP_MAX || ++steps > DROP_STEPS) return { warn: `starts inside something it can't rise out of within ${DROP_MAX} units` };
    }
    return { offset: g.map((v) => v * bisect(t - fine, t)) };
  }
  let t = 0, steps = 0;
  for (;;) {
    let d = DROP_MAX - t;
    while (d > fine && !sweptApart(objPaths, worldPaths, g, t, d)) d /= 2;
    if (d > fine) {
      t += d;
      if (t >= DROP_MAX) return { warn: `nothing within ${DROP_MAX} units below it` };
      continue;
    }
    if (t + fine > DROP_MAX || ++steps > DROP_STEPS) return { warn: `nothing within ${DROP_MAX} units below it` };
    if (at(t + fine)) { t += fine; continue; }
    return { offset: g.map((v) => v * bisect(t, t + fine)) };
  }
}

// The places in a scene's root that ask to be placed by `key` ("drop",
// "tangentTo"), in document order: [{ keys }], keys the path to each from
// the spec ('root', then 'inside', 'group', 3, ...). `check(value, where)`
// says whether one is asked for (false: no), or refuses it. Not within
// another of the same, not in an objects definition (whose uses could each
// land elsewhere), and not within a subtree that is itself translated,
// rotated or scaled - the placing is worked out in world space, from the
// placed object alone.
function placementSites(spec, key, check, at) {
  const sites = [];
  const walk = (def, keys, within, moved) => {
    if (!def || typeof def !== 'object') return;
    if (Array.isArray(def)) { def.forEach((d, i) => walk(d, [...keys, i], within, moved)); return; }
    if (def[key] !== undefined) {
      const where = keys.join('.');
      if (check(def[key], `${where}.${key}`)) {
        if (within) at(`${where}.${key}`, `within another (${within}): place the outer one as a whole`);
        if (moved) at(`${where}.${key}`, `within a subtree that is itself moved (${moved}): not yet - move this one instead`);
        sites.push({ keys });
        within = where;
      }
    }
    const here = keys.join('.');
    const movedBelow = moved ?? (def.translate !== undefined || def.rotate !== undefined || def.scale !== undefined ? here : null);
    for (const k of ['inside', 'outside', 'group', 'union', 'intersection', 'intersect', 'difference']) {
      if (def[k] !== undefined) walk(def[k], [...keys, k], within, movedBelow);
    }
  };
  walk(spec.root, ['root'], null, null);
  for (const [name, def] of Object.entries(spec.objects ?? {})) {
    let found = false;
    const look = (d) => { if (d && typeof d === 'object') { if (!Array.isArray(d) && d[key]) found = true; Object.values(d).forEach(look); } };
    look(def);
    if (found) at(`objects.${name}`, `${key} where the object is placed (its use), not in its definition`);
  }
  return sites;
}

const dropSites = (spec, at) => placementSites(spec, 'drop', (v, where) => {
  if (v !== true && v !== false) at(where, `true, for now (parameters may come later), not ${JSON.stringify(v)}`);
  return v === true;
}, at);

const COMBINATION_KEYS = ['use', 'group', 'union', 'intersection', 'intersect', 'difference'];

const tangentSites = (spec, at) => placementSites(spec, 'tangentTo', (v, where) => {
  if (typeof v !== 'string' && !(v && typeof v === 'object' && !Array.isArray(v))) {
    at(where, `an object's name, or { "to", "along", "facing" }, not ${JSON.stringify(v)}`);
  }
  return true;
}, at);

/**
 * Fold a world-space scale by lambda about p - applied after the node's own
 * scale, rotate and translate - into those, in place. A uniform scale
 * commutes with a rotation, so with the node's scale s about q, rotation R
 * about r and translation T, its points D(x) = R(q + s (x - q) - r) + r + T
 * go to p + lambda (D(x) - p), which is the same rotation with scale
 * lambda s about q and translation
 *   T' = lambda T + (1 - lambda) (p - r - R (q - r)).
 * Its bounds, in world space, are scaled about p too.
 */
function foldScale(def, lambda, p, where, at) {
  const { factor: s, pivot: q } = def.scale !== undefined ? scaleSpecOf(def.scale, `${where}.scale`, at) : { factor: 1, pivot: [0, 0, 0] };
  const { rows: R, pivot: r } = def.rotate !== undefined ? rotateSpecOf(def.rotate, `${where}.rotate`, at)
    : { rows: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], pivot: [0, 0, 0] };
  const T = def.translate ?? [0, 0, 0];
  const qr = q.map((v, i) => v - r[i]);
  const Rqr = R.map((row) => dot3(row, qr));
  def.translate = T.map((v, i) => lambda * v + (1 - lambda) * (p[i] - r[i] - Rqr[i]));
  def.scale = typeof def.scale === 'object' && def.scale !== null ? { ...def.scale, factor: lambda * s } : lambda * s;
  if (def.bounds?.center) {
    def.bounds.center = def.bounds.center.map((v, i) => p[i] + lambda * (v - p[i]));
    if (def.bounds.radius !== undefined) def.bounds.radius *= lambda;
  }
}

/**
 * A scene with its tangentTo placements worked out (tangent.js): each node
 * asking for one slid along its axis - given, or its own, the target's, or
 * the line between them - until its surface sits flush against (or, facing
 * "touching", against) the target's, or as near as it can come; the slide
 * added to its translate. In document order. `compile` is compileScene,
 * quiet.
 */
function resolveTangents(spec, compile, at, warn) {
  const work = structuredClone(spec);
  for (const site of tangentSites(work, at)) {
    const where = `${site.keys.join('.')}.tangentTo`;
    const def = getAt(work, site.keys);
    const ask = typeof def.tangentTo === 'string' ? { to: def.tangentTo } : def.tangentTo;
    if (COMBINATION_KEYS.some((k) => def[k] !== undefined)) at(where, 'goes on a node with a shape of its own (a single primitive)');
    const facing = ask.facing ?? 'flush';
    if (facing !== 'flush' && facing !== 'touching') at(`${where}.facing`, `"flush" or "touching", not ${JSON.stringify(ask.facing)}`);
    const by = ask.by ?? 'slide';
    if (by !== 'slide' && by !== 'scale') at(`${where}.by`, `"slide" or "scale", not ${JSON.stringify(ask.by)}`);
    if (by === 'scale' && ask.along !== undefined) at(`${where}.along`, 'is for sliding: scaling takes a pivot');
    if (by === 'slide' && ask.pivot !== undefined) at(`${where}.pivot`, 'is for scaling: sliding takes an axis, along');
    let targetDef;
    if (typeof ask.to === 'string') {
      targetDef = work.objects?.[ask.to];
      if (!targetDef) at(`${where}.to`, `no object "${ask.to}"`);
      targetDef = { use: ask.to };
      if (COMBINATION_KEYS.some((k) => work.objects[ask.to][k] !== undefined)) at(`${where}.to`, `"${ask.to}" isn't a single primitive`);
    } else if (ask.to && typeof ask.to === 'object' && !Array.isArray(ask.to)) {
      if (COMBINATION_KEYS.some((k) => ask.to[k] !== undefined)) at(`${where}.to`, 'is to be a single primitive');
      targetDef = ask.to;
    } else {
      at(`${where}.to`, 'names an object, or gives a primitive');
    }
    // Each alone, where its own transforms put it: node 1's surface.
    const moving = structuredClone(def);
    for (const k of ['tangentTo', 'drop', 'wrap', 'bounds']) delete moving[k];
    const B = compile({ ...work, root: moving }).nodes[1].prim;
    const A = compile({ ...work, root: targetDef }).nodes[1].prim;
    const aA = anchorOf(A), aB = anchorOf(B);
    if (by === 'scale') {
      // About a pivot: given, or the moved shape's centre (its anchor) - a
      // flare grows or shrinks round its own waist.
      const p = ask.pivot ?? aB;
      if (!(Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) at(`${where}.pivot`, `a point [x, y, z], not ${JSON.stringify(ask.pivot)}`);
      const result = tangentScale(A, B, p, { facing, anchors: [aA, aB] });
      delete def.tangentTo;
      if (result.warn) { warn(where, result.warn); continue; }
      if (!result.exact) warn(where, `best effort: the normals are left ${(result.angle * 180 / Math.PI).toFixed(2)} degrees apart`);
      foldScale(def, result.factor, p, where, at);
      continue;
    }
    // Along: given; the moved shape's own axis, if it has one (anything but
    // a sphere: a plane's is its normal); the target's; or between them.
    const isotropic = (q) => q.k_par === q.k_perp && q.k_par !== 0;
    let along = ask.along;
    if (along !== undefined && !(Array.isArray(along) && along.length === 3 && along.every(Number.isFinite) && Math.hypot(...along) > 0)) {
      at(`${where}.along`, `a direction [x, y, z], not ${JSON.stringify(along)}`);
    }
    along ??= !isotropic(B) ? B.axis : !isotropic(A) ? A.axis : aA.map((v, i) => v - aB[i]);
    const l = Math.hypot(...along);
    if (!(l > 0)) { warn(where, 'no direction to slide in (two spheres with one centre)'); delete def.tangentTo; continue; }
    const u = along.map((v) => v / l);
    const result = tangentSlide(A, B, u, { facing, anchors: [aA, aB] });
    delete def.tangentTo;
    if (result.warn) { warn(where, result.warn); continue; }
    if (!result.exact) warn(where, `best effort: the normals are left ${(result.angle * 180 / Math.PI).toFixed(2)} degrees apart`);
    def.translate = (def.translate ?? [0, 0, 0]).map((v, i) => v + u[i] * result.t);
    if (def.bounds?.center) def.bounds.center = def.bounds.center.map((v, i) => v + u[i] * result.t);
  }
  return work;
}

const getAt = (obj, keys) => keys.reduce((o, k) => o?.[k], obj);

/**
 * A scene with its drops worked out: each "drop": true replaced by the
 * offset it falls by, added to its translate (and to its bounds' centre,
 * which is in world space). In document order, each onto the scene with
 * the drops before it settled and those after left out. `compile` is
 * compileScene, quiet.
 */
function resolveDrops(spec, compile, at, warn) {
  const work = structuredClone(spec);
  const sites = dropSites(work, at);
  const gravity = parseGravity(work.gravity, at);
  for (let k = 0; k < sites.length; k++) {
    const site = sites[k];
    const where = site.keys.join('.');
    const def = getAt(work, site.keys);
    let result;
    if (site.keys.length === 1) {
      result = { warn: 'nothing below it (it is the whole scene)' };
    } else {
      // The world: this drop and every later one taken out, last first so
      // the earlier ones' keys stay good.
      const worldSpec = structuredClone(work);
      for (let j = sites.length - 1; j >= k; j--) {
        const keys = sites[j].keys, parent = getAt(worldSpec, keys.slice(0, -1)), last = keys[keys.length - 1];
        if (Array.isArray(parent)) parent.splice(last, 1); else parent[last] = null;
      }
      const objectDef = structuredClone(def);
      delete objectDef.drop;
      result = resolveDrop(compile(worldSpec), compile({ ...work, root: objectDef }), gravity);
    }
    delete def.drop;
    if (result.warn) { warn(`${where}.drop`, result.warn); continue; }
    def.translate = (def.translate ?? [0, 0, 0]).map((v, i) => v + result.offset[i]);
    if (def.bounds?.center) def.bounds.center = def.bounds.center.map((v, i) => v + result.offset[i]);
  }
  return work;
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
      const solid = t.material === INHERIT_MATERIAL ? true : isSolid(table[t.material]);
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
// References
//
// Wherever a scene expects an object, it may instead name a file - a path
// or a URL, after an @ - and that file's content is the object:
//
//   "materials": ["@lib/materials.json", { "teal": { ... } }],
//   "objects": { "bolt": "@parts/bolt.json#/objects/bolt" },
//   "inside": "@parts/torus.stl",
//   "material": "@lib/metals.json#/brass"
//
// A string starting @ is a reference; anything else is a name, as ever.
// After the @, a path (relative to the file that names it) or a URL, and
// maybe a fragment: a JSON pointer into the file (RFC 6901); none is the
// whole file, and a fragment alone, "@#/objects/head", is the same file.
// A file ending .stl is a mesh, read as its tree; either kind, ending .gz,
// is unzipped as it loads.
//
// Where (see expandReferences()):
//   materials, objects   a map, a reference to one, or an array of those,
//                        merged in order, later entries winning
//   each material, each object, camera, gravity, spawn: or a reference
//   lights (scene's, or a node's): an array or a reference to one; an item
//                        a light, a reference to one, or a reference to an
//                        array, spliced in
//   a subtree - root, inside, outside, a member of group, union,
//                        intersect or difference, a use - or a reference;
//                        an .stl reference is the mesh's tree
//   material on a node   a name, or a reference to a material
//
// What a reference brings is the scene's from then on: the names in it
// mean the scene's. A file that means its own says so with a reference,
// "@#/objects/head". In a map of materials or objects, a key starting _
// ("_comment") is a note, not an entry: it is dropped, and never brought
// over from another file. A subtree reference becomes an object of its own,
// named for where it came from, and the place it was a use of that, so
// every use of one reference shares one set of nodes; a material
// reference likewise a material. Everything else is copied in.
//
// Loading is the caller's business, not the compiler's: compileScene() is
// synchronous and reads no files, so the files are handed to it in
// `options.files`, which loadReferences() fetches - everything a scene
// references, and everything those reference in turn.
// ---------------------------------------------------------------------------

/** Whether a path is a URL of its own (https://, file://, ...), not relative. */
const isURL = (path) => /^[a-z][a-z0-9+.-]*:\/\//i.test(path);

/**
 * The file a path or URL names, without directories, query or fragment -
 * or a .gz, which only says how it is stored: "dragon.json.gz" is
 * "dragon.json".
 */
const fileOf = (path) => String(path).split(/[?#]/)[0].split(/[\\/]/).pop().replace(/\.gz$/i, '');

/** Whether a path or URL names a gzipped file, unzipped as it loads. */
export const isGzip = (path) => /\.gz$/i.test(String(path).split(/[?#]/)[0]);

/** Whether a path or URL names an STL file, which is read as a mesh. */
export const isSTL = (path) => /\.stl$/i.test(fileOf(path));

/** Gzipped bytes, unzipped (DecompressionStream: browsers, and Node 18+). */
export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Whether a string, where an object may go, is a reference rather than a name: it starts @. */
export function isReference(value) {
  return typeof value === 'string' && value.startsWith('@');
}

/**
 * Where a path named inside `from` actually points. A URL is where it says;
 * a path inside a file that came from a URL is resolved against that URL,
 * so a scene on another server references what sits beside it there.
 */
function resolvePath(from, path) {
  if (isURL(path)) return path;
  if (isURL(from)) return new URL(path, from).href;
  if (!from || path.startsWith('/')) return path;
  const directory = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  if (!directory) return path;
  const parts = (directory + path).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    // A ".." with nothing of ours left to climb out of stays: a page one
    // directory down reads "../scenes/planet.json", whose library is
    // "../scenes/lib/materials.json", not "scenes/lib/...".
    if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(part);
  }
  return (from.startsWith('/') ? '/' : '') + out.join('/');
}

/** What a JSON pointer (RFC 6901, as a URL fragment: percent-encoded) picks out of `doc`. */
function pointerInto(doc, pointer, reference) {
  if (pointer === '') return doc;
  if (!pointer.startsWith('/')) {
    throw new Error(`reference "${reference}": a fragment is a JSON pointer, starting "#/"`);
  }
  let here = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (here === null || typeof here !== 'object' || !Object.prototype.hasOwnProperty.call(here, key)) {
      throw new Error(`reference "${reference}": the file has nothing at ${pointer}`);
    }
    here = here[key];
  }
  return here;
}

/** Every array of subtrees a node can carry. */
// ("intersect" is the old name for "intersection", still read.)
const SUBTREE_ARRAYS = ['group', 'union', 'intersection', 'intersect', 'difference'];

/**
 * A spec with its references replaced by what they name, from `files`
 * (path or URL -> content: parsed JSON, or an STL's tree) - see the
 * comment above. Returns { spec, missing }: `missing`, the files it needed
 * and wasn't given; while there are any, `spec` is incomplete. `from` is
 * the spec's own path, which its relative references are relative to.
 * What has no references is returned as it is, not copied.
 */
export function expandReferences(spec, files = {}, { from = '' } = {}) {
  const missing = new Set();
  const own = { ...files, [from]: spec };          // "#/..." in the scene is the scene
  const objects = new Map();                       // a subtree reference's key -> its subtree
  const materials = new Map();                     // a material reference's key -> the material
  const PENDING = Symbol('pending');

  // What a reference names: { key, path, value }, or null while its file
  // is missing. `trail` holds the references being copied in, outermost
  // first, to catch a file copying itself in.
  const lookUp = (reference, from, trail) => {
    const target = reference.slice(1);
    const hash = target.indexOf('#');
    const file = hash < 0 ? target : target.slice(0, hash);
    const pointer = hash < 0 ? '' : target.slice(hash + 1);
    const path = file ? resolvePath(from, file) : from;
    const key = pointer ? `${path}#${pointer}` : path;
    if (trail.includes(key)) {
      throw new Error(`reference "${reference}" includes itself, by way of ${[...trail, key].join(' -> ')}`);
    }
    if (!(path in own)) { missing.add(path); return null; }
    if (pointer && isSTL(path)) throw new Error(`reference "${reference}": an STL has no parts to point into`);
    return { key, path, value: pointerInto(own[path], pointer, reference) };
  };

  // Each function below takes a value from a file at `from`, and returns
  // it expanded: the same value if nothing in it is a reference.
  const changed = (out, def) => Object.keys(out).some((k) => out[k] !== def[k]);

  // A reference copied in: followed - through a file that is itself a
  // reference, too - to what it names, which `expand` then expands.
  const inline = (value, from, trail, expand) => {
    if (!isReference(value)) return expand(value, from, trail);
    const found = lookUp(value, from, trail);
    return found ? inline(found.value, found.path, [...trail, found.key], expand) : undefined;
  };

  const material = (def, from, trail) => inline(def, from, trail, (v) => v);

  const subtreeReference = (reference, from, trail) => {
    const found = lookUp(reference, from, []);
    if (!found) return reference;
    if (!objects.has(found.key)) {
      objects.set(found.key, PENDING);             // a cycle meets it as a use, and the compiler says so
      objects.set(found.key, subtree(found.value, found.path, trail));
    }
    return found.key;
  };

  const subtree = (def, from, trail) => {
    if (isReference(def)) return { use: subtreeReference(def, from, trail) };
    if (def === null || typeof def !== 'object' || Array.isArray(def)) return def;
    const out = { ...def };
    if (isReference(def.use)) out.use = subtreeReference(def.use, from, trail);
    if (isReference(def.material)) {
      const found = lookUp(def.material, from, []);
      if (found) {
        if (!materials.has(found.key)) materials.set(found.key, found.value);
        out.material = found.key;
      }
    }
    for (const side of ['inside', 'outside']) {
      if (def[side] !== undefined) out[side] = subtree(def[side], from, trail);
    }
    for (const op of SUBTREE_ARRAYS) {
      if (Array.isArray(def[op])) {
        const members = def[op].map((m) => (isReference(m) ? subtreeReference(m, from, trail) : subtree(m, from, trail)));
        if (members.some((m, i) => m !== def[op][i])) out[op] = members;
      }
    }
    if (def.lights !== undefined) out.lights = lights(def.lights, from, trail);
    return changed(out, def) ? out : def;
  };

  // A list of lights; an item that names a list is spliced in, its own
  // items expanded where it came from.
  const lights = (list, from, trail) => inline(list, from, trail, (value, from, trail) => {
    if (!Array.isArray(value)) return value;      // the compiler says what is wrong with it
    const out = [];
    let differs = false;
    for (const item of value) {
      const got = inline(item, from, trail, (v, from, trail) => (Array.isArray(v) ? lights(v, from, trail) : v));
      if (got !== item) differs = true;
      if (Array.isArray(got)) out.push(...got); else out.push(got);
    }
    return differs ? out : value;
  });

  // A map of materials or objects: or a reference to one, or an array of
  // those, merged in order.
  const merged = (value, from, trail, each) => inline(value, from, trail, (value, from, trail) => {
    if (Array.isArray(value)) {
      return Object.assign({}, ...value.map((part) => merged(part, from, trail, each) ?? {}));
    }
    if (value === null || typeof value !== 'object') return value;
    const out = {};
    // A key starting _ is a note ("_comment"), not an entry: dropped.
    for (const [name, entry] of Object.entries(value)) if (!name.startsWith('_')) out[name] = each(entry, from, trail);
    return changed(out, value) || Object.keys(out).length !== Object.keys(value).length ? out : value;
  });

  const out = { ...spec };
  if (spec.materials !== undefined) out.materials = merged(spec.materials, from, [], material);
  if (spec.objects !== undefined) out.objects = merged(spec.objects, from, [], subtree);
  if (spec.lights !== undefined) out.lights = lights(spec.lights, from, []);
  for (const key of ['camera', 'gravity', 'spawn']) {
    if (spec[key] !== undefined) out[key] = inline(spec[key], from, [], (v) => v);
  }
  if (spec.root !== undefined) out.root = subtree(spec.root, from, []);
  if (objects.size) out.objects = { ...(out.objects ?? {}), ...Object.fromEntries(objects) };
  if (materials.size) out.materials = { ...(out.materials ?? {}), ...Object.fromEntries(materials) };
  return { spec: changed(out, spec) || Object.keys(out).length !== Object.keys(spec).length ? out : spec, missing };
}

/**
 * Fetch every file a spec references, and every file those reference, as
 * the `files` that compileScene() and expandReferences() want.
 *
 * `readText` and `readBytes` take a resolved path or URL and return its
 * text, or its bytes (an ArrayBuffer or Uint8Array), however the caller
 * likes: fetch in a browser, readFile in node. A .json is read as text and
 * parsed; an .stl as bytes and converted (meshToTree()); either, ending
 * .gz, as bytes and unzipped first.
 *
 * A file that can't be read, or parsed, is warned of (`warn(message)`) and
 * left out of `files`; compileScene() then warns again and goes on
 * without what referred to it.
 */
export async function loadReferences(spec, { from = '', readText, readBytes, warn = console.warn } = {}) {
  const files = {};
  const failed = new Set();          // warned of, and left out: compileScene() goes on without them
  const load = async (path) => {
    try {
      if (isSTL(path) || isGzip(path)) {
        if (!readBytes) throw new Error('an STL or a .gz needs loadReferences() given readBytes');
        let bytes = new Uint8Array(await readBytes(path));
        if (isGzip(path)) bytes = await gunzip(bytes);
        if (!isSTL(path)) return JSON.parse(new TextDecoder().decode(bytes));
        const read = readSTL(bytes);
        if (read.openEdges) {
          warn(`${path}: ${read.openEdges} open edges: the surface does not close, so what is inside it is a guess`);
        }
        const tree = meshToTree(read.triangles);
        if (!tree) throw new Error('the mesh has no triangles with any area');
        return tree;
      }
      return JSON.parse(await readText(path));
    } catch (cause) {
      throw new Error(`cannot load "${path}": ${cause.message}`);
    }
  };
  for (;;) {
    const { missing } = expandReferences(spec, files, { from });
    const wanted = [...missing].filter((path) => !failed.has(path));
    if (!wanted.length) return files;
    await Promise.all(wanted.map(async (path) => {
      try {
        files[path] = await load(path);
      } catch (error) {
        warn(`${error.message}: left out`);
        failed.add(path);
      }
    }));
  }
}

/**
 * A complete scene to look at a mesh in: `model` (a subtree, a reference,
 * or a use of one) as the object `name`, inside a ball round `bounds`
 * ({ lo, hi }, where the model is in the scene) that makes it of
 * `material` - a mesh names none of its own. Standing on z = 0, about
 * `size` across: a checked floor, a sky, three lights and a camera framing
 * it. With floor false, just the model in a ball of vacuum, lit. What
 * tools/stl-to-scene.mjs writes, and what the page shows for an STL on its
 * own (sceneForMesh()).
 */
export function sceneAroundMesh(model, { name = 'model', material = 'clay', floor = true, size, bounds }) {
  const placed = {
    sphere: {
      center: bounds.lo.map((v, i) => (v + bounds.hi[i]) / 2),
      radius: 1.01 * Math.hypot(...bounds.lo.map((v, i) => bounds.hi[i] - v)) / 2,
    },
    material,
    inside: { use: name },
  };
  const scene = {
    materials: {
      [material]: { albedo: [0.72, 0.58, 0.32], kind: 'glossy', shininess: 40, specular: 0.4 },
    },
    lights: [],
    objects: { [name]: model },
    root: null,
  };
  if (!floor) {
    scene.lights = [{ pos: [size * 2, -size * 2, size * 3], color: [size * size * 40, size * size * 38, size * size * 34] }];
    scene.root = { sphere: { center: [0, 0, 0], radius: size * 100 }, inside: placed };
    return scene;
  }

  const lamp = size * size * 20;
  Object.assign(scene.materials, {
    floor: { albedo: [0.32, 0.33, 0.35], albedo2: [0.19, 0.20, 0.22],
             pattern: 'checker', scale: size / 4 },
    sky: { kind: 'unlit', albedo: [0.07, 0.09, 0.14] },
  });
  scene.lights = [
    { pos: [size * 1.5, -size * 2, size * 2.5], color: [lamp, lamp * 0.96, lamp * 0.88] },
    { pos: [-size * 2, -size, size * 1.5], color: [lamp * 0.35, lamp * 0.38, lamp * 0.46] },
    { pos: [0, size * 2.5, size], color: [lamp * 0.3, lamp * 0.28, lamp * 0.26] },
  ];
  const target = [0, 0, size * 0.4];
  const eye = [size * 2.2, -size * 1.9, size * 1.4];
  const look = eye.map((v, i) => target[i] - v);
  const distance = Math.hypot(...look);
  scene.camera = { position: eye, direction: look.map((v) => v / distance), distance };
  scene.root = {
    sphere: { center: [0, 0, 0], radius: size * 200 },
    inside: {
      plane: { normal: [0, 0, 1], offset: 0 },
      material: 'floor',
      outside: {
        union: [
          placed,
          { sphere: { center: [0, 0, 0], radius: size * 199 }, complement: true, material: 'sky' },
        ],
      },
    },
  };
  return scene;
}

/**
 * A scene showing the STL at `path` on its own, from its bytes: as
 * sceneAroundMesh() makes, referencing the STL and standing it, centred,
 * on the floor, scaled to 2 across - STL has no units, and a model in
 * millimetres would otherwise put the sky past where rays look. Returns
 * { spec, files } for compileScene(), with no path of its own.
 */
export function sceneForMesh(path, bytes, { warn = console.warn } = {}) {
  const read = readSTL(bytes);
  if (read.openEdges) {
    warn(`${path}: ${read.openEdges} open edges: the surface does not close, so what is inside it is a guess`);
  }
  const tree = meshToTree(read.triangles);
  if (!tree) throw new Error(`${path}: the mesh has no triangles with any area`);
  const { lo, hi } = boundsOf(read.triangles);
  const size = 2;
  const scale = size / Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  // Centred in x and y, standing on z = 0: where the floor expects it.
  const translate = [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]].map((v) => v * scale);
  const placed = (v) => v.map((x, i) => x * scale + translate[i]);
  const spec = sceneAroundMesh({ use: `@${path}`, scale, translate },
                               { name: fileOf(path).replace(/\.[^.]*$/, ''), size, bounds: { lo: placed(lo), hi: placed(hi) } });
  return { spec, files: { [path]: tree } };
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

  // References are replaced by what they name before anything else looks
  // at the spec, so everything below sees one ordinary scene - some of
  // whose objects and materials are named for the files they came from.
  if (rawSpec?.import !== undefined) {
    at('import', 'references replace "import": name the file where the object goes - ' +
                 '"use": "@parts/bolt.json#/objects/bolt", "materials": ["@lib/materials.json", { ... }] ' +
                 '(see scene-format.md, References)');
  }
  // A slip in a scene - a material or object it doesn't define, a file it
  // references that isn't there - is warned of, and the scene plays on
  // without it, rather than not loading at all. options.warn(path, msg)
  // hears the warnings instead of the console (a tool's check, failing on
  // them); options.quiet silences them.
  const quietly = options.warn ?? ((path, msg) => { if (!options.quiet) console.warn(`warning: ${path}: ${msg}`); });
  const { spec, missing } = expandReferences(rawSpec, options.files ?? {}, { from: options.path ?? '' });
  if (missing.size) {
    quietly([...missing].join(', '), 'not loaded, so what refers to it is left out (see loadReferences())');
  }
  // Drops are worked out first, on a copy (resolveDrops()), and the scene
  // they give compiled as any other: it has none left, and no references.
  if (tangentSites(spec, at).length || dropSites(spec, at).length) {
    // tangentTo first, then drops: what is placed flush can then fall.
    const compile = (s) => compileScene(s, { quiet: true });
    const resolved = resolveDrops(resolveTangents(spec, compile, at, quietly), compile, at, quietly);
    return compileScene(resolved, { ...options, files: {}, path: options.path });
  }
  const warn = quietly;

  // Material 0 is vacuum: never shaded, and no trace flags - nothing there.
  // A material's flags (MATERIAL_FLAG_KEYS) go into the material id of
  // every node it fills (packNodes()), which is what trace() reads: an
  // author-set "solid": false, or "optical": false, is exactly what keeps
  // a ray of that sort from stopping in the region.
  const table = [{ albedo: [0, 0, 0], albedo2: [0, 0, 0],
                   pattern: 0, scale: 1, kind: 0, params: [0, 0], flags: 0 }];
  const matIndex = new Map();
  for (const [name, def] of Object.entries(spec.materials || {})) {
    // A reference to a material in a file that wasn't loaded comes to
    // nothing (warned of above): left out, so what uses it gets a stand-in.
    if (def === undefined) continue;
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
    const opacity = def.opacity ?? 1;
    if (!(typeof opacity === 'number' && opacity >= 0 && Number.isFinite(opacity))) {
      at(`materials.${name}.opacity`, `must be a number, 0 or more, got ${JSON.stringify(def.opacity)}`);
    }
    for (const field of ['transmit', 'fill']) {
      if (def[field] !== undefined && !(typeof def[field] === 'number' && Number.isFinite(def[field]))) {
        at(`materials.${name}.${field}`, `must be a number, got ${JSON.stringify(def[field])}`);
      }
    }
    // Solid and seen, unless an ambient (a region's surroundings, not a
    // substance) or the keys say otherwise; each key sets or clears its own
    // bit, and no combination is refused.
    let flags = isRegionKind(kind.id) ? 0 : MATERIAL_SOLID | MATERIAL_OPTICAL;
    for (const [key, bit] of Object.entries(MATERIAL_FLAG_KEYS)) {
      if (def[key] === undefined) continue;
      if (typeof def[key] !== 'boolean') at(`materials.${name}.${key}`, `must be true or false, got ${JSON.stringify(def[key])}`);
      flags = def[key] ? flags | bit : flags & ~bit;
    }
    table.push({
      name,                                      // for display (what a ray hit); not packed
      albedo:  def.albedo  ?? [0.7, 0.7, 0.7],
      albedo2: def.albedo2 ?? [0.3, 0.3, 0.3],
      scale,
      opacity,
      kind:    kind.id,
      params:  kind.params(def),
      pattern,
      flags:   flags >>> 0,
    });
    matIndex.set(name, table.length - 1);
  }

  // A list of lights, the scene's or a node's (see compileLight()).
  const lightsOf = (list, path) => {
    if (!Array.isArray(list)) at(path, 'needs a list of lights, [{ "pos": [x, y, z], "color": [r, g, b] }]');
    return list.map((lt, i) => compileLight(lt, (msg) => at(`${path}[${i}]`, msg)));
  };
  // The scene's own lights: env 0's, which light everything.
  const topLights = lightsOf(spec.lights ?? [], 'lights').map((lt) => ({ ...lt, env: 0 }));

  // A material the scene doesn't define gets a stand-in, unmissable -
  // flat magenta, solid and seen - which keeps the name it was asked for,
  // so the viewer's centre probe says what is missing. Warned of once.
  function substrate(name, path) {
    let m = matIndex.get(name);
    if (m === undefined) {
      quietly(path, `unknown material "${name}": shown as a stand-in, flat magenta`);
      table.push({ name, missing: true, albedo: [1, 0, 1], albedo2: [1, 0, 1], scale: 1, opacity: 1,
                   kind: KIND_UNLIT, params: [0, 0], pattern: 0, flags: (MATERIAL_SOLID | MATERIAL_OPTICAL) >>> 0 });
      m = table.length - 1;
      matIndex.set(name, m);
    }
    return m;
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
  function materialOf(def, path) {
    if (def.material === null) return NO_MATERIAL;
    if (def.material !== undefined) return substrate(def.material, `${path}.material`);
    if (def.paint === undefined) return INHERIT_MATERIAL;
    console.warn(`scene.json ${path}.paint: "paint" is deprecated - use "material" instead.`);
    if (def.paint === 'inherit') return INHERIT_MATERIAL;
    if (def.paint === 'partition' || def.paint === 'bare') return NO_MATERIAL;
    return substrate(def.paint, `${path}.paint`);
  }

  const pivotOf = (def, path) => pivotSpec(def, path, at);

  // "scale": 2, or { "factor": 2, "pivot": [x, y, z] }. Uniform only: a
  // subtree's primitives can point any way they like, and scaling one axis
  // differently would leave most of them outside the family of revolution
  // quadrics a node can hold.
  const scaleSpec = (def, path) => scaleSpecOf(def, path, at);
  const rotateSpec = (def, path) => rotateSpecOf(def, path, at);

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
    if (!def) {
      // Nothing there: as an outside, empty; as an inside, the node's own.
      quietly(path, `unknown object "${name}": left out`);
      built.set(name, null);
      return null;
    }
    built.set(name, BUILDING);                   // cycle guard
    let t = tree(def, `objects.${name}`, { owner: name, segments: [] });

    // An instance gets nodes of its own, attributed to it, so a hit can say
    // which instance was struck (see the Provenance comment up top).
// XXX is this not better set in the actual "use" case?
    if (isUseBody(def) && t) {
      t = reown(t, def.use, name);
      // Two instances alike in everything - prototype, every transform,
      // material - are the same geometry in the same place: never what
      // anyone means. Alike only in where they are, they are not: two
      // turned or scaled differently, their union or intersection, say.
      const key = JSON.stringify(def);
      const twin = instanceBodies.get(key);
      if (twin) {
        console.warn(`scene.json objects.${name}: identical to objects.${twin} ` +
                     '(same prototype, placed alike)');
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
  const claimTable = new Proxy({}, { get: () => ({ flags: MATERIAL_SOLID }) });
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

  // Whether a node starts an env (bakeScopes()): it carries lights, or
  // names an ambient material.
  const startsEnv = (t) => t.lights?.length > 0
    || (t.material !== INHERIT_MATERIAL && isRegionKind(table[t.material]?.kind));

  // `t` as it is within `region` ({ prim, sign }, with `ball` if it has
  // one): a copy without what lies on sides of its nodes proved clear of
  // the region. The same subtree if nothing is clear of it. `owner` is the
  // member the copy is part of. Exact, for materials and envs too
  // (bakeScopes()):
  //   - a node whose inside is clear is, there, its outside child, which
  //     resolves in the same scopes as the node: so it is replaced by it.
  //     Not by an absent one: absent, in an inside slot, would claim.
  //   - a node whose outside is clear is its inside: replaced by its inside
  //     child only if the node names no material and starts no env, so the
  //     child resolves as it would below it; else the outside is dropped.
  function pruneTo(t, region, owner, memberOf) {
    const frame = region.ball ? { c: region.ball.c, L: region.ball.r } : null;
    const clear = (prim, sign) => {
      if (region.ball) {
        const quick = ballClear(prim, sign, region.ball);
        if (quick !== undefined) return quick;
      }
      return regionsDisjoint(prim, sign, region.prim, region.sign, frame);
    };
    const memo = new Map();
    const walk = (n) => {
      if (!n) return n;
      if (memo.has(n)) return memo.get(n);
      const insideClear = clear(n.prim, 1);
      const outsideClear = !insideClear && clear(n.prim, -1);
      const inside = insideClear ? null : walk(n.inside);
      const outside = outsideClear ? null : walk(n.outside);
      let out = n;
      if (insideClear && outside) out = outside;
      else if (outsideClear && inside && n.material === INHERIT_MATERIAL && !startsEnv(n)) out = inside;
      else if (inside !== n.inside || outside !== n.outside) {
        out = node(n.prim, inside, outside, n.material, n.env, n.prov, n.lights);
        memberOf.set(out, owner);
      }
      memo.set(n, out);
      return out;
    };
    return walk(t);
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
      if (b && !(regionBall(m.tree.prim, true) && !m.tree.outside)) m.tree = node(sphere(b.c, b.r), m.tree, null, PASS_MATERIAL);
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
        const done = new Map();            // node -> Map(aliveKey and env -> result)
        // Within an env that an earlier member starts - a lit sphere round
        // a candle - what is grafted is a copy of its own anyway: the env
        // gives the nodes there env values of their own (bakeScopes()), so
        // the member is copied for it whole. So there it is grafted pruned
        // to the env's region (pruneTo()), one copy for the env, shared by
        // every place in it: a candle's sphere gets the few nodes of a maze
        // near it, not all of them. Elsewhere the member is shared, as it
        // is. `scope` is the env node, or null.
        const pruned = new Map();          // env node -> the member pruned to its region
        const scopeIds = new Map([[null, 0]]);
        const memberIn = (scope) => {
          if (!scope) return m.tree;
          if (!pruned.has(scope)) {
            const ball = regionBall(scope.prim, true);
            pruned.set(scope, pruneTo(m.tree, { prim: scope.prim, sign: 1, ball }, m.index, memberOf));
          }
          return pruned.get(scope);
        };
        const graft = (t, alive, scope) => {
          let byAlive = done.get(t);
          if (!byAlive) { byAlive = new Map(); done.set(t, byAlive); }
          if (!scopeIds.has(scope)) scopeIds.set(scope, scopeIds.size);
          const key = `${aliveKey(alive)}|${scopeIds.get(scope)}`;
          if (!byAlive.has(key)) byAlive.set(key, graftOnce(t, alive, scope));
          return byAlive.get(key);
        };
        const graftOnce = (t, alive, scope) => {
          if (--budget < 0) throw GRAFT_BUDGET;
          let inside = t.inside, outside = t.outside;
          const owner = memberOf.get(t);
          const inAlive = knock(shape, alive, { prim: t.prim, sign: 1 });
          if (inAlive !== null) {
            if (t.inside) inside = graft(t.inside, inAlive, startsEnv(t) ? t : scope);
            else report(owner, m.index);           // a region `owner` claims: the claim stands
          }
          const outAlive = knock(shape, alive, { prim: t.prim, sign: -1 });
          if (outAlive !== null) outside = t.outside ? graft(t.outside, outAlive, scope) : memberIn(scope);
          if (inside === t.inside && outside === t.outside) return t;
          const copy = node(t.prim, inside, outside, t.material, t.env, t.prov, t.lights);
          if (owner !== undefined) memberOf.set(copy, owner);
          return copy;
        };
        try {
          acc = graft(acc, shape.paths ?? UNPROVEN, null);
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
    intersection: (a, b) => intersect(a, b),
    intersect: (a, b) => intersect(a, b),      // the old name, still read (buildCombination())
    difference: (a, b) => difference(a, b),
  };

  const COMBINER_HELP = {
    union: 'keep everything inside both regions',
    intersection: 'keep only what\'s interior to both regions',
    intersect: 'keep only what\'s interior to both regions',
    difference: 'the first operand, minus every operand after it',
  };

  function buildCombination(def, path, where) {
    // "intersect" was the name before "intersection" (a noun, as union and
    // difference are): still read, under its own name - the editor finds
    // nodes by the keys in the file - with a warning.
    if (def.intersect !== undefined) {
      if (def.intersection !== undefined) at(path, 'has both "intersection" and "intersect" (its old name): one only');
      warn(`${path}.intersect`, '"intersect" is now "intersection"');
    }
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

    const material = materialOf(def, path);

    let out;
    if (def.lights !== undefined &&
        (def.use !== undefined || def.group !== undefined ||
         Object.keys(COMBINERS).some((op) => def[op] !== undefined))) {
      at(`${path}.lights`, 'lights go on a node with a shape of its own, which is the region they light');
    }
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

      // Lights make the node a region (an env): what fills it is its
      // ambient level, if it names one, or the level around it.
      const lights = def.lights === undefined ? null : lightsOf(def.lights, `${path}.lights`);
      if (lights && material !== INHERIT_MATERIAL && !isRegionKind(table[material].kind)) {
        at(`${path}.material`, 'a node with lights is a region, lit, not a substance: name an ' +
                               'ambient or glowRegion material, or none, to keep the level around it');
      }
      out = node(primOf(def, path), insideTree, outsideTree, material, 0, provOf(where), lights);
    }

    // A material named on a use, group or combination goes on the root of
    // what it makes - on a copy of that root, never on the root itself: a
    // use's result is its object's own tree, shared by every use of it
    // (named() memoizes it), so setting it there set it for all of them,
    // the last one named winning even where none was (the first, untouched
    // use of three teapots took the third's gold). Copied, the rest of the
    // tree stays shared.
    if (material !== INHERIT_MATERIAL && out && out.material !== material) {
      out = node(out.prim, out.inside, out.outside, material, out.env, out.prov, out.lights);
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

    // "wrap": a bounding node round the subtree, worked out from its extent
    // (extentPoints()), so a ray that misses it skips everything inside.
    // Like a group member's sphere it is vacuum, passing the material round
    // it on (PASS_MATERIAL), and it stands clear of what it holds. None is added where the root already is one - its outside
    // empty and its inside the shape asked for - or where no bound can be
    // proved.
    if (def.wrap !== undefined) {
      if (def.wrap !== 'spheroid' && def.wrap !== 'slab') at(`${path}.wrap`, `"spheroid" or "slab", not ${JSON.stringify(def.wrap)}`);
      const already = out && !out.outside && (def.wrap === 'spheroid'
        ? regionBall(out.prim, true) !== null
        : out.prim.k_perp === 0 && out.prim.k_par > 0);
      const points = already ? null : extentPoints(out);
      if (!already && !points) {
        warn(`${path}.wrap`, "can't bound this subtree, so it isn't wrapped");
      } else if (!already && points.length) {
        let shape;
        if (def.wrap === 'spheroid') {
          shape = { spheroid: boundingSpheroidOfPoints(points) };
        } else {
          // The thinnest slab along any of the subtree's own axes, or x, y, z.
          let best = null;
          for (const a of [...axesOf(out), [1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
            let lo = Infinity, hi = -Infinity;
            for (const p of points) { const x = dot3(a, p); lo = Math.min(lo, x); hi = Math.max(hi, x); }
            if (!best || hi - lo < best.hi - best.lo) best = { a, lo, hi };
          }
          const grow = (best.hi - best.lo) * 1e-4 + 1e-9;
          shape = { slab: { center: best.a.map((v) => v * (best.lo + best.hi) / 2), axis: best.a,
                            thickness: best.hi - best.lo + 2 * grow } };
        }
        out = node(primOf(shape, `${path}.wrap`), out, null, PASS_MATERIAL);
      }
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
  // A root that comes to nothing (an object left out) is still a node 1,
  // which trace() starts at: one with nothing inside it anywhere, H = 1.
  const rootTree = tree(spec.root, 'root', { owner: ROOT_OWNER, segments: [] })
    ?? node({ axis: [0, 0, 1], k_par: 0, k_perp: 0, linear: [0, 0, 0], constant: 1 }, null, null, NO_MATERIAL);
  const nodes = flatten(bakeScopes(rootTree, table));

  // Every light, with the env it belongs to: the scene's (env 0) first, in
  // order, so the editor can replace just those; then each node's, its env
  // that node. So the list is in order of env, which the shader relies on:
  // it finds an env's lights by binary search (firstLightOf()). A node baked more than once - a lit room grafted into
  // several places - gives its lights once for each copy, under each
  // copy's env; a hit is in only one of them.
  const lightList = [...topLights];
  nodes.forEach((nd, i) => {
    for (const lt of nd.lights ?? []) {
      if (lt.pos_w !== 0 && quadricAt(nd.prim, lt.pos) >= 0) {
        const where = nd.prov ? `${nd.prov.owner}${nd.prov.path ? `/${nd.prov.path}` : ''}` : `node ${i}`;
        warn(`${where}.lights`, `the light at [${lt.pos}] is outside its own region, so lights nothing in it`);
      }
      lightList.push({ ...lt, env: i });
    }
  });
  return {
    nodes,
    // provenance[i] is { owner, path } for authored node i, or null for
    // node 0 and for nodes the compiler invented.
    provenance: nodes.map((n) => n.prov),
    materials: table,
    lights: lightList,
    topLights: topLights.length,           // the first this many are the scene's own
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
// written through the Material class generated from it. Its trace flags
// go to the GPU in its nodes' material ids (packNodes()), not here.
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
      opacity: m.opacity ?? 1,
      ambient: m.ambient ?? [0, 0, 0],
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
// The MATERIAL_ trace flags (from shaders/node.wgsls, by way of
// layouts.js) are a material id's high bits, over the material's index.
/**
 * The nodes as the GPU takes them. With `materials` (the compiled table),
 * each node's material id carries its material's trace flags (its `flags`),
 * which trace() reads, and NODE_ENV if the node starts an env; without,
 * just the index (physics, which reads none). Node 0, never a real node,
 * carries NODE_ENV if any node does: a scene with no envs skips looking
 * for one at every hit (envAt()). `first` is list[0]'s index in the tree,
 * for a list that is part of one.
 */
export function packNodes(list, materials = null, first = 0) {
  const views = Node.allocate(list.length);
  const anyEnv = materials && first === 0 && list.some((nd, j) => j > 0 && startsEnv(nd, materials));
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
      material_id: (nd.material | (materials?.[nd.material]?.flags ?? 0)
                    | (materials && (first + j === 0 ? anyEnv : startsEnv(nd, materials)) ? NODE_ENV : 0)) >>> 0,
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
  list.forEach((lt, j) => Light.write(views, j, { pos: lt.pos, color: lt.color, env: lt.env ?? 0, pos_w: lt.pos_w ?? 1 }));
  return views.f32;
}
