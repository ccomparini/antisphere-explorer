// Tests for the STL reader. Run with:
//   node --test stl.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSTL, writeSTL, countOpenEdges } from './stl.js';

const tetrahedron = [
  [[0,0,0],[0,1,0],[1,0,0]], [[0,0,0],[0,0,1],[0,1,0]],
  [[0,0,0],[1,0,0],[0,0,1]], [[1,0,0],[0,1,0],[0,0,1]],
];

const asciiOf = (triangles) => 'solid test\n' + triangles.map((tri) =>
  'facet normal 0 0 0\n outer loop\n' + tri.map((v) => `  vertex ${v.join(' ')}`).join('\n') +
  '\n endloop\nendfacet').join('\n') + '\nendsolid test\n';

test('binary round-trips', () => {
  const read = readSTL(writeSTL(tetrahedron));
  assert.equal(read.triangles.length, 4);
  assert.equal(read.degenerate, 0);
  assert.equal(read.openEdges, 0, 'a tetrahedron is closed');
  read.triangles.forEach((tri, i) => tri.forEach((v, j) =>
    v.forEach((x, k) => assert.ok(Math.abs(x - tetrahedron[i][j][k]) < 1e-6))));
});

test('ascii reads the same', () => {
  const read = readSTL(asciiOf(tetrahedron));
  assert.equal(read.triangles.length, 4);
  assert.equal(read.openEdges, 0);
});

test('a binary file whose header starts with "solid" is still binary', () => {
  // The trap in every STL reader: the format is told apart by length, not
  // by the first word, because a binary header is free text.
  const read = readSTL(writeSTL(tetrahedron, 'solid something exported this'));
  assert.equal(read.triangles.length, 4);
});

test('facets with no area are dropped, and counted', () => {
  const read = readSTL(asciiOf([...tetrahedron, [[0,0,0],[1,0,0],[2,0,0]]]));
  assert.equal(read.triangles.length, 4);
  assert.equal(read.degenerate, 1);
});

test('a winding that disagrees with its stated normal is turned round', () => {
  // One facet wound backwards, with the normal still stating the truth.
  const buffer = writeSTL(tetrahedron);
  const view = new DataView(buffer);
  const at = 84 + 3 * 50;                    // the fourth facet's vertices
  const swap = (a, b) => {
    for (let k = 0; k < 3; k++) {
      const x = view.getFloat32(at + (a + k) * 4, true);
      view.setFloat32(at + (a + k) * 4, view.getFloat32(at + (b + k) * 4, true), true);
      view.setFloat32(at + (b + k) * 4, x, true);
    }
  };
  swap(3, 6);                                 // vertices 0 and 1, normal untouched
  const read = readSTL(buffer);
  assert.equal(read.flipped, 1, 'the reader noticed');
  assert.equal(read.openEdges, 0, 'and the surface is consistent again');
});

test('an open surface is reported rather than patched', () => {
  const read = readSTL(writeSTL(tetrahedron.slice(0, 3)));   // a face missing
  assert.ok(read.openEdges > 0, 'three sides of a tetrahedron leave a hole');
});

test('countOpenEdges matches vertices that were written separately', () => {
  // STL repeats every corner per facet, so the same point arrives as three
  // slightly different numbers; matching has to tolerate that.
  const jittered = tetrahedron.map((tri) =>
    tri.map((v) => v.map((x) => x + (Math.random() - 0.5) * 1e-9)));
  assert.equal(countOpenEdges(jittered), 0);
});
