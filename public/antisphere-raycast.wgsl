// Antisphere ray caster.
//
// An antisphere is nine numbers: a unit axis of revolution, a curvature
// along it, a curvature around it, a linear term and a constant. That covers
// every quadric of revolution - sphere, spheroid, plane, slab, cylinder,
// paraboloid, hyperboloid of one or two sheets, cone - and negating all but
// the axis gives the exact complement, as it always did. Spheres and planes
// are the isotropic case, where the two curvatures are equal and the axis
// stops mattering.
//
// The GPU stores a rearrangement of those nine rather than the numbers an
// author wrote, because every runtime formula is cheaper in it and nothing
// is lost. See Node.
//
// Traversal is a solid BSP walk where each node splits the ray at up to two
// points instead of one. Bindings, in order: camera, nodes, output image,
// lights, materials, then (traceFrom only) ray queries and ray results.

struct Node {
  // A revolution quadric:
  //
  //   H(R) = curvature_perp (R.R) + curvature_delta (R.axis)^2
  //          + linear . R + const_term
  //
  // which is transpose(R) K R + 2 c.R + d for the scene compiler's
  // K = k_perp I + (k_par - k_perp) axis(x)axis. Two of the nine numbers
  // arrive rearranged, because these are the forms the formulas below
  // actually use:
  //
  //   curvature_delta = k_par - k_perp     zero for a sphere or a plane
  //   linear          = 2c                 as both H and its gradient want it
  //
  // Nothing is lost - k_par is curvature_perp + curvature_delta, and c is
  // linear/2 - and the isotropic case is exactly the old five numbers doing
  // what they always did: a sphere has curvature_delta 0 and curvature_perp
  // 1/(2r); a plane has both curvatures 0, leaving linear as its unit normal
  // and const_term as -a.
  //
  // Everything else derives from these too:
  //   grad H  = 2*curvature_perp*R + 2*curvature_delta*(R.axis)*axis + linear
  //   centre  = -linear / (2*curvature_perp)     (spheres; see frame())
  //   normal  = linear                           (planes)
  //
  // curvature_delta is also the test for "does this primitive have an axis
  // at all": zero means every direction is alike and `axis` is arbitrary.
  axis            : vec3<f32>,  // unit axis of revolution
  curvature_perp  : f32,        // k_perp, signed; curvature around the axis
  linear          : vec3<f32>,  // 2c
  curvature_delta : f32,        // k_par - k_perp
  const_term      : f32,        // d

  inside          : u32,        // index of inside child or 0u -> no child
  outside         : u32,        // same but outside

  // "material" is an index into the materials table describing what's
  // "inside" the node.  Since nodes are surface boundaries, this means
  // that (unlike in reality) a bounded volume can "have" more than one
  // material.  This is an advantage, though; for example if you want to
  // model a cube with different colored sides, give the 6 nodes bounding
  // the cube different materials, et voilà.  It's up to scene/object
  // authors to make things look right.
  // Material 0 is reseved for empty space. The "outside" material is
  // implicitly 0.
  material        : i32,

  // Precomputed index of the "ambient" material in force at this node.
  // Used for applying region scoped lighting or other effects.
  env             : i32,
};

struct Material {
  kind    : u32,       // selects the shading function
  pattern : u32,       // albedo modulation, independent of kind
  params  : vec2<f32>, // kind-specific
  albedo  : vec3<f32>,
  scale   : f32,
  albedo2 : vec3<f32>,
  solid   : u32,       // 0 or 1; used to determine if it stops rays
};

const KIND_LAMBERT  : u32 = 0u;
const KIND_GLOSSY   : u32 = 1u;
const KIND_EMISSIVE : u32 = 2u;
const KIND_UNLIT    : u32 = 3u;
// An ambient container never shades. The compiler moves it into a node's
// env field (and bakes that value onto every node beneath it - see
// bakeEnv() in antisphere-scene.js) and leaves its material as vacuum
// (0), so the node is a pure spatial division that sets the ambient
// level beneath it.
const KIND_AMBIENT  : u32 = 4u;

const PATTERN_CHECKER : u32 = 1u;

// Debug views. Traversal cost is counted per invocation rather than timed,
// since timestamps can only be written at pass boundaries.
const DEBUG_OFF      : u32 = 0u;
const DEBUG_VISITS   : u32 = 1u;   // node visits, primary + shadow rays
const DEBUG_SHADOW   : u32 = 2u;   // shadow rays actually traced
const DEBUG_DEPTH    : u32 = 3u;   // peak traversal stack depth
const DEBUG_MATERIAL : u32 = 4u;
const DEBUG_NORMAL   : u32 = 5u;

var<private> visits    : u32 = 0u;
var<private> shadowRays: u32 = 0u;
var<private> peakDepth : u32 = 0u;

struct Camera {
  origin  : vec3<f32>,
  tanHalf : f32,
  right   : vec3<f32>,
  aspect  : f32,
  up      : vec3<f32>,
  shadows : u32,   // 0 or 1; bool is not host-shareable, so it crosses as u32
  fwd     : vec3<f32>,
  debug   : u32,   // DEBUG_ view, 0 = shaded
  ablate  : u32,   // ABLATE_ level, for the profiler's ablation ladder

  // Written by the renderer, but the light loop uses arrayLength() instead,
  // so nothing here reads it. Named rather than padded so the two sides of
  // the uniform agree about what lives where.
  light_count : u32,

  // How rays are cast (see PROJECTION_ below and main()). Under an
  // orthographic projection every ray runs along fwd and it is the origin
  // that moves across the image plane, so the pixel scale can't come from
  // an angle: ortho_half_height is half the visible height, in world units.
  projection       : u32,
  ortho_half_height : f32,
};

// A point of view with rays fanning out from it, or a direction with rays
// running parallel to it. A ray caster has no projection matrix to swap, so
// this is the whole difference: which of the origin and the direction the
// pixel moves.
const PROJECTION_PERSPECTIVE  : u32 = 0u;
const PROJECTION_ORTHOGRAPHIC : u32 = 1u;

// Rungs of the ablation ladder. Each level adds one stage back, and the
// differences between consecutive pass times give the stage costs. Shadow
// rays are the level above this, driven by Camera.shadows.
const ABLATE_NONE  : u32 = 0u;   // dispatch and ray setup only
const ABLATE_TRACE : u32 = 1u;   // add traversal, no shading
const ABLATE_SHADE : u32 = 2u;   // add shading

struct Light {
  pos   : vec3<f32>,
  pad0  : f32,
  color : vec3<f32>,   // magnitude is radiant power, so values may exceed 1
  pad1  : f32,
};

@group(0) @binding(0) var<uniform> cam : Camera;
@group(0) @binding(1) var<storage, read> nodes : array<Node>;
@group(0) @binding(2) var outTex : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<storage, read> lights : array<Light>;
@group(0) @binding(4) var<storage, read> materials : array<Material>;

// The implicit function at an arbitrary point. trace() no longer calls this:
// along a ray it works with the A/B/C coefficients of the same polynomial
// instead, which is cheaper. Kept because it is the definition everything
// else is derived from, and for callers that have a point rather than a ray.
fn fAt(nd : Node, R : vec3<f32>) -> f32 {
  let along = dot(nd.axis, R);
  return nd.curvature_perp * dot(R, R) + nd.curvature_delta * along * along
       + dot(nd.linear, R) + nd.const_term;
}

// grad H = 2KR + 2c, which is exactly the stored coefficients. Reduces to
// 2kR + 2c for a sphere and to the plane's own normal when both curvatures
// are zero. Callers normalize, so the factor of two is harmless.
fn gradAt(nd : Node, R : vec3<f32>) -> vec3<f32> {
  return 2.0 * nd.curvature_perp * R
       + 2.0 * nd.curvature_delta * dot(nd.axis, R) * nd.axis
       + nd.linear;
}

// A stack entry is a piece of work not yet done: an interval of the ray and
// the node that interval still has to be tested against. Plain fields
// rather than packed words: the array is per-invocation, so this costs more
// occupancy, but a packing bug (segScope forgetting to sign-extend) is what
// once spent an afternoon painting cavity interiors as garbage material
// indices, so for now clarity wins over the two words this could be.
//
// node's top bit (DEFAULT_INSIDE_BIT) is the one deliberate exception: set,
// it flags "this segment is (node & ~DEFAULT_INSIDE_BIT)'s own default
// inside" (see Node's doc comment) rather than a node still needing its
// geometry tested. That distinction has to survive being deferred on the
// stack: a node whose *other* side needs recursing into first (its outside
// continuing into the rest of the scene is the most common shape a node
// takes) can't have its own default inside resolved until that recursion
// finishes, so by the time this pops, nothing but the tag says which
// node's material it was ever about. Untagged, node is always a real,
// already-resolved index; 0 is never real (see Node's doc comment), so it
// just means void.
//
// trace() returns one of these too, as its answer: see trace().
struct Seg {
  node : u32,   // the subtree still to visit; encoded (see DEFAULT_INSIDE_BIT)
  t0   : f32,
  t1   : f32,
};

const DEFAULT_INSIDE_BIT : u32 = 0x80000000u;

// Below this, a ray's polynomial coefficient counts as zero: see the ruled
// surfaces in trace().
const DEGENERATE : f32 = 1e-12;

// The first solid thing along a ray, as a Seg: node is the node whose
// region the ray entered (never tagged), t0 how far along the ray it
// entered, and t1 where the segment it was found in ends. t1 is not
// necessarily the far side of the object, so it isn't a thickness.
//
// node == 0 is the one test for a miss. t0 and t1 mean nothing then: a
// provisional hit that turned out hollow leaves its distances behind, and
// resetting them costs time for a value no caller should read.
fn trace(O : vec3<f32>, D : vec3<f32>, tMin : f32, tMax : f32) -> Seg {
  // found.node == 0 means "no hit (yet)" - node 0 is reserved (see Node's
  // doc comment) so no real crossing can ever claim it. Segments pop in
  // non-decreasing t (see the loop below), so the first transition into
  // solid is always the nearest one; once found, further solid pops just
  // extend t1 (the full extent of that continuous run), and the moment a
  // pop turns up non-solid again, that run is done and nothing nearer is
  // left to find.
  var found : Seg = Seg(0u, -1.0, tMax);

  // Loop-invariant across every node visited: these depend on the ray, not
  // on the node, so they are hoisted out rather than recomputed inside the
  // B and C coefficients each time round.
  let originDotDir = dot(O, D);
  let originSq = dot(O, O);

  // The root is held in a variable rather than seeded onto the stack, which
  // is what lets a length check at the top of the loop go. The push below is
  // the only thing that ever writes the stack, and it rejects anything
  // shorter than the epsilon, so no popped segment can be degenerate. A
  // degenerate range from the caller then costs one node visit that pushes
  // nothing, instead of a test on every iteration forever after.
  var seg = Seg(1u, tMin, tMax);   // node 1 is always the tree's root (0 is reserved)
  var stack : array<Seg, 32>;
  var sp : i32 = 0;

  var guard : i32 = 0;
  loop {

    var descent_node = seg.node;
    if ((descent_node & DEFAULT_INSIDE_BIT) != 0u) {
      // Deferred default inside (see Seg's doc comment): resolve straight
      // from the tagged node's own material, no geometry test needed -
      // there's nothing left to split, this *is* the answer already.
      let seg_nn = seg.node & ~DEFAULT_INSIDE_BIT;
      let seg_node = nodes[seg_nn];
      if (materials[seg_node.material].solid != 0u) {
        if (found.node == 0u) { found = Seg(seg_nn, seg.t0, seg.t1); }
        //else { found.t1 = seg.t1; }  // cmc I think the hit is just the hit at this point - we're only looking for hollows
      } else {
        // non-solid inside, so clear the hit:
        found.node = 0u;
      }

      descent_node = seg_node.inside;
    } else {
      // we went outside.  outside is never solid,
      // so clear the hit:
      found.node = 0u;
    }

    if (descent_node == 0u) {
      // Nothing further to test down this branch. If a solid run was open,
      // it ended here and is the nearest one there is.
      if (found.node != 0u) { return found; }
    } else {
      let nd = nodes[descent_node];
      visits = visits + 1u;

      // Substituting R = O + tD into H gives A t^2 + B t + C (|D| = 1). A
      // plane is the quadratic degenerating to linear, and so is a cylinder
      // or a paraboloid to a ray that runs along its axis.
      let axisDotDir = dot(nd.axis, D);
      let axisDotOrigin = dot(nd.axis, O);
      let A = nd.curvature_perp + nd.curvature_delta * axisDotDir * axisDotDir;
      let B = 2.0 * (nd.curvature_perp * originDotDir
                     + nd.curvature_delta * axisDotOrigin * axisDotDir)
              + dot(nd.linear, D);
      let C = nd.curvature_perp * originSq
              + nd.curvature_delta * axisDotOrigin * axisDotOrigin
              + dot(nd.linear, O) + nd.const_term;

      // Roots start beyond any segment a ray can carry, so a miss, a ray
      // parallel to a plane, and a plane's sentinel far root are all rejected
      // by the same range test below. No count to keep or check.
      var r0 = 1e30;
      var r1 = 1e30;
      let disc = B * B - 4.0 * A * C;
      // Cylinders, cones and hyperboloids of one sheet are ruled: they
      // contain whole straight lines, and a ray along one makes A, B and C
      // vanish together - H is zero the length of the ray, not at two points
      // on it. The all-zero sentinel node does the same. Both have to be
      // caught before the divide, since WGSL's fast-math assumption means a
      // NaN produced there may never be noticed downstream. With no roots the
      // segment stays whole, and the midpoint test below puts it outside,
      // which is right: a ray lying in a surface never enters it.
      if (disc >= 0.0 && (abs(A) > DEGENERATE || abs(B) > DEGENERATE)) {
        let sq = sqrt(disc);
        var q = -0.5 * (B + sq);
        if (B < 0.0) { q = -0.5 * (B - sq); }

        // The stable pair: C/q stays finite as A -> 0, q/A does not. A plane
        // therefore gets a sentinel rather than a division by zero, which
        // WGSL calls an indeterminate value and which would poison the
        // min/max below. +1e30 is safe in either slot: as r1 it fails
        // r1 < seg.t1, and as r0 it would fail r0 > seg.t0, so only the real
        // root ever splits a segment. q/A is still evaluated and discarded.
        //
        // For a plane q works out to exactly -B, so C/q is the linear root
        // -C/B, and q near zero there means the ray runs parallel to the
        // plane and never crosses it.
        let far = select(1e30, q / A, A != 0.0);
        let near = select(-B / A - far, C / q, abs(q) > 1e-20);
        if (abs(q) > 1e-20 || A != 0.0) {
          r0 = min(near, far);
          r1 = max(near, far);
        }
      }

      // Up to two split points carve the segment into up to three subsegments.
      var b : array<f32, 4>;
      b[0] = seg.t0;
      var nb : i32 = 1;
      if (r0 > seg.t0 && r0 < seg.t1) { b[nb] = r0; nb = nb + 1; }
      if (r1 > seg.t0 && r1 < seg.t1) { b[nb] = r1; nb = nb + 1; }
      b[nb] = seg.t1;

      // Push far to near so the nearest subsegment pops first. This is the
      // only write to the stack, and the length test here is what makes the
      // one at the top of the loop unnecessary.
      for (var i : i32 = nb - 1; i >= 0; i = i - 1) {
        let sa = b[i];
        let sb = b[i + 1];
        if (sb - sa <= 1e-6 || sp >= 32) { continue; }
        // Midpoint sign picks the child. Robust, and avoids reasoning about
        // which root is an entry and which is an exit. f(O + tD) is the very
        // polynomial just solved, so this is two fused multiply-adds rather
        // than building the point and evaluating f from scratch.
        let mid = 0.5 * (sa + sb);
        var child = nd.outside;
        if ((A * mid + B) * mid + C < 0.0) {
          child = descent_node | DEFAULT_INSIDE_BIT;
        }
        stack[sp] = Seg(child, sa, sb);
        sp = sp + 1;
        peakDepth = max(peakDepth, u32(sp));
      }
    }

    if (sp == 0) { break; }
    sp = sp - 1;
    seg = stack[sp];

    guard = guard + 1;
    if (guard >= 512) {
      break; // invalidate hit as well?
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Host-side ray queries
//
// A batch entry point for anything that needs to ask the scene a geometric
// question without also rendering a frame: walk mode's ground probe,
// picking in the editor, collision or other physics later.
//
// Each result is the Seg that trace() returns: node is the node whose
// region the ray entered, or 0 for a miss; t0 how far along the ray and t1
// where that segment ends, both meaningless for a miss. The host reads these back via a
// mapAsync a frame or so after submitting, the same latency shape as the
// profiler's timestamp queries elsewhere; as-context.js's RAY_HIT_BYTES is
// the size of one.
// ---------------------------------------------------------------------------

struct RayQuery {
  o    : vec3<f32>,
  tMin : f32,
  d    : vec3<f32>,
  tMax : f32,
};

@group(0) @binding(5) var<storage, read> rayQueries : array<RayQuery>;
@group(0) @binding(6) var<storage, read_write> rayResults : array<Seg>;

@compute @workgroup_size(64)
fn traceFrom(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&rayQueries)) { return; }
  let q = rayQueries[i];
  rayResults[i] = trace(q.o, q.d, q.tMin, q.tMax);
}

// Surface parameterization from the node's own numbers. A plane gets a
// tangent basis; a sphere gets longitude and latitude about its centre; and
// anything with a real axis - spheroid, cylinder, cone, paraboloid,
// hyperboloid - gets the natural cylindrical pair: the angle around the axis
// and the distance along it.
fn frame(nd : Node, P : vec3<f32>) -> vec2<f32> {
  // A tangent basis for an axis or a normal, avoiding the degenerate cross.
  var axis = nd.axis;
  if (nd.curvature_perp == 0.0 && nd.curvature_delta == 0.0) {
    // A plane: both curvatures zero leaves linear as the unit normal.
    axis = nd.linear;
  }
  var helper = vec3<f32>(0.0, 0.0, 1.0);
  if (abs(axis.z) > 0.9) { helper = vec3<f32>(1.0, 0.0, 0.0); }
  let t = normalize(cross(axis, helper));
  let b = cross(axis, t);

  if (nd.curvature_perp == 0.0 && nd.curvature_delta == 0.0) {
    return vec2<f32>(dot(P, t), dot(P, b));
  }
  if (nd.curvature_delta == 0.0) {
    // Isotropic: a sphere about -c/k, in longitude and latitude as before.
    let centre = nd.linear / (-2.0 * nd.curvature_perp);
    let d = normalize(P - centre);
    return vec2<f32>(atan2(d.y, d.x), asin(clamp(d.z, -1.0, 1.0)));
  }

  // An axis of its own. Anchor at whichever centre exists: along the axis
  // when there is curvature along it, across when there is curvature
  // around it. A cone or a cylinder has only one of the two; a spheroid has
  // both, and they meet at its centre.
  let c = 0.5 * nd.linear;
  let k_par = nd.curvature_perp + nd.curvature_delta;
  let axial = dot(c, axis);
  var anchor = vec3<f32>(0.0);
  if (k_par != 0.0) { anchor = anchor - (axial / k_par) * axis; }
  if (nd.curvature_perp != 0.0) {
    anchor = anchor - (c - axial * axis) / nd.curvature_perp;
  }
  let u = P - anchor;
  return vec2<f32>(atan2(dot(u, b), dot(u, t)), dot(u, axis));
}

// ---------------------------------------------------------------------------
// Shading
//
// One function per material kind, dispatched on Material.kind. Light
// integration is shared: directLighting() owns the only shadow-ray call site,
// so adding a kind costs a function and a switch arm, not another traversal.
//
// These functions are also the natural split points if this ever becomes a
// wavefront renderer: each would be the entry point of its own pipeline,
// running over hits bucketed by material.
// ---------------------------------------------------------------------------

// Where a ray landed, resolved for shading: what can't be recovered from the
// node alone - the point, which way the surface faces there, and which way
// the viewer is. Material and ambient environment both live on the node the
// ray crossed, so this carries that index rather than copies of either.
//
// trace() answers with a Seg, which says only which node was entered and
// how far along the ray. main() resolves that into a Hit for rays it
// shades; nothing else needs the rest.
struct Hit {
  position      : vec3<f32>,  // world coordinates
  normal        : vec3<f32>,  // outward, already faced toward the ray
  toViewer      : vec3<f32>,  // unit vector back along the ray
  surfaceCoords : vec2<f32>,  // node-frame parameterization, scaled per material
  node          : u32,        // the node whose surface was hit
};

struct Direct { diffuse : vec3<f32>, specular : vec3<f32>, };

fn surfaceMaterial(hit : Hit) -> Material {
  return materials[nodes[hit.node].material];
}

// Ambient is whatever environment the node carries, shaped by a crude
// hemisphere term. Environment 0 is the default.
fn ambient(env : i32, N : vec3<f32>) -> vec3<f32> {
  var base = vec3<f32>(0.13, 0.13, 0.14);
  if (env > 0) { base = materials[env].albedo; }
  return base * (0.77 + 0.23 * max(N.z, 0.0));
}

fn surfaceAmbient(hit : Hit) -> vec3<f32> {
  return ambient(nodes[hit.node].env, hit.normal);
}

fn albedoAt(hit : Hit, m : Material) -> vec3<f32> {
  if (m.pattern == PATTERN_CHECKER) {
    let ck = fract((floor(hit.surfaceCoords.x) + floor(hit.surfaceCoords.y)) * 0.5);
    return mix(m.albedo, m.albedo2, step(0.25, ck));
  }
  return m.albedo;
}

// Sums direct light over every source, with one shadow ray each. A shininess
// of zero skips the specular term entirely.
fn directLighting(hit : Hit, shininess : f32) -> Direct {
  var out : Direct;
  out.diffuse = vec3<f32>(0.0);
  out.specular = vec3<f32>(0.0);

  let n = arrayLength(&lights);
  for (var i : u32 = 0u; i < n; i = i + 1u) {
    let lt = lights[i];
    let d = lt.pos - hit.position;
    let d2 = dot(d, d);
    let dist = sqrt(max(d2, 1e-8));
    let L = d / dist; // I guess L is normalized direction to light

    let ndl = dot(hit.normal, L);
    if (ndl <= 0.0) { continue; }          // back-facing, no ray needed

    if (cam.shadows != 0u) {
      // Any solid between light and the surface occludes the light.
      // The front-to-back traversal already stops at the first one.
      // (cmc: possible optimization would be a trace-in-any-order,
      // which would simply check if anything occluded the beam
      // regardless of order)
      shadowRays = shadowRays + 1u;
      // dist + 0.1 makes us measure a bit past the surface so that
      // we don't get roundoff effects:
      let blocker = trace(lt.pos, -L, 0.0, dist+0.1);
      if(blocker.node != hit.node) {
        // the ray hit something other than our surface,
        // so we're in shadow:
        continue;
      }
    }

    // Inverse square, softened near zero so a light sitting on a surface
    // does not blow out.
    let E = lt.color / (1.0 + d2);
    out.diffuse = out.diffuse + E * ndl;
    if (shininess > 0.0) {
      let H = normalize(L + hit.toViewer);
      out.specular = out.specular + E * pow(max(dot(hit.normal, H), 0.0), shininess);
    }
  }
  return out;
}

fn shadeLambert(hit : Hit) -> vec3<f32> {
  let m = surfaceMaterial(hit);
  let d = directLighting(hit, 0.0);
  return albedoAt(hit, m) * (surfaceAmbient(hit) + d.diffuse);
}

// params.x shininess, params.y specular strength
fn shadeGlossy(hit : Hit) -> vec3<f32> {
  let m = surfaceMaterial(hit);
  let d = directLighting(hit, max(m.params.x, 1.0));
  return albedoAt(hit, m) * (surfaceAmbient(hit) + d.diffuse) + d.specular * m.params.y;
}

// params.x emission strength, added on top of ordinary diffuse response
fn shadeEmissive(hit : Hit) -> vec3<f32> {
  let m = surfaceMaterial(hit);
  let d = directLighting(hit, 0.0);
  let alb = albedoAt(hit, m);
  return alb * (surfaceAmbient(hit) + d.diffuse) + alb * m.params.x;
}

fn shadeUnlit(hit : Hit) -> vec3<f32> {
  return albedoAt(hit, surfaceMaterial(hit));
}

fn shade(hit : Hit) -> vec3<f32> {
  switch (surfaceMaterial(hit).kind) {
    case KIND_GLOSSY:   { return shadeGlossy(hit); }
    case KIND_EMISSIVE: { return shadeEmissive(hit); }
    case KIND_UNLIT:    { return shadeUnlit(hit); }
    default:            { return shadeLambert(hit); }
  }
}

// Perceptually ordered ramp for the cost views: dark blue through cyan,
// green, yellow, red, to white for anything off the top of the scale.
fn ramp(t : f32) -> vec3<f32> {
  let s = clamp(t, 0.0, 1.0) * 5.0;
  if (s < 1.0) { return mix(vec3<f32>(0.04, 0.05, 0.22), vec3<f32>(0.10, 0.62, 0.85), s); }
  if (s < 2.0) { return mix(vec3<f32>(0.10, 0.62, 0.85), vec3<f32>(0.20, 0.82, 0.28), s - 1.0); }
  if (s < 3.0) { return mix(vec3<f32>(0.20, 0.82, 0.28), vec3<f32>(0.95, 0.85, 0.15), s - 2.0); }
  if (s < 4.0) { return mix(vec3<f32>(0.95, 0.85, 0.15), vec3<f32>(0.95, 0.24, 0.10), s - 3.0); }
  return mix(vec3<f32>(0.95, 0.24, 0.10), vec3<f32>(1.0, 1.0, 1.0), s - 4.0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  visits = 0u;
  shadowRays = 0u;
  peakDepth = 0u;

  let dims = textureDimensions(outTex);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let uv = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(dims);
  let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);

  var origin = cam.origin;
  var dir = cam.fwd;
  // Where the ray may start. A perspective eye is a point, and anything
  // behind it is behind the viewer; an orthographic "eye" is a plane, and
  // the geometry on the near side of it is exactly what an editor view is
  // usually looking for, so the ray is allowed to begin well behind.
  var tMin = 1e-3;

  if (cam.projection == PROJECTION_ORTHOGRAPHIC) {
    origin = cam.origin
      + cam.right * (ndc.x * cam.aspect * cam.ortho_half_height)
      + cam.up    * (ndc.y * cam.ortho_half_height);
    //tMin = -1e4; // cmc this seems to make it show all grey in default scene
  } else {
    dir = normalize(cam.fwd
      + cam.right * (ndc.x * cam.aspect * cam.tanHalf)
      + cam.up    * (ndc.y * cam.tanHalf));
  }

  // Ablation - used for profiling separate stages of the render.
  // Each stage's output has to stay live or the compiler will delete
  // the work being measured, so every level writes something derived
  // from what it computed.
  var found = Seg(0u, -1.0, 0.0);
  if (cam.ablate >= ABLATE_TRACE) {
    found = trace(origin, dir, tMin, 1e4);
  }

  var col = vec3<f32>(0.0);
  var N = vec3<f32>(0.0);
  if (cam.ablate < ABLATE_TRACE) {
    col = abs(dir) * 0.25;
  } else if (cam.ablate < ABLATE_SHADE) {
    col = select(vec3<f32>(0.0), vec3<f32>(fract(found.t0 * 0.05)), found.node != 0u);
  } else if (found.node != 0) {
    // the ray entered found.node - render according to the node's material
    // (see shade())
    let nd = nodes[found.node];
    var hit : Hit;
    hit.node = found.node;
    hit.position = origin + found.t0 * dir;
    hit.normal = normalize(gradAt(nd, hit.position));
    if (dot(hit.normal, dir) > 0.0) { hit.normal = -hit.normal; }   // face the ray
    hit.toViewer = -dir;
    hit.surfaceCoords = frame(nd, hit.position) * materials[nd.material].scale;
    N = hit.normal;
    col = shade(hit);
  }

  var outCol = pow(col, vec3<f32>(1.0 / 2.2));
  switch (cam.debug) {
    case DEBUG_VISITS:   { outCol = ramp(f32(visits) / 48.0); }
    case DEBUG_SHADOW:   { outCol = ramp(f32(shadowRays) / max(1.0, f32(arrayLength(&lights)))); }
    case DEBUG_DEPTH:    { outCol = ramp(f32(peakDepth) / 32.0); }
    case DEBUG_MATERIAL: {
      // Same source main's shading uses (nodes[found.node].material).
      // found.node is 0 on a miss (never a real node - see Node's doc
      // comment), which is the only reliable miss test (see trace()).
      let shown = found.node != 0u;
      let f = f32(select(0, nodes[found.node].material, shown)) * 1.9;
      outCol = select(vec3<f32>(0.0), 0.42 + 0.3 * vec3<f32>(sin(f), sin(f + 2.1), sin(f + 4.2)), shown);
    }
    case DEBUG_NORMAL:   { outCol = N * 0.5 + 0.5; }
    default: {}
  }

  textureStore(outTex, vec2<i32>(gid.xy), vec4<f32>(outCol, 1.0));
}
