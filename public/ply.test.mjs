// Tests for PLY reading. Run with:
//   node --test ply.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPLY } from './ply.js';

// A tetrahedron, wound outward.
const VERTICES = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
const FACES = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];

const ascii = (faces = FACES, vertices = VERTICES) => new TextEncoder().encode(`ply
format ascii 1.0
comment made by hand
element vertex ${vertices.length}
property float x
property float y
property float z
element face ${faces.length}
property list uchar int vertex_indices
end_header
${vertices.map((v) => v.join(' ')).join('\n')}
${faces.map((f) => `${f.length} ${f.join(' ')}`).join('\n')}
`);

/**
 * A binary PLY, `little` endian or not, with properties to read past: a
 * normal and a colour before x, y and z, a confidence after, and an element
 * of its own between the vertices and the faces.
 */
function binary(little) {
  const order = little ? 'binary_little_endian' : 'binary_big_endian';
  const header = new TextEncoder().encode(`ply
format ${order} 1.0
element vertex ${VERTICES.length}
property float nx
property uchar red
property double x
property double y
property double z
property float confidence
element note 2
property list uchar short values
element face ${FACES.length}
property uchar flags
property list uchar uint vertex_indices
end_header
`);
  const body = [];
  const put = (size, write) => { const b = new DataView(new ArrayBuffer(size)); write(b); body.push(new Uint8Array(b.buffer)); };
  for (const [x, y, z] of VERTICES) {
    put(4, (b) => b.setFloat32(0, 0.5, little));
    put(1, (b) => b.setUint8(0, 200));
    for (const c of [x, y, z]) put(8, (b) => b.setFloat64(0, c, little));
    put(4, (b) => b.setFloat32(0, 1, little));
  }
  for (const values of [[1, -2, 3], []]) {
    put(1, (b) => b.setUint8(0, values.length));
    for (const v of values) put(2, (b) => b.setInt16(0, v, little));
  }
  for (const face of FACES) {
    put(1, (b) => b.setUint8(0, 7));
    put(1, (b) => b.setUint8(0, face.length));
    for (const i of face) put(4, (b) => b.setUint32(0, i, little));
  }
  const out = new Uint8Array(header.length + body.reduce((n, b) => n + b.length, 0));
  out.set(header);
  let at = header.length;
  for (const b of body) { out.set(b, at); at += b.length; }
  return out;
}

const signedVolume = (triangles) => triangles.reduce((sum, [a, b, c]) =>
  sum + (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6, 0);

test('an ascii PLY: its faces as triangles, closed and outward', () => {
  const read = readPLY(ascii());
  assert.deepEqual(read.triangles, FACES.map((f) => f.map((i) => VERTICES[i])));
  assert.equal(read.openEdges, 0);
  assert.equal(read.flipped, 0);
  assert.ok(Math.abs(signedVolume(read.triangles) - 1 / 6) < 1e-12);
});

test('binary, either byte order, reading past properties and elements it does not use', () => {
  for (const little of [true, false]) {
    const read = readPLY(binary(little));
    assert.deepEqual(read.triangles, FACES.map((f) => f.map((i) => VERTICES[i])), little ? 'little' : 'big');
  }
});

test('polygons fanned, inward winding turned round, faces with no area dropped', () => {
  // A unit square, as one quad, both ways round, and a sliver of no area.
  const square = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [2, 0, 0]];
  const quad = readPLY(ascii([[0, 1, 2, 3]], square));
  assert.deepEqual(quad.triangles, [[square[0], square[1], square[2]], [square[0], square[2], square[3]]]);
  const inward = readPLY(ascii(FACES.map((f) => [...f].reverse())));
  assert.equal(inward.flipped, 4);
  assert.ok(signedVolume(inward.triangles) > 0, 'wound outward again');
  const flat = readPLY(ascii([[0, 1, 4]], square));
  assert.equal(flat.degenerate, 1);
  assert.equal(flat.triangles.length, 0);
});

test('what it cannot read, it says', () => {
  assert.throws(() => readPLY(new TextEncoder().encode('solid x\nendsolid')), /not a PLY/);
  const text = new TextDecoder().decode(ascii());
  assert.throws(() => readPLY(new TextEncoder().encode(text.replace('ascii', 'binary_middle_endian'))), /binary_middle_endian/);
  assert.throws(() => readPLY(new TextEncoder().encode(text.replace('property float z', 'property float w'))), /lack x, y or z/);
  assert.throws(() => readPLY(new TextEncoder().encode(text.replace('element face 4', 'element face 9'))), /ends before/);
  assert.throws(() => readPLY(new TextEncoder().encode(text.replace('3 1 2 3', '3 1 2 7'))), /names vertex 7, of 4/);
  const whole = binary(true);
  assert.throws(() => readPLY(whole.subarray(0, whole.length - 3)), /ends before/);
});
