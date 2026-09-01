// Antisphere ray caster.
//
// An antisphere is five numbers, (n.xyz, a, k): the unit normal at the near
// diametric point, the signed distance from the origin to that point, and the
// signed curvature k = 1/(a+b) = 1/(2r). Planes are k = 0. Negating all five
// gives the exact complement.
//
// Traversal is a solid BSP walk where each node splits the ray at up to two
// points instead of one. Bindings, in order: camera, nodes, output image,
// lights, materials.

struct Node {
  n       : vec3<f32>,
  a       : f32,
  k       : f32,
  inside  : i32,
  outside : i32,
  paint   : i32,   // >= 0 sets scope (0 clears it); negative leaves it alone
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
  shadows : f32,
  fwd     : vec3<f32>,
  debug   : f32,   // 0 = shaded, otherwise a DEBUG_ view
  ablate  : f32,   // ABLATE_ level, for the profiler's ablation ladder
  pad3    : f32,
  pad4    : f32,
  pad5    : f32,
};

// Rungs of the ablation ladder. Each level adds one stage back, and the
// differences between consecutive pass times give the stage costs. Shadow
// rays are the level above this, driven by Camera.shadows.
const ABLATE_NONE  : f32 = 0.0;   // dispatch and ray setup only
const ABLATE_TRACE : f32 = 1.0;   // add traversal, no shading
const ABLATE_SHADE : f32 = 2.0;   // add shading

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
  return nd.k * dot(R, R)
       + (1.0 - 2.0 * nd.a * nd.k) * dot(R, nd.n)
       - nd.a + nd.k * nd.a * nd.a;
}

// grad f = 2kR + (1 - 2ak)n. Reduces to n exactly when k = 0.
fn gradAt(nd : Node, R : vec3<f32>) -> vec3<f32> {
  return 2.0 * nd.k * R + (1.0 - 2.0 * nd.a * nd.k) * nd.n;
}

struct Seg { node : i32, t0 : f32, t1 : f32, entry : i32, scope : i32, };
struct Hit { hit : bool, t : f32, node : i32, mat : i32, };

fn trace(O : vec3<f32>, D : vec3<f32>, tMin : f32, tMax : f32) -> Hit {
  var hit : Hit;
  hit.hit = false;
  hit.t = tMax;
  hit.node = -1;
  hit.mat = 0;

  var stack : array<Seg, 32>;
  stack[0] = Seg(0, tMin, tMax, -1, 0);
  var sp : i32 = 1;

  var guard : i32 = 0;
  while (sp > 0) {
    guard = guard + 1;
    if (guard > 512) { break; }

    sp = sp - 1;
    let seg = stack[sp];
    if (seg.t1 - seg.t0 <= 1e-6) { continue; }

    if (seg.node < 0) {
      // Leaf. Its substrate is (-1 - node), and 0 is vacuum.
      let substrate = -1 - seg.node;
      if (substrate == 0) { continue; }
      // Front-to-back ordering means the first solid leaf popped is nearest.
      // Paint in scope wins over the substrate.
      hit.hit = true;
      hit.t = seg.t0;
      hit.node = seg.entry;
      hit.mat = select(substrate, seg.scope, seg.scope > 0);
      break;
    }

    let nd = nodes[seg.node];
    visits = visits + 1u;

    // Substituting R = O + tD gives A t^2 + B t + C, with A = k.
    // A plane is the quadratic degenerating to linear, no special case.
    let lin = 1.0 - 2.0 * nd.a * nd.k;
    let A = nd.k;
    let B = 2.0 * nd.k * dot(O, D) + lin * dot(D, nd.n);
    let C = fAt(nd, O);

    var r0 = 0.0;
    var r1 = 0.0;
    var nr : i32 = 0;
    if (A == 0.0) {
      if (abs(B) > 1e-20) {
        r0 = -C / B;
        nr = 1;
      }
    } else {
      let disc = B * B - 4.0 * A * C;
      if (disc >= 0.0) {
        let s = sqrt(disc);
        var q = -0.5 * (B + s);
        if (B < 0.0) { q = -0.5 * (B - s); }
        let x0 = q / A;
        var x1 = -B / A - x0;
        if (abs(q) > 1e-20) { x1 = C / q; }
        r0 = min(x0, x1);
        r1 = max(x0, x1);
        nr = 2;
      }
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
      var childScope = seg.scope;
      if (fAt(nd, O + 0.5 * (sa + sb) * D) < 0.0) {
        child = nd.inside;
        // Paint scopes the region f < 0 and nothing else. To scope the far
        // side instead, flip the node: negating all five numbers is free, so
        // the representation pays for this rule rather than the traversal.
        if (nd.paint >= 0) { childScope = nd.paint; }
      }
      var ent = seg.entry;
      if (i > 0) { ent = seg.node; }
      stack[sp] = Seg(child, sa, sb, ent, childScope);
      sp = sp + 1;
      peakDepth = max(peakDepth, u32(sp));
    }
  }
  return hit;
}

// Surface parameterization from the node's own five numbers. A plane gets a
// tangent basis; a sphere gets longitude and latitude about its center.
fn frame(nd : Node, P : vec3<f32>) -> vec2<f32> {
  if (nd.k == 0.0) {
    var axis = vec3<f32>(0.0, 0.0, 1.0);
    if (abs(nd.n.z) > 0.9) { axis = vec3<f32>(1.0, 0.0, 0.0); }
    let t = normalize(cross(nd.n, axis));
    let b = cross(nd.n, t);
    return vec2<f32>(dot(P, t), dot(P, b));
  }
  let c = (nd.a - 0.5 / nd.k) * nd.n;
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

fn ambient(N : vec3<f32>) -> f32 {
  return 0.10 + 0.08 * max(N.z, 0.0);
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

    if (cam.shadows > 0.5) {
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
  return albedoAt(s) * (ambient(s.N) + d.diffuse);
}

// params.x shininess, params.y specular strength
fn shadeGlossy(s : Surf) -> vec3<f32> {
  let d = directLighting(s, max(s.m.params.x, 1.0));
  return albedoAt(s) * (ambient(s.N) + d.diffuse) + d.specular * s.m.params.y;
}

// params.x emission strength, added on top of ordinary diffuse response
fn shadeEmissive(s : Surf) -> vec3<f32> {
  let d = directLighting(s, 0.0);
  let alb = albedoAt(s);
  return alb * (ambient(s.N) + d.diffuse) + alb * s.m.params.x;
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

  var col = vec3<f32>(0.0);   // the shell should catch every ray; black means a bug
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
      N = s.N;
      col = shade(s);
    }
  }

  let mode = u32(cam.debug + 0.5);
  var outCol = pow(col, vec3<f32>(1.0 / 2.2));
  switch (mode) {
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
