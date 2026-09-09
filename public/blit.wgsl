// Full-screen triangle that copies the compute shader's storage texture to
// the swap chain. Needed because writing straight to the canvas texture
// requires the bgra8unorm-storage feature, which is not universal.
//
// The source texture may be a different resolution from the swap chain (the
// render target can be scaled independently of the canvas to trade quality
// for speed), so this samples rather than loads, scaling to fit.

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex fn vs(@builtin(vertex_index) i : u32) -> VOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out : VOut;
  out.pos = vec4<f32>(p[i], 0.0, 1.0);
  // Clip space y+ is up; texture v grows downward, hence the flip.
  out.uv = p[i] * vec2<f32>(0.5, -0.5) + 0.5;
  return out;
}

@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var samp : sampler;

@fragment fn fs(in : VOut) -> @location(0) vec4<f32> {
  return textureSample(src, samp, in.uv);
}
