// Shapes for physlab's world objects, in their own coordinates, with
// what a simulated body needs to know about them.

/**
 * The regular octahedron |x| + |y| + |z| < a: corners at distance a along
 * each axis, and eight faces, each plane square to a diagonal (±1, ±1, ±1).
 * The four faces meeting at the +Y corner come first, then the four
 * meeting at the -Y corner: planes like these, with nothing bounded among
 * them, might also serve to divide the space around the object.
 */
export function octahedron(a, material) {
  const s = 1 / Math.sqrt(3);
  const faces = [];
  for (const sy of [1, -1]) {
    for (const [sx, sz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      faces.push({ plane: { normal: [sx * s, sy * s, sz * s], offset: a * s }, material });
    }
  }
  return { intersect: faces };
}

/**
 * An octahedron's body: centre of mass at its centre, and inertia a^2 / 5
 * per unit mass about every axis through it (the mean of x^2 over it is
 * a^2 / 10), so a two-particle body along any axis holds it right. It
 * reaches a from its centre, at its corners.
 */
export function octahedronBody(a, { mass, friction = 0.5 }) {
  return { mass, centre: 0, inertia: (a * a) / 5, radius: a, friction };
}
