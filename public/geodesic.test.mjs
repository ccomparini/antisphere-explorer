// Tests for geodesic.js: the lattice, and locating a direction on it. Run with:
//   node --test public/geodesic.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICO_FACES, ICO_VERTS, locate, vertexDirection, span } from './geodesic.js';

const near = (a, b, tol = 1e-12) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
let seed = 3;
const random = () => {                       // mulberry32
  seed = (seed + 0x6D2B79F5) | 0;
  let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
  return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
};
const randomDirection = () => { const z = 2 * random() - 1, a = 2 * Math.PI * random(), r = Math.sqrt(1 - z * z); return [r * Math.cos(a), r * Math.sin(a), z]; };

test('a vertex shared by two faces has one direction from either: edges and corners agree', () => {
  const level = 3, n = span(level);
  // Every face's corners are the icosahedron's own vertices.
  ICO_FACES.forEach((corners, f) => {
    assert.ok(near(vertexDirection(f, 0, 0, level), ICO_VERTS[corners[0]]));
    assert.ok(near(vertexDirection(f, n, 0, level), ICO_VERTS[corners[1]]));
    assert.ok(near(vertexDirection(f, 0, n, level), ICO_VERTS[corners[2]]));
  });
  // Faces 0 (0, 11, 5) and 1 (0, 5, 1) share the edge 0-5: face 0's A-C
  // edge (0, j) and face 1's A-B edge (i, 0) are the same points, exactly.
  for (let k = 0; k <= n; k++) assert.deepEqual(vertexDirection(0, 0, k, level), vertexDirection(1, k, 0, level), `vertex ${k} of the edge`);
  // Every lattice vertex is a unit vector.
  for (let f = 0; f < 20; f++) for (let i = 0; i <= n; i++) for (let j = 0; i + j <= n; j++) {
    assert.ok(Math.abs(Math.hypot(...vertexDirection(f, i, j, level)) - 1) < 1e-12);
  }
});

test('locate: a leaf holding the direction, barycentrics from 0 to 1 summing to 1, mixing back to near it', () => {
  for (const level of [0, 2, 5]) {
    for (let k = 0; k < 400; k++) {
      const d = randomDirection();
      const { face, corners, directions, barycentric } = locate(d, level);
      assert.ok(Math.abs(barycentric.reduce((a, b) => a + b, 0) - 1) < 1e-12);
      assert.ok(barycentric.every((b) => b >= 0 && b <= 1), `${barycentric}`);
      // The corners are lattice vertices of that face, at those directions.
      corners.forEach(([i, j], c) => assert.ok(near(vertexDirection(face, i, j, level), directions[c], 1e-12)));
      // The barycentric mix of the corners, pushed onto the sphere, is the direction.
      const m = [0, 1, 2].map((x) => barycentric.reduce((s, b, c) => s + b * directions[c][x], 0));
      const l = Math.hypot(...m);
      assert.ok(near(m.map((v) => v / l), d, 1e-9), `level ${level}: ${m.map((v) => v / l)} against ${d}`);
    }
  }
});

test('every vertex locates to a leaf having it as a corner', () => {
  const level = 3, n = span(level);
  for (let f = 0; f < 20; f++) for (let i = 0; i <= n; i++) for (let j = 0; i + j <= n; j++) {
    const dir = vertexDirection(f, i, j, level);
    const at = locate(dir, level);
    assert.ok(at.directions.some((c) => near(c, dir, 1e-12)), `face ${f} (${i}, ${j})`);
  }
});
