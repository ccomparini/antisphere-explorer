// Antisphere ray caster.
//
// An antisphere is five numbers. Authoring uses (n.xyz, a, k): the unit
// normal at the near diametric point, the signed distance from the origin to
// that point, and the signed curvature k = 1/(a+b) = 1/(2r). Planes are k = 0.
// Negating all five gives the exact complement.
//
// The GPU stores the same five numbers in lifted form instead, because every
// runtime formula is cheaper in it and nothing is lost: n and a are never
// needed here, since the centre, the gradient and a plane's normal all come
// straight out of the lift. See Node.
//
// Traversal is a solid BSP walk where each node splits the ray at up to two
// points instead of one. Bindings, in order: camera, nodes, output image,
// lights, materials, then (traceFrom only) ray queries and ray results.

struct Node {
  // The implicit function in lifted form:
  //
  //   f(R) = lift_linear . R  +  curvature * (R . R)  +  lift_const
  //
  // which is (n, a, k) precomputed by the scene compiler as
  // lift_linear = (1 - 2ak)n and lift_const = a^2 k - a. Two dot products
  // and an add, where the (n, a, k) form re-derived (1 - 2ak) and
  // (a^2 k - a) on every call — and fAt is called about four times per node
  // visit, once for the ray's own origin and once per subsegment midpoint.
  //
  // Everything else derives from these too:
  //   grad f  = 2*curvature*R + lift_linear
  //   centre  = -lift_linear / (2*curvature)          (spheres)
  //   normal  = lift_linear                           (planes: 1-2ak = 1)
  lift_linear    : vec3<f32>,   // (1 - 2ak) n
  curvature      : f32,         // k, signed; zero is a plane
  lift_const     : f32,         // a^2 k - a

  inside         : u32,         // index of inside child or 0u -> no child
  outside        : u32,         // same but outside

  // "material" is an index into the materials table describing what's
  // "inside" the node.  Since nodes are surface boundaries, this means
  // that (unlike in reality) a bounded volume can "have" more than one
  // material.  This is an advantage, though; for example if you want to
  // model a cube with different colored sides, give the 6 nodes bounding
  // the cube different materials, et voilà.  It's up to scene/object
  // authors to make things look right.
  // Material 0 is reseved for empty space. The "outside" material is
  // implicitly 0.
  material       : i32,

  // Precomputed index of the "ambient" material in force at this node.
  // Used for applying region scoped lighting or other effects.
  env            : i32,
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
  pad3    : u32,
  pad4    : u32,
  pad5    : u32,
};

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
  return dot(nd.lift_linear, R) + nd.curvature * dot(R, R) + nd.lift_const;
}

// grad f = 2kR + (1 - 2ak)n, which is exactly the lift's own coefficients.
// Reduces to the plane normal when curvature is zero.
fn gradAt(nd : Node, R : vec3<f32>) -> vec3<f32> {
  return 2.0 * nd.curvature * R + nd.lift_linear;
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
struct Seg {
  node : u32,   // the subtree still to visit; encoded (see DEFAULT_INSIDE_BIT)
  t0   : f32,
  t1   : f32,
};

const DEFAULT_INSIDE_BIT : u32 = 0x80000000u;

fn trace(O : vec3<f32>, D : vec3<f32>, tMin : f32, tMax : f32) -> Seg {
  // hit.node == 0 means "no hit (yet)" - node 0 is reserved (see Node's
  // doc comment) so no real crossing can ever claim it. Segments pop in
  // non-decreasing t (see the loop below), so the first transition into
  // solid is always the nearest one; once found, further solid pops just
  // extend t1 (the full extent of that continuous run), and the moment a
  // pop turns up non-solid again, that run is done and nothing nearer is
  // left to find.
  var hit : Seg = Seg(0u, -1.0, tMax);

  // Loop-invariant across every node visited: these depend on the ray, not
  // on the node, so they are hoisted out rather than recomputed inside the
  // B and C coefficients each time round.
  let originDotDir = dot(O, D);
  let originSq = dot(O, O);

/*
  Alternate trace algorithm:

    Material ids are bitfields with:
     - Top 2 bits are index of refraction, encoded as:
       0 0:  n = 0.0 (space, close enough to air, etc)
       0 1:  n = 1.333 (water)
       1 0:  n = 1.5 (glass, plexiglass, or close enough)
       1 1:  n = i;  Considered solid
     - Next 14 bits reserved
     - Bottom 16 bits are index in materials table.
    Index of refraction/transparency is encoded in the ID
    because in usage it has to do with the interaction
    -between- materials; it has no application without
    a transition from one material to another.
    The material id == 0i is the default material and
    is space, void, or nothingness.

    FOR THE MOMENT we won't actually apply index of refraction here, because
    then we would have to deal with changing O and D.  

    Reserve the 0th node as a "void" node.

  New tracing algorithm:

    // helper function; (actually inline this somehow because it needs to see O, D and
    // the result node, or put O, D and the result node in some shared memory location
    // as appropriate)
    clip_push(vs_node, t0, t1, outer_material):
      - clip segment (O, D, t0, t1) against node vs_node as before,
        such that we get between 1 and 3 resulting segments, each of
        which might be inside or outside vs_node.
      - For each resulting segment, in order from farthest to closest to O:
        - if resulting_segment is inside vs_node:
          - if vs_node.material is solid: // (top bits both set - ignoring index of refraction for the moment)
            - set the Hit material to vs_node.material and hit position to t0
            - push (vs_node.inside, resulting_segment.t0, resulting_segment.t1, outer_material)
          - else: // same but inherit the material
            - push (vs_node.inside, resulting_segment.t0, resulting_segment.t1, vs_node.material)
        - else // it's  outside
          - push (vs_node.outside,  resulting_segment.t0, resulting_segment.t1, outer_material)

    trace(O, D, t0, t1):
      - initialize the result Hit to the void node and void material (0 and 0)
        void node indicates nothing was hit.
      - clip_push(root, t0, t1, void_material)
      - while there's something on the seg stack
        - cur_seg = pop from seg stack
        - if cur_seg.node
          - clip_push(cur_seg.node, cur_seg.t0, cur_seg.t1, cur_seg.material)
        - else we've hit a leaf:
          - return the Hit with outer_material set to the Seg outer material.

  Notes on the above:
   - the node's material refers to what's inside it.  Outside, the material
     is set by some ancestor node.  This allows us to scope lights (and maybe
     shadows and other effects TBD)
   - I believe this formulation might require alterations to the current way
     we do intersections and unions.
     - To intersect 2 spheres (say), make one of the the parent and make
       it empty; add the other as an inner child and give it the material
       you want the resulting object to have
     - To subtract, the thing being subtracted from is the parent: give
       it the material for the resulting object, then add the subtrahend
       with a void material as the inside child.
     - Unions and groups of solids:  Just add as outside children.
   - is there too much branching here?  if so, how can we reduce branching?
   - what's the right thing for segments which are tangent to a given sphere?
     possibly set behaviour per material? (more branching! :)
   - for this, we consider nodes are solid or not according to material.
     the default outer material is empty space.

*/

  var stack : array<Seg, 32>;
  stack[0] = Seg(1u, tMin, tMax);   // node 1 is always the tree's root (0 is reserved)
  var sp : i32 = 1;

  var guard : i32 = 0;
  while (sp > 0) {
    guard = guard + 1;
    if (guard > 512) { break; }

    sp = sp - 1;
    let seg = stack[sp];
    if (seg.t1 - seg.t0 <= 1e-6) { continue; }

    var descent_node = seg.node;
    if ((descent_node & DEFAULT_INSIDE_BIT) != 0u) {
      // Deferred default inside (see Seg's doc comment): resolve straight
      // from the tagged node's own material, no geometry test needed -
      // there's nothing left to split, this *is* the answer already.
      let seg_nn = seg.node & ~DEFAULT_INSIDE_BIT;
      let seg_node = nodes[seg_nn];
      if (materials[seg_node.material].solid != 0u) {
        if (hit.node == 0u) { hit = Seg(seg_nn, seg.t0, seg.t1); }
        //else { hit.t1 = seg.t1; }  // cmc I think the hit is just the hit at this point - we're only looking for hollows
      } else {
        // non-solid inside, so clear the hit:
        hit.node = 0u;
      }

      descent_node = seg_node.inside;
    } else {
      // we went outside.  outside is never solid,
      // so clear the hit:
      hit.node = 0u;
    }

    if (descent_node == 0u) {
      if (hit.node != 0u) { return hit; }
      continue;
    }

    let nd = nodes[descent_node];
    visits = visits + 1u;

    // Substituting R = O + tD gives A t^2 + B t + C, with A = k (|D| = 1).
    // A plane is the quadratic degenerating to linear.
    let A = nd.curvature;
    let B = 2.0 * nd.curvature * originDotDir + dot(nd.lift_linear, D);
    let C = dot(nd.lift_linear, O) + nd.curvature * originSq + nd.lift_const;

    // Roots start beyond any segment a ray can carry, so a miss, a ray
    // parallel to a plane, and a plane's sentinel far root are all rejected
    // by the same range test below. No count to keep or check.
    var r0 = 1e30;
    var r1 = 1e30;
    let disc = B * B - 4.0 * A * C;
    if (disc >= 0.0) {
      let sq = sqrt(disc);
      var q = -0.5 * (B + sq);
      if (B < 0.0) { q = -0.5 * (B - sq); }

      // The stable pair: C/q stays finite as A -> 0, q/A does not. A plane
      // therefore gets a sentinel rather than a division by zero, which WGSL
      // calls an indeterminate value and which would poison the min/max
      // below. +1e30 is safe in either slot: as r1 it fails r1 < seg.t1, and
      // as r0 it would fail r0 > seg.t0, so only the real root ever splits a
      // segment. q/A is still evaluated and simply discarded.
      //
      // For a plane q works out to exactly -B, so C/q is the linear root
      // -C/B, and q near zero there means the ray runs parallel to the plane
      // and never crosses it.
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

    // Push far to near so the nearest subsegment pops first.
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
  return hit;
}

// ---------------------------------------------------------------------------
// Host-side ray queries
//
// A batch entry point for anything that needs to ask the scene a geometric
// question without also rendering a frame: walk mode's ground probe today,
// collision or other physics later.
//
// Results come back through a GPU buffer, so the caller reads them via a
// mapAsync a frame or so after submitting, the same latency shape as the
// profiler's timestamp queries elsewhere in this file. If nothing is hit,
// node == 0 in the final segment returned.
// ---------------------------------------------------------------------------

struct RayQuery {
  o    : vec3<f32>,
  tMin : f32,
  d    : vec3<f32>,
  tMax : f32,
};

@group(0) @binding(5) var<storage, read> rayQueries : array<RayQuery>;
@group(0) @binding(6) var<storage, read_write> rayResults : array<f32>;

@compute @workgroup_size(64)
fn traceFrom(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&rayQueries)) { return; }
  let q = rayQueries[i];
  rayResults[i] = trace(q.o, q.d, q.tMin, q.tMax).t0;
}

// Surface parameterization from the node's own five numbers. A plane gets a
// tangent basis; a sphere gets longitude and latitude about its center.
fn frame(nd : Node, P : vec3<f32>) -> vec2<f32> {
  if (nd.curvature == 0.0) {
    // 1 - 2ak is exactly 1 for a plane, so lift_linear is the unit normal.
    let normal = nd.lift_linear;
    var axis = vec3<f32>(0.0, 0.0, 1.0);
    if (abs(normal.z) > 0.9) { axis = vec3<f32>(1.0, 0.0, 0.0); }
    let t = normalize(cross(normal, axis));
    let b = cross(normal, t);
    return vec2<f32>(dot(P, t), dot(P, b));
  }
  let c = nd.lift_linear / (-2.0 * nd.curvature);   // sphere centre
  let d = normalize(P - c);
  return vec2<f32>(atan2(d.y, d.x), asin(clamp(d.z, -1.0, 1.0)));
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

// What shading needs that cannot be recovered from the node alone: where the
// ray landed, which way the surface faces there, and which way the viewer is.
// Material and ambient environment both live on the node the ray crossed, so
// this carries that index rather than copies of either.
struct Surf {
  // cmc - pos vs P is annoying.  let's get some consistent naming (pos)
  P  : vec3<f32>,  // hit position in world coordinates
  N  : vec3<f32>,  // outward normal, already faced toward the ray
  V  : vec3<f32>,  // toward the viewer
  st : vec2<f32>,  // node-frame parameterization, scaled per material
  node : u32,      // index of the node with the relevant surface
};

struct Direct { diffuse : vec3<f32>, specular : vec3<f32>, };

fn surfaceMaterial(s : Surf) -> Material {
  return materials[nodes[s.node].material];
}

// Ambient is whatever environment the node carries, shaped by a crude
// hemisphere term. Environment 0 is the default.
fn ambient(env : i32, N : vec3<f32>) -> vec3<f32> {
  var base = vec3<f32>(0.13, 0.13, 0.14);
  if (env > 0) { base = materials[env].albedo; }
  return base * (0.77 + 0.23 * max(N.z, 0.0));
}

fn surfaceAmbient(s : Surf) -> vec3<f32> {
  return ambient(nodes[s.node].env, s.N);
}

fn albedoAt(s : Surf, m : Material) -> vec3<f32> {
  if (m.pattern == PATTERN_CHECKER) {
    let ck = fract((floor(s.st.x) + floor(s.st.y)) * 0.5);
    return mix(m.albedo, m.albedo2, step(0.25, ck));
  }
  return m.albedo;
}

// Sums direct light over every source, with one shadow ray each. A shininess
// of zero skips the specular term entirely.
fn directLighting(s : Surf, shininess : f32) -> Direct {
  var out : Direct;
  out.diffuse = vec3<f32>(0.0);
  out.specular = vec3<f32>(0.0);

  let n = arrayLength(&lights);
  for (var i : u32 = 0u; i < n; i = i + 1u) {
    let lt = lights[i];
    let d = lt.pos - s.P;
    let d2 = dot(d, d);
    let dist = sqrt(max(d2, 1e-8));
    let L = d / dist; // I guess L is normalized direction to light

    let ndl = dot(s.N, L);
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
      let hit = trace(lt.pos, -L, 0.0, dist+0.1);
      if(hit.node != s.node) {
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
      let H = normalize(L + s.V);
      out.specular = out.specular + E * pow(max(dot(s.N, H), 0.0), shininess);
    }
  }
  return out;
}

fn shadeLambert(s : Surf) -> vec3<f32> {
  let m = surfaceMaterial(s);
  let d = directLighting(s, 0.0);
  return albedoAt(s, m) * (surfaceAmbient(s) + d.diffuse);
}

// params.x shininess, params.y specular strength
fn shadeGlossy(s : Surf) -> vec3<f32> {
  let m = surfaceMaterial(s);
  let d = directLighting(s, max(m.params.x, 1.0));
  return albedoAt(s, m) * (surfaceAmbient(s) + d.diffuse) + d.specular * m.params.y;
}

// params.x emission strength, added on top of ordinary diffuse response
fn shadeEmissive(s : Surf) -> vec3<f32> {
  let m = surfaceMaterial(s);
  let d = directLighting(s, 0.0);
  let alb = albedoAt(s, m);
  return alb * (surfaceAmbient(s) + d.diffuse) + alb * m.params.x;
}

fn shadeUnlit(s : Surf) -> vec3<f32> {
  return albedoAt(s, surfaceMaterial(s));
}

fn shade(s : Surf) -> vec3<f32> {
  switch (surfaceMaterial(s).kind) {
    case KIND_GLOSSY:   { return shadeGlossy(s); }
    case KIND_EMISSIVE: { return shadeEmissive(s); }
    case KIND_UNLIT:    { return shadeUnlit(s); }
    default:            { return shadeLambert(s); }
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
  let dir = normalize(cam.fwd
    + cam.right * (ndc.x * cam.aspect * cam.tanHalf)
    + cam.up    * (ndc.y * cam.tanHalf));

  // Ablation - used for profiling separate stages of the render.
  // Each stage's output has to stay live or the compiler will delete
  // the work being measured, so every level writes something derived
  // from what it computed.
  var h = Seg(0u, -1.0, 0.0);
  if (cam.ablate >= ABLATE_TRACE) {
    h = trace(cam.origin, dir, 1e-3, 1e4);
  }

  var col = vec3<f32>(0.0);
  var N = vec3<f32>(0.0);
  if (cam.ablate < ABLATE_TRACE) {
    col = abs(dir) * 0.25;
  } else if (cam.ablate < ABLATE_SHADE) {
    col = select(vec3<f32>(0.0), vec3<f32>(fract(h.t0 * 0.05)), h.t0 >= 0.0);
  } else if (h.node != 0) {
    // the ray hit h.node - render according to the node's material
    // (see shade())
    let nd = nodes[h.node];
    var s : Surf;
    s.node = h.node;
    s.P = cam.origin + h.t0 * dir;
    s.N = normalize(gradAt(nd, s.P));
    if (dot(s.N, dir) > 0.0) { s.N = -s.N; }   // face the ray
    s.V = -dir;
    s.st = frame(nd, s.P) * materials[nd.material].scale; // surface parameterization
    N = s.N;
    col = shade(s);
  }

  var outCol = pow(col, vec3<f32>(1.0 / 2.2));
  switch (cam.debug) {
    case DEBUG_VISITS:   { outCol = ramp(f32(visits) / 48.0); }
    case DEBUG_SHADOW:   { outCol = ramp(f32(shadowRays) / max(1.0, f32(arrayLength(&lights)))); }
    case DEBUG_DEPTH:    { outCol = ramp(f32(peakDepth) / 32.0); }
    case DEBUG_MATERIAL: {
      // Same source main's shading uses (nodes[h.node].material). h.node
      // is 0 on a miss (never a real node - see Node's doc comment), so
      // no separate guard is needed the way h.entry < 0 used to need one.
      let shown = h.t0 >= 0.0;
      let f = f32(select(0, nodes[h.node].material, shown)) * 1.9;
      outCol = select(vec3<f32>(0.0), 0.42 + 0.3 * vec3<f32>(sin(f), sin(f + 2.1), sin(f + 4.2)), shown);
    }
    case DEBUG_NORMAL:   { outCol = N * 0.5 + 0.5; }
    default: {}
  }

  textureStore(outTex, vec2<i32>(gid.xy), vec4<f32>(outCol, 1.0));
}
