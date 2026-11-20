// A precompiled object: an object compiled as a "use" of it compiles it,
// its nodes stored as the compiler makes them, so a scene using it reads
// its numbers instead of compiling it again (compiled-format.md, "A
// precompiled object"). tools/precompile.mjs writes one; loadReferences()
// reads one, by its name: dragon.qssp, or dragon.qssp.gz.
//
// The file is laid out as glTF's binary form is: a header, a JSON chunk
// (the manifest), and one binary chunk.
//
//   header      "QSSP", u32 version, u32 the file's length in bytes
//   chunk       u32 length, u32 type ("JSON" or "BIN\0"), its bytes, padded
//               to 4 (the JSON with spaces, the binary with zeros)
//
// The binary chunk holds, at the offsets the manifest's "arrays" give:
//
//   surfaces    f32 x 9 per surface: axis (3), k_par, k_perp, c (3), d -
//               each surface once, the sign packSurfaces() gives it
//   nodes       i32 x 4 per node: inside and outside, each as the child's
//               index less the node's own (0: none); the surface, its
//               index + 1, negated where the node is that surface turned
//               inside out; the node's material, an index into the
//               manifest's "materials"
//   owners      u32 per node, an index into the manifest's "owners" - left
//               out where there is only one
//
// Node 1 is the object's root; there is no node 0 in the file.

const MAGIC = 0x50535351;          // "QSSP", little-endian
const VERSION = 1;
const JSON_CHUNK = 0x4e4f534a;     // "JSON"
const BIN_CHUNK = 0x004e4942;      // "BIN\0"

/** A precompiled object, as decodeQSSP() reads it. */
export class QSSPObject {
  constructor(manifest, surfaces, nodes, owners) {
    this.manifest = manifest;      // what the JSON chunk says
    this.surfaces = surfaces;      // Float32Array, 9 per surface
    this.nodes = nodes;            // Int32Array, 4 per node, node 1 first
    this.owners = owners;          // Uint32Array, 1 per node, or null: all owners[0]
  }
  get nodeCount() { return this.nodes.length / 4; }
}

const pad4 = (n) => (n + 3) & ~3;

/**
 * The bytes of a precompiled object: `manifest` (anything JSON, written as
 * given, "arrays" added), and its arrays as above - `surfaces` a
 * Float32Array, `nodes` an Int32Array, `owners` a Uint32Array or null.
 */
export function encodeQSSP({ manifest, surfaces, nodes, owners = null }) {
  const arrays = {};
  let at = 0;
  const parts = [];
  for (const [name, array] of [['surfaces', surfaces], ['nodes', nodes], ['owners', owners]]) {
    if (!array) continue;
    arrays[name] = { offset: at, length: array.length };
    parts.push([at, array]);
    at += pad4(array.byteLength);
  }
  const json = new TextEncoder().encode(JSON.stringify({ ...manifest, arrays }));
  const jsonLength = pad4(json.length), binLength = at;
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, JSON_CHUNK, true);
  out.set(json, 20);
  out.fill(0x20, 20 + json.length, 20 + jsonLength);
  const bin = 20 + jsonLength;
  view.setUint32(bin, binLength, true);
  view.setUint32(bin + 4, BIN_CHUNK, true);
  for (const [offset, array] of parts) out.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), bin + 8 + offset);
  return out;
}

/** A precompiled object from its bytes (a Uint8Array); `name` for messages. */
export function decodeQSSP(bytes, { name = 'a .qssp' } = {}) {
  const fail = (msg) => { throw new Error(`${name}: ${msg}`); };
  if (bytes.length < 28) fail('too short to be a precompiled object');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) fail('not a precompiled object (no "QSSP" at its start)');
  const version = view.getUint32(4, true);
  if (version !== VERSION) fail(`version ${version}, and only ${VERSION} is read: precompile it again (tools/precompile.mjs)`);
  if (view.getUint32(8, true) !== bytes.length) fail(`${bytes.length} bytes, but says ${view.getUint32(8, true)}: cut short?`);
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== JSON_CHUNK) fail('its first chunk is not its manifest');
  const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const bin = 20 + jsonLength;
  if (view.getUint32(bin + 4, true) !== BIN_CHUNK) fail('its second chunk is not its arrays');
  // Copied out, so each array is aligned whatever the bytes' own offset.
  const start = bytes.byteOffset + bin + 8;
  const array = (Type, entry) => {
    if (!entry) return null;
    const from = start + entry.offset;
    return new Type(bytes.buffer.slice(from, from + entry.length * Type.BYTES_PER_ELEMENT));
  };
  const { arrays = {} } = manifest;
  const object = new QSSPObject(manifest, array(Float32Array, arrays.surfaces), array(Int32Array, arrays.nodes),
                                array(Uint32Array, arrays.owners));
  if (!object.surfaces || !object.nodes) fail('has no surfaces or no nodes');
  if (object.nodes.length !== 4 * manifest.nodes) fail(`says ${manifest.nodes} nodes, but holds ${object.nodes.length / 4}`);
  return object;
}

/**
 * A surface's sign, as packSurfaces() gives it: +1 or -1, so that a surface
 * and its complement - every coefficient negated but the axis - come to
 * the same numbers once multiplied by it.
 */
export function surfaceSign({ k_par, k_perp, linear, constant }) {
  const first = [k_perp, k_par, constant, ...linear].find((v) => v !== 0) ?? 1;
  return first < 0 ? -1 : 1;
}
