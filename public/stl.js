// ---------------------------------------------------------------------------
// STL
//
// Both flavours, since files arrive as whichever the exporter felt like.
//
// STL says almost nothing: a heap of triangles with no shared vertices, no
// topology, and a stored normal per facet that many exporters leave as
// zeroes or get backwards. So the normal is taken from the winding, and the
// stored one is used only to decide which way round the winding should have
// been - the disagreement is common enough to be worth repairing rather
// than refusing.
//
// What no reader can repair is a mesh that isn't closed. A converted tree
// treats "behind every face" as inside, which means something only if the
// surface separates an inside from an outside. Holes are reported rather
// than patched: an import that looks wrong should say why.
// ---------------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];

/**
 * Binary STL is 80 bytes of header, a count, then 50 bytes a facet. ASCII
 * starts with "solid" - but so does some binary, whose header is free text,
 * so the length is what actually decides.
 */
function looksBinary(bytes) {
  if (bytes.byteLength < 84) return false;
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  return bytes.byteLength === 84 + count * 50;
}

function parseBinary(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  const triangles = [], stated = [];
  for (let i = 0; i < count; i++) {
    const at = 84 + i * 50;
    const read = (k) => view.getFloat32(at + k * 4, true);
    stated.push([read(0), read(1), read(2)]);
    triangles.push([
      [read(3), read(4), read(5)],
      [read(6), read(7), read(8)],
      [read(9), read(10), read(11)],
    ]);
  }
  return { triangles, stated };
}

function parseAscii(text) {
  const triangles = [], stated = [];
  let normal = [0, 0, 0], vertices = [];
  for (const line of text.split('\n')) {
    const word = line.trim().split(/\s+/);
    if (word[0] === 'facet' && word[1] === 'normal') {
      normal = [+word[2], +word[3], +word[4]];
      vertices = [];
    } else if (word[0] === 'vertex') {
      vertices.push([+word[1], +word[2], +word[3]]);
    } else if (word[0] === 'endfacet') {
      if (vertices.length === 3) { triangles.push(vertices); stated.push(normal); }
      vertices = [];
    }
  }
  return { triangles, stated };
}

/**
 * Read an STL, as an ArrayBuffer, a Uint8Array or a string.
 *
 * Returns { triangles, degenerate, openEdges, flipped }: the triangles with
 * their winding agreed with whatever normals the file stated, how many had
 * no area, how many edges belong to one face instead of two, and how many
 * windings were turned round. An openEdges above zero means the surface
 * isn't closed, and a conversion of it will have opinions about inside that
 * the model does not support.
 */
export function readSTL(source) {
  let parsed;
  if (typeof source === 'string') {
    parsed = parseAscii(source);
  } else {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    parsed = looksBinary(bytes)
      ? parseBinary(bytes)
      : parseAscii(new TextDecoder().decode(bytes));
  }

  const triangles = [], kept = [];
  let degenerate = 0;
  parsed.triangles.forEach((tri, i) => {
    const n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
    if (Math.hypot(...n) === 0) { degenerate++; return; }
    triangles.push(tri);
    kept.push(parsed.stated[i]);
  });

  // Trust the winding, but let a stated normal overrule it where the two
  // clearly disagree: exporters get this wrong, and a single reversed facet
  // makes a hole in whatever is built from it.
  let flipped = 0;
  const oriented = triangles.map((tri, i) => {
    const n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
    const said = kept[i];
    if (said && Math.hypot(...said) > 1e-12 && dot(n, said) < 0) {
      flipped++;
      return [tri[0], tri[2], tri[1]];
    }
    return tri;
  });

  return { triangles: oriented, degenerate, flipped, openEdges: countOpenEdges(oriented) };
}

/**
 * Edges used by one face rather than two. Vertices are matched by value,
 * quantised, because STL repeats them per facet and floating point does not
 * promise that two copies of the same corner are written identically.
 */
export function countOpenEdges(triangles, tolerance = 1e-6) {
  const key = (v) => v.map((x) => Math.round(x / tolerance)).join(',');
  const edges = new Map();
  for (const tri of triangles) {
    for (let i = 0; i < 3; i++) {
      const a = key(tri[i]), b = key(tri[(i + 1) % 3]);
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(edge, (edges.get(edge) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const uses of edges.values()) if (uses !== 2) open++;
  return open;
}

/** Write triangles as a binary STL, which is what the tests read back. */
export function writeSTL(triangles, header = 'antisphere') {
  const buffer = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(buffer);
  new Uint8Array(buffer).set(new TextEncoder().encode(header.slice(0, 79)), 0);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((tri, i) => {
    const at = 84 + i * 50;
    const n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
    const len = Math.hypot(...n) || 1;
    const write = (k, value) => view.setFloat32(at + k * 4, value, true);
    n.forEach((v, k) => write(k, v / len));
    tri.forEach((v, j) => v.forEach((x, k) => write(3 + j * 3 + k, x)));
  });
  return buffer;
}
