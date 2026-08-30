// Full-screen triangle that copies the compute shader's storage texture to
// the swap chain. Needed because writing straight to the canvas texture
// requires the bgra8unorm-storage feature, which is not universal.

@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(p[i], 0.0, 1.0);
}
@group(0) @binding(0) var src : texture_2d<f32>;
@fragment fn fs(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> {
  return textureLoad(src, vec2<i32>(pos.xy), 0);
}
