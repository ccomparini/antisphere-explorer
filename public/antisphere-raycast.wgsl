// Antisphere ray caster.
//
// An antisphere is five numbers, (n.xyz, a, k): the unit normal at the near
// diametric point, the signed distance from the origin to that point, and the
// signed curvature k = 1/(a+b) = 1/(2r). Planes are k = 0. Negating all five
// gives the exact complement.
//
// Traversal is a solid BSP walk where each node splits the ray at up to two
// points instead of one. Bindings, in order: camera, nodes, output image,
// lights, materials, then (traceFrom only) ray queries and ray results.

struct Node {
  surface_normal : vec3<f32>,   // outward unit normal at P0
  p0_dist        : f32,         // signed distance from the origin to P0
  curvature      : f32,         // signed, 1/(2r); zero is a plane
  inside         : i32,         // inside child
  outside        : i32,         // outside child

  // Two 16-bit halves, so scoped state costs no extra node bytes. Low half is
  // the surface paint: >= 0 sets scope, 0 clears it, negative leaves it alone.
  // High half is an environment index, 0 meaning inherit.
  // TODO replace this with a material ID
  paint          : i32,
};

struct Material {
  kind    : u32,       // selects the shading function
  pattern : u32,       // albedo modulation, independent of kind
  params  : vec2<f32>, // kind-specific
  albedo  : vec3<f32>,
  scale   : f32,
  albedo2 : vec3<f32>,
  pad     : f32,
};

const KIND_LAMBERT  : u32 = 0u;
const KIND_GLOSSY   : u32 = 1u;
const KIND_EMISSIVE : u32 = 2u;
const KIND_UNLIT    : u32 = 3u;
// An ambient container never shades. The compiler moves it into a node's
// environment half and leaves the paint half as PARTITION, so the node is
// spatial division that happens to set the ambient level beneath it.
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

// f(R) = k(R.R) + (1 - 2ak)(R.n) - a + k a^2
fn fAt(nd : Node, R : vec3<f32>) -> f32 {
  return nd.curvature * dot(R, R)
       + (1.0 - 2.0 * nd.p0_dist * nd.curvature) * dot(R, nd.surface_normal)
       - nd.p0_dist + nd.curvature * nd.p0_dist * nd.p0_dist;
}

// grad f = 2kR + (1 - 2ak)n. Reduces to n exactly when k = 0.
fn gradAt(nd : Node, R : vec3<f32>) -> vec3<f32> {
  return 2.0 * nd.curvature * R + (1.0 - 2.0 * nd.p0_dist * nd.curvature) * nd.surface_normal;
}

// A stack entry is a piece of work not yet done: an interval of the ray and
// the subtree that interval still has to be tested against. Four words rather
// than six, because the array is per-invocation and its width costs occupancy
// more than the packing costs ALU.
//
//   ne  low half  the subtree still to visit, negative for a leaf
//       high half the node whose surface bounds t0, biased by one so that
//                 "none" is 0
//   se  low half  material scope inherited from enclosing nodes
//       high half environment scope, 0 meaning inherit
struct Seg {
  // what we have:
  ne : u32,
  t0 : f32,
  t1 : f32,
  se : u32,
  // I think we need/want:
  //  node: u32 node which contains the segment from t0 to t1
  //  t0, t1: along with O and D, represents the segment within node
  //  outer_material: the "material" (possibly empty, transparent, etc) outside the node.
  // Because materials can represent lit regions, 
};

struct Hit {
  hit  : bool,  // TODO get rid of this if we can make there be some sort of "none" node
  t    : f32,   // where the hit took place.  TODO replace with calculated position and/or normal?
  node : i32,   // which node was hit
  mat  : i32,   // TODO change this to be the outer material
  env  : i32,   // TODO kill this; env will come from mat
};

fn packNE(node : i32, entry : i32) -> u32 {
  return (u32(entry + 1) << 16u) | (u32(node) & 0xFFFFu);
}
fn segNode(w : u32) -> i32 { return i32(w << 16u) >> 16u; }
fn segEntry(w : u32) -> i32 { return i32(w >> 16u) - 1; }

fn packSE(scope : i32, env : i32) -> u32 {
  return (u32(env) << 16u) | (u32(scope) & 0xFFFFu);
}
fn segScope(w : u32) -> i32 { return i32(w & 0xFFFFu); }
fn segEnv(w : u32) -> i32 { return i32(w >> 16u); }

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

fn trace(O : vec3<f32>, D : vec3<f32>, tMin : f32, tMax : f32) -> Hit {
  var hit : Hit;
  hit.hit = false;
  hit.t = tMax;
  hit.node = -1;
  hit.mat = 0;
  hit.env = 0;

  // The region the ray is currently passing through. Leaves tile the ray and
  // pop in non-decreasing t, so the last void leaf popped before a solid is
  // the region touching that surface. That makes the medium a running
  // variable rather than a stack field, and it is also the more useful
  // answer: a body sitting in a region gets that region's light even when the
  // region is not one of its ancestors.
  var medium : i32 = 0;

  var stack : array<Seg, 32>;
  stack[0] = Seg(packNE(0, -1), tMin, tMax, packSE(0, 0));
  var sp : i32 = 1;

  var guard : i32 = 0;
  while (sp > 0) {
    guard = guard + 1;
    if (guard > 512) { break; }

    sp = sp - 1;
    let seg = stack[sp];
    if (seg.t1 - seg.t0 <= 1e-6) { continue; }

    let node = segNode(seg.ne);
    let scope = segScope(seg.se);
    let env = segEnv(seg.se);

    if (node < 0) {
      // Leaf. Its substrate is (-1 - node), and 0 is vacuum.
      let substrate = -1 - node;
      if (substrate == 0) {
        medium = env;
        continue;
      }
      // Front-to-back ordering means the first solid leaf popped is nearest.
      let entry = segEntry(seg.ne);
      hit.hit = true;
      hit.t = seg.t0;
      hit.node = entry;
      // Paint names the surface a node generates, so the node crossed to
      // arrive here wins. PARTITION and INHERIT are negative and defer to
      // whatever is in scope; BARE is 0 and falls through to the substrate.
      var painted = scope;
      if (entry >= 0) {
        let entryPaint = (nodes[entry].paint << 16) >> 16;
        if (entryPaint >= 0) { painted = entryPaint; }
      }
      hit.mat = select(substrate, painted, painted > 0);
      hit.env = medium;
      break;
    }

    let nd = nodes[node];
    visits = visits + 1u;

    // Substituting R = O + tD gives A t^2 + B t + C, with A = k.
    // A plane is the quadratic degenerating to linear, no special case.
    let lin = 1.0 - 2.0 * nd.p0_dist * nd.curvature;
    let A = nd.curvature;
    let B = 2.0 * nd.curvature * dot(O, D) + lin * dot(D, nd.surface_normal);
    let C = fAt(nd, O);

    var r0 = 0.0;
    var r1 = 0.0;
    var nr : i32 = 0;
    let disc = B * B - 4.0 * A * C;
    if (disc >= 0.0) {
      let sq = sqrt(disc);
      var q = -0.5 * (B + sq);
      if (B < 0.0) { q = -0.5 * (B - sq); }
      let x0 = q / A;
      var x1 = -B / A - x0;
      if (abs(q) > 1e-20) { x1 = C / q; }
      r0 = min(x0, x1);
      r1 = max(x0, x1);
      nr = 2;
    }

    // Up to two split points carve the segment into up to three subsegments.
    var b : array<f32, 4>;
    b[0] = seg.t0;
    var nb : i32 = 1;
    if (nr >= 1 && r0 > seg.t0 && r0 < seg.t1) { b[nb] = r0; nb = nb + 1; }
    if (nr == 2 && r1 > seg.t0 && r1 < seg.t1) { b[nb] = r1; nb = nb + 1; }
    b[nb] = seg.t1;

    let inherited = segEntry(seg.ne);

    // Push far to near so the nearest subsegment pops first.
    for (var i : i32 = nb - 1; i >= 0; i = i - 1) {
      let sa = b[i];
      let sb = b[i + 1];
      if (sb - sa <= 1e-6 || sp >= 32) { continue; }
      // Midpoint sign picks the child. Robust, and avoids reasoning about
      // which root is an entry and which is an exit.
      var child = nd.outside;
      var childScope = scope;
      var childEnv = env;
      if (fAt(nd, O + 0.5 * (sa + sb) * D) < 0.0) {
        child = nd.inside;
        // Paint and environment both scope the region f < 0 and nothing else.
        // To scope the far side instead, flip the node: negating all five
        // numbers is free, so the representation pays for this rule rather
        // than the traversal.
        let paint = (nd.paint << 16) >> 16;   // low half, sign extended
        let nodeEnv = nd.paint >> 16;         // high half, 0 means inherit
        if (paint >= 0) { childScope = paint; }
        if (nodeEnv != 0) { childEnv = nodeEnv; }
      }
      var ent = inherited;
      if (i > 0) { ent = node; }
      stack[sp] = Seg(packNE(child, ent), sa, sb, packSE(childScope, childEnv));
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
// collision or other physics later. Reuses trace() itself, so any change to
// how the scene is walked (including the material/solidity rework still in
// progress) automatically applies here too, rather than needing a second,
// separately-maintained implementation kept in sync by hand.
//
// Results come back through a GPU buffer, so the caller reads them via a
// mapAsync a frame or so after submitting, the same latency shape as the
// profiler's timestamp queries elsewhere in this file. Miss is t < 0, since
// a real t is never negative for tMin >= 0.
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
  let hit = trace(q.o, q.d, q.tMin, q.tMax);
  rayResults[i] = select(-1.0, hit.t, hit.hit);
}

// Surface parameterization from the node's own five numbers. A plane gets a
// tangent basis; a sphere gets longitude and latitude about its center.
fn frame(nd : Node, P : vec3<f32>) -> vec2<f32> {
  if (nd.curvature == 0.0) {
    var axis = vec3<f32>(0.0, 0.0, 1.0);
    if (abs(nd.surface_normal.z) > 0.9) { axis = vec3<f32>(1.0, 0.0, 0.0); }
    let t = normalize(cross(nd.surface_normal, axis));
    let b = cross(nd.surface_normal, t);
    return vec2<f32>(dot(P, t), dot(P, b));
  }
  let c = (nd.p0_dist - 0.5 / nd.curvature) * nd.surface_normal;
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

struct Surf {
  env : i32,           // environment in scope where the ray hit
  P  : vec3<f32>,      // hit position
  N  : vec3<f32>,      // outward normal, already faced toward the ray
  V  : vec3<f32>,      // toward the viewer
  st : vec2<f32>,      // node-frame parameterization, scaled
  m  : Material,
};

struct Direct { diffuse : vec3<f32>, specular : vec3<f32>, };

fn albedoAt(s : Surf) -> vec3<f32> {
  if (s.m.pattern == PATTERN_CHECKER) {
    let ck = fract((floor(s.st.x) + floor(s.st.y)) * 0.5);
    return mix(s.m.albedo, s.m.albedo2, step(0.25, ck));
  }
  return s.m.albedo;
}

// Ambient is whatever environment is in scope at the hit, shaped by a crude
// hemisphere term. Environment 0 is the default.
fn ambient(env : i32, N : vec3<f32>) -> vec3<f32> {
  var base = vec3<f32>(0.13, 0.13, 0.14);
  if (env > 0) { base = materials[env].albedo; }
  return base * (0.77 + 0.23 * max(N.z, 0.0));
}

// Sums direct light over every source, with one shadow ray each. A shininess
// of zero skips the specular term entirely.
fn directLighting(s : Surf, shininess : f32) -> Direct {
  var out : Direct;
  out.diffuse = vec3<f32>(0.0);
  out.specular = vec3<f32>(0.0);

  // Bias scales with position so the offset stays meaningful out near the
  // shell as well as at the origin.
  let bias = 1e-3 * max(1.0, length(s.P));
  let shadowOrigin = s.P + s.N * bias;

  let n = arrayLength(&lights);
  for (var i : u32 = 0u; i < n; i = i + 1u) {
    let lt = lights[i];
    let d = lt.pos - s.P;
    let d2 = dot(d, d);
    let dist = sqrt(max(d2, 1e-8));
    let L = d / dist;

    let ndl = dot(s.N, L);
    if (ndl <= 0.0) { continue; }          // back-facing, no ray needed

    if (cam.shadows != 0u) {
      // Any solid between here and the light occludes it. The front-to-back
      // traversal already stops at the first one.
      shadowRays = shadowRays + 1u;
      if (trace(shadowOrigin, L, bias, dist - bias).hit) { continue; }
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
  let d = directLighting(s, 0.0);
  return albedoAt(s) * (ambient(s.env, s.N) + d.diffuse);
}

// params.x shininess, params.y specular strength
fn shadeGlossy(s : Surf) -> vec3<f32> {
  let d = directLighting(s, max(s.m.params.x, 1.0));
  return albedoAt(s) * (ambient(s.env, s.N) + d.diffuse) + d.specular * s.m.params.y;
}

// params.x emission strength, added on top of ordinary diffuse response
fn shadeEmissive(s : Surf) -> vec3<f32> {
  let d = directLighting(s, 0.0);
  let alb = albedoAt(s);
  return alb * (ambient(s.env, s.N) + d.diffuse) + alb * s.m.params.x;
}

fn shadeUnlit(s : Surf) -> vec3<f32> {
  return albedoAt(s);
}

fn shade(s : Surf) -> vec3<f32> {
  switch (s.m.kind) {
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

  // Ablation. Each stage's output has to stay live or the compiler will
  // delete the work being measured, so every level writes something derived
  // from what it computed.
  var h : Hit;
  h.hit = false;
  h.t = 0.0;
  h.node = -1;
  h.mat = 0;
  if (cam.ablate >= ABLATE_TRACE) {
    h = trace(cam.origin, dir, 1e-3, 1e4);
  }

  var col = vec3<f32>(0.0);
  var N = vec3<f32>(0.0);
  if (cam.ablate < ABLATE_TRACE) {
    col = abs(dir) * 0.25;
  } else if (cam.ablate < ABLATE_SHADE) {
    col = select(vec3<f32>(0.0), vec3<f32>(fract(h.t * 0.05)), h.hit);
  } else if (h.hit) {
    if (h.node < 0) {
      col = vec3<f32>(0.25, 0.04, 0.05);   // camera started inside solid
    } else {
      let nd = nodes[h.node];
      var s : Surf;
      s.P = cam.origin + h.t * dir;
      s.N = normalize(gradAt(nd, s.P));
      if (dot(s.N, dir) > 0.0) { s.N = -s.N; }   // face the ray
      s.V = -dir;
      s.m = materials[h.mat];
      s.st = frame(nd, s.P) * s.m.scale;
      s.env = h.env;
      N = s.N;
      col = shade(s);
    }
  }

  var outCol = pow(col, vec3<f32>(1.0 / 2.2));
  switch (cam.debug) {
    case DEBUG_VISITS:   { outCol = ramp(f32(visits) / 48.0); }
    case DEBUG_SHADOW:   { outCol = ramp(f32(shadowRays) / max(1.0, f32(arrayLength(&lights)))); }
    case DEBUG_DEPTH:    { outCol = ramp(f32(peakDepth) / 32.0); }
    case DEBUG_MATERIAL: {
      let f = f32(h.mat) * 1.9;
      outCol = select(vec3<f32>(0.0), 0.42 + 0.3 * vec3<f32>(sin(f), sin(f + 2.1), sin(f + 4.2)), h.hit);
    }
    case DEBUG_NORMAL:   { outCol = N * 0.5 + 0.5; }
    default: {}
  }

  textureStore(outTex, vec2<i32>(gid.xy), vec4<f32>(outCol, 1.0));
}
