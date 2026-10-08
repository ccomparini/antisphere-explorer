// ---------------------------------------------------------------------------
// PLY reading (the Stanford polygon format), for mesh import.
//
// A PLY is a header naming its elements and their properties, then the
// elements themselves: in ASCII, or binary in either byte order. What is
// read here is the vertices' x, y and z, wherever they sit among the
// vertex's properties, and the faces' vertex lists, each polygon fanned into
// triangles; other properties and elements are read past.
// ---------------------------------------------------------------------------

import { countOpenEdges } from './stl.js';

// Scalar types, by every name the format allows: [size, DataView getter].
const TYPES = {
  char: [1, 'getInt8'], int8: [1, 'getInt8'],
  uchar: [1, 'getUint8'], uint8: [1, 'getUint8'],
  short: [2, 'getInt16'], int16: [2, 'getInt16'],
  ushort: [2, 'getUint16'], uint16: [2, 'getUint16'],
  int: [4, 'getInt32'], int32: [4, 'getInt32'],
  uint: [4, 'getUint32'], uint32: [4, 'getUint32'],
  float: [4, 'getFloat32'], float32: [4, 'getFloat32'],
  double: [8, 'getFloat64'], float64: [8, 'getFloat64'],
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The header: { format, elements: [{ name, count, properties }], start }, start where the data begins. */
function readHeader(bytes) {
  // The header is ASCII, ending at a line "end_header".
  const limit = Math.min(bytes.length, 1 << 20);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, limit));
  const end = head.search(/end_header\r?\n/);
  if (!head.startsWith('ply') || end < 0) throw new Error('not a PLY: no "ply" ... "end_header" header');
  const start = end + head.slice(end).indexOf('\n') + 1;
  let format = null;
  const elements = [];
  for (const line of head.slice(0, end).split(/\r?\n/)) {
    const word = line.trim().split(/\s+/);
    if (word[0] === 'format') format = word[1];
    else if (word[0] === 'element') elements.push({ name: word[1], count: Number(word[2]), properties: [] });
    else if (word[0] === 'property') {
      const element = elements[elements.length - 1];
      if (!element) throw new Error('a PLY property before any element');
      const property = word[1] === 'list'
        ? { list: true, count: word[2], type: word[3], name: word[4] }
        : { type: word[1], name: word[2] };
      for (const type of property.list ? [property.count, property.type] : [property.type]) {
        if (!TYPES[type]) throw new Error(`a PLY property of type "${type}", which isn't one`);
      }
      element.properties.push(property);
    }
  }
  if (!['ascii', 'binary_little_endian', 'binary_big_endian'].includes(format)) {
    throw new Error(`a PLY in format "${format}"; ascii, binary_little_endian or binary_big_endian are read`);
  }
  return { format, elements, start };
}

/**
 * Read a PLY, as an ArrayBuffer or a Uint8Array.
 *
 * Returns { triangles, degenerate, openEdges, flipped }, as readSTL() does:
 * the triangles, how many had no area (dropped), how many edges belong to
 * one face instead of two, and how many windings were turned round - all
 * of them, if the surface as written encloses negative volume (wound
 * inward), since a PLY states no normals to settle it face by face.
 */
export function readPLY(source) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  const { format, elements, start } = readHeader(bytes);

  // Each value in turn, whatever the format: next(type) returns one.
  let next;
  if (format === 'ascii') {
    const words = new TextDecoder().decode(bytes.subarray(start)).split(/\s+/).filter(Boolean);
    let at = 0;
    next = () => {
      if (at >= words.length) throw new Error('the PLY ends before its header says it does');
      return Number(words[at++]);
    };
  } else {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = format === 'binary_little_endian';
    let at = start;
    next = (type) => {
      const [size, get] = TYPES[type];
      if (at + size > view.byteLength) throw new Error('the PLY ends before its header says it does');
      const value = view[get](at, little);
      at += size;
      return value;
    };
  }

  const vertices = [];
  const polygons = [];
  for (const element of elements) {
    const isVertex = element.name === 'vertex';
    const isFace = element.name === 'face';
    const xyz = isVertex ? ['x', 'y', 'z'].map((axis) => element.properties.findIndex((p) => p.name === axis && !p.list)) : null;
    if (isVertex && xyz.some((i) => i < 0)) throw new Error('a PLY whose vertices lack x, y or z');
    const indices = isFace
      ? Math.max(0, element.properties.findIndex((p) => p.list && (p.name === 'vertex_indices' || p.name === 'vertex_index')))
      : -1;
    if (isFace && !element.properties[indices]?.list) throw new Error('a PLY whose faces have no vertex list');
    for (let n = 0; n < element.count; n++) {
      const values = element.properties.map((p) => {
        if (!p.list) return next(p.type);
        const count = next(p.count);
        const items = new Array(count);
        for (let k = 0; k < count; k++) items[k] = next(p.type);
        return items;
      });
      if (isVertex) vertices.push(xyz.map((i) => values[i]));
      else if (isFace) polygons.push(values[indices]);
    }
  }

  let triangles = [];
  let degenerate = 0;
  for (const polygon of polygons) {
    for (let j = 1; j + 1 < polygon.length; j++) {
      const tri = [polygon[0], polygon[j], polygon[j + 1]].map((i) => {
        const v = vertices[i];
        if (!v) throw new Error(`a PLY face names vertex ${i}, of ${vertices.length}`);
        return v;
      });
      const n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
      if (Math.hypot(...n) === 0) degenerate++;
      else triangles.push(tri);
    }
  }

  // Outward or inward as a whole: the sign of the volume it encloses.
  let volume = 0;
  for (const [a, b, c] of triangles) volume += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  let flipped = 0;
  if (volume < 0) {
    triangles = triangles.map(([a, b, c]) => [a, c, b]);
    flipped = triangles.length;
  }
  return { triangles, degenerate, flipped, openEdges: countOpenEdges(triangles) };
}
