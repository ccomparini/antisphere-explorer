// ---------------------------------------------------------------------------
// A quadric's implicit function and its gradient, on the compiler's prims
// ({ axis, k_par, k_perp, linear, constant }), about the world origin:
//
//   H(R) = k_perp R.R + (k_par - k_perp) (R.a)^2 + 2 c.R + d
//
// inside where H < 0, so the gradient points out. One home for every JS
// use - the compiler, tangent.js, the tests. The shader's twins are fAt()
// and gradAt() in shaders/node.wgsls, which work about each node's anchor
// on the packed form; antisphere-quadric.test.mjs keeps its own
// transcription of those, as the independent check that the two agree.
// ---------------------------------------------------------------------------

export function quadricAt({ axis: n, k_par, k_perp, linear: c, constant }, R) {
  const along = n[0] * R[0] + n[1] * R[1] + n[2] * R[2];
  return k_perp * (R[0] * R[0] + R[1] * R[1] + R[2] * R[2]) + (k_par - k_perp) * along * along +
         2 * (c[0] * R[0] + c[1] * R[1] + c[2] * R[2]) + constant;
}

export function gradientAt({ axis: n, k_par, k_perp, linear: c }, R) {
  const along = n[0] * R[0] + n[1] * R[1] + n[2] * R[2];
  return [0, 1, 2].map((i) => 2 * k_perp * R[i] + 2 * (k_par - k_perp) * along * n[i] + 2 * c[i]);
}
