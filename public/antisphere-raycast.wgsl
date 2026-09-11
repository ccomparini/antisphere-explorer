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

  // 0 is reserved: "no child at all" (see antisphere-scene.js's flatten()).
  // It means something different on each side, matching what an
  // unspecified "inside"/"outside" already defaulted to before this was a
  // node concept at all: outside, it's unconditionally void; inside, it
  // means "no further carving - this whole region uses this node's own
  // material" (materials[material].solid decides whether that's actually
  // solid; see trace()).
  inside         : u32,         // index of inside child or 0u -> no child
  outside        : u32,         // same but outside

  // "material" describes what's inside the node: an index into the
  // materials table (0 is vacuum), read directly wherever this node is
  // the surface a ray actually crossed - there is no ancestor-scope
  // fallback anymore, so a node that wants to be visible names its own
  // material. It may be solid, or some modifier to how a region is
  // rendered (including light effects or things like haze), or even just
  // empty space, which is useful if you want to use nodes to subdivide
  // space for scoping other things (say, collisions).
  material       : i32,

  // Ambient environment in force at this node: an index into the
  // materials table (0 is the default ambient), read directly wherever
  // this node is the surface a ray actually crossed. Already fully
  // resolved by antisphere-scene.js's bakeEnv() at compile time - baked
  // ancestor-scope inheritance, the same way material has no ancestor-
  // scope fallback of its own - so there is nothing left for trace() to
  // thread through the traversal at render time.
  env            : i32,
};

struct Material {
  kind    : u32,       // selects the shading function
  pattern : u32,       // albedo modulation, independent of kind
  params  : vec2<f32>, // kind-specific
  albedo  : vec3<f32>,
  scale   : f32,
  albedo2 : vec3<f32>,
  solid   : u32,       // 0 or 1; read by trace() for a node's default "inside"
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
// trace() returns a Seg too, reusing it as the hit result rather than a
// separate Hit type: t0 < 0 means no hit (the same "miss is negative"
// convention traceFrom() already hands back to its callers), node is the
// node whose surface was hit (never tagged - see trace()), and t1 is the
// far bound of the hit region: the full extent of the continuous solid
// run, not just its nearest sub-piece, which is there for transparency or
// refraction to reach for later without another struct change.
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

    // Push far to near so the nearest subsegment pops first.
    for (var i : i32 = nb - 1; i >= 0; i = i - 1) {
      let sa = b[i];
      let sb = b[i + 1];
      if (sb - sa <= 1e-6 || sp >= 32) { continue; }
      // Midpoint sign picks the child. Robust, and avoids reasoning about
      // which root is an entry and which is an exit.
      var child = nd.outside;
      if (fAt(nd, O + 0.5 * (sa + sb) * D) < 0.0) {
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
  // trace()'s own miss convention (t0 < 0) already matches this buffer's,
  // so the result needs no translation.
  rayResults[i] = trace(q.o, q.d, q.tMin, q.tMax).t0;
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
      if (trace(shadowOrigin, L, bias, dist - bias).t0 >= 0.0) { continue; }
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
  var h = Seg(0u, -1.0, 0.0);   // t0 < 0: no hit
  if (cam.ablate >= ABLATE_TRACE) {
    h = trace(cam.origin, dir, 1e-3, 1e4);
  }

  var col = vec3<f32>(0.0);
  var N = vec3<f32>(0.0);
  if (cam.ablate < ABLATE_TRACE) {
    col = abs(dir) * 0.25;
  } else if (cam.ablate < ABLATE_SHADE) {
    col = select(vec3<f32>(0.0), vec3<f32>(fract(h.t0 * 0.05)), h.t0 >= 0.0);
  } else if (h.t0 >= 0.0) {
    // h.node is always a real node here - no more "camera started inside
    // solid, no boundary to shade from" case (see trace()'s doc comment on
    // Seg): a node's default inside is now a legitimate hit in its own
    // right, resolved from that node's own material either way.
    let nd = nodes[h.node];
    var s : Surf;
    s.P = cam.origin + h.t0 * dir;
    s.N = normalize(gradAt(nd, s.P));
    if (dot(s.N, dir) > 0.0) { s.N = -s.N; }   // face the ray
    s.V = -dir;
    s.m = materials[nd.material];
    s.st = frame(nd, s.P) * s.m.scale;
    s.env = nd.env;
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
