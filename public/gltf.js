// A reader for glTF 2.0 (https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html):
// a .glb, or a .gltf with its buffers in data: URIs or files beside it.
//
// It reads what a model needs - the node hierarchy, skins, mesh
// attributes and animations - and nothing it can't read correctly: an
// extension the file requires, or a sparse accessor, is refused rather
// than half read. Materials, textures and cameras are left in `json` for
// whoever wants them.
//
//   const gltf = await readGLTF(bytes, { readBytes, base });
//   gltf.json                    the file's JSON
//   gltf.accessor(i)             accessor i's values: a flat Float32Array (or
//                                integer array), with .size per element
//   gltf.parents[i]              node i's parent, or -1
//   gltf.rest(i)                 node i's own { translation, rotation, scale }
//   gltf.worldMatrices(trs)      every node's world matrix, from each node's
//                                TRS (trs(i), default its rest)
//   trianglesOf(gltf)            every triangle of its default scene, at rest
//   sample(gltf, animation, t)   the animated nodes' TRS at time t
//   trackOf(gltf, sampler)       a channel's keys as a track (keyframes.js)
//   clipRange(gltf, animation)   [start, end] of its keys
//
// Matrices are glTF's: 4x4, column-major, in a Float64Array(16).
// Quaternions are [x, y, z, w].

import { sampleTrack } from './keyframes.js';

const GLB_MAGIC = 0x46546c67;          // "glTF"
const CHUNK_JSON = 0x4e4f534a;         // "JSON"
const CHUNK_BIN = 0x004e4942;          // "BIN\0"

const COMPONENTS = {
  5120: { array: Int8Array, max: 127 },
  5121: { array: Uint8Array, max: 255 },
  5122: { array: Int16Array, max: 32767 },
  5123: { array: Uint16Array, max: 65535 },
  5125: { array: Uint32Array, max: 4294967295 },
  5126: { array: Float32Array, max: 1 },
};
const SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

const bytesOf = (data) => (data instanceof Uint8Array ? data : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength));

/**
 * Parse a .glb (bytes starting "glTF") or a .gltf (its JSON, as text or
 * bytes). `readBytes(path)` fetches a buffer the file names by URI,
 * resolved against `base` (the file's own path, or a directory ending /);
 * only a .gltf with sidecar buffers needs it.
 */
export async function readGLTF(data, { readBytes, base = '' } = {}) {
  let json, bin = null;
  const bytes = typeof data === 'string' ? null : bytesOf(data);
  if (bytes && bytes.length >= 12 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === GLB_MAGIC) {
    ({ json, bin } = readGLB(bytes));
  } else {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(bytes);
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(`glTF: neither a .glb (no "glTF" magic) nor .gltf JSON: ${e.message}`);
    }
  }
  const version = String(json.asset?.version ?? '');
  if (!version.startsWith('2.')) throw new Error(`glTF: version ${version || '(none)'}; only 2.x is read`);
  if (json.extensionsRequired?.length) {
    throw new Error(`glTF: requires extensions this reader lacks: ${json.extensionsRequired.join(', ')}`);
  }

  const buffers = await Promise.all((json.buffers ?? []).map(async (buffer, i) => {
    if (buffer.uri === undefined) {
      if (i !== 0 || !bin) throw new Error(`glTF: buffer ${i} has no uri, and isn't a .glb's BIN chunk`);
      return bin;
    }
    if (buffer.uri.startsWith('data:')) return dataURI(buffer.uri);
    if (!readBytes) throw new Error(`glTF: buffer ${i} is a file, ${buffer.uri}; give readBytes to read it`);
    const dir = base.endsWith('/') ? base : base.slice(0, base.lastIndexOf('/') + 1);
    return bytesOf(await readBytes(dir + decodeURIComponent(buffer.uri)));
  }));

  return new GLTF(json, buffers);
}

function readGLB(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true), length = view.getUint32(8, true);
  if (version !== 2) throw new Error(`glTF: a version ${version} .glb; only 2 is read`);
  if (length > bytes.length) throw new Error(`glTF: the .glb says it is ${length} bytes, but is ${bytes.length}`);
  let json = null, bin = null;
  for (let at = 12; at + 8 <= length;) {
    const size = view.getUint32(at, true), type = view.getUint32(at + 4, true);
    const chunk = bytes.subarray(at + 8, at + 8 + size);
    if (type === CHUNK_JSON && !json) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === CHUNK_BIN && !bin) bin = chunk;
    at += 8 + size;                                      // other chunk types: skipped, as the spec says
  }
  if (!json) throw new Error('glTF: a .glb with no JSON chunk');
  return { json, bin };
}

function dataURI(uri) {
  const comma = uri.indexOf(',');
  if (!/;base64$/.test(uri.slice(0, comma))) throw new Error('glTF: only base64 data: URIs are read');
  const text = atob(uri.slice(comma + 1));
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

class GLTF {
  constructor(json, buffers) {
    this.json = json;
    this.buffers = buffers;
    this.nodes = json.nodes ?? [];
    this.parents = this.nodes.map(() => -1);
    this.nodes.forEach((node, i) => (node.children ?? []).forEach((c) => { this.parents[c] = i; }));
    this.cache = new Map();
  }

  /**
   * Accessor i's values, flat: element k's components are at
   * [k * size, (k + 1) * size). Floats as Float32Array; integers as their
   * own typed array, or, `normalized`, as floats in [0, 1] ([-1, 1] signed).
   * The result is shared: don't change it.
   */
  accessor(i) {
    if (this.cache.has(i)) return this.cache.get(i);
    const a = this.json.accessors?.[i];
    if (!a) throw new Error(`glTF: no accessor ${i}`);
    if (a.sparse) throw new Error(`glTF: accessor ${i} is sparse, which this reader doesn't read`);
    const component = COMPONENTS[a.componentType], size = SIZES[a.type];
    if (!component || !size) throw new Error(`glTF: accessor ${i}: componentType ${a.componentType}, type ${a.type}`);
    const Array_ = component.array, width = Array_.BYTES_PER_ELEMENT;
    let out = new Array_(a.count * size);              // no bufferView: zeros, as the spec says
    if (a.bufferView !== undefined) {
      const view = this.json.bufferViews[a.bufferView];
      const bytes = this.buffers[view.buffer];
      const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
      const stride = view.byteStride ?? size * width;
      const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const get = { 1: Array_ === Int8Array ? 'getInt8' : 'getUint8',
                    2: Array_ === Int16Array ? 'getInt16' : 'getUint16',
                    4: Array_ === Float32Array ? 'getFloat32' : 'getUint32' }[width];
      if (start + (a.count - 1) * stride + size * width > bytes.length) throw new Error(`glTF: accessor ${i} runs past its buffer`);
      for (let k = 0; k < a.count; k++) {
        for (let c = 0; c < size; c++) out[k * size + c] = data[get](start + k * stride + c * width, true);
      }
    }
    if (a.normalized && Array_ !== Float32Array) {
      out = Float32Array.from(out, (v) => Math.max(v / component.max, -1));
    }
    out.size = size;
    this.cache.set(i, out);
    return out;
  }

  /** Node i's own transform: { translation, rotation, scale }, from its TRS or its matrix. */
  rest(i) {
    const n = this.nodes[i];
    if (n.matrix) return decompose(n.matrix);
    return {
      translation: n.translation ?? [0, 0, 0],
      rotation: n.rotation ?? [0, 0, 0, 1],
      scale: n.scale ?? [1, 1, 1],
    };
  }

  /** Every node's world matrix, each node's own transform given by trs(i) (default its rest). */
  worldMatrices(trs = (i) => this.rest(i)) {
    const world = new Array(this.nodes.length);
    const visit = (i) => {
      if (world[i]) return world[i];
      const local = compose(trs(i));
      return (world[i] = this.parents[i] < 0 ? local : multiply(visit(this.parents[i]), local));
    };
    this.nodes.forEach((_, i) => visit(i));
    return world;
  }
}

// -- animation -------------------------------------------------------------------

/** The time range of an animation's keys: [start, end]. */
export function clipRange(gltf, animation) {
  let start = Infinity, end = -Infinity;
  for (const sampler of animation.samplers) {
    const times = gltf.accessor(sampler.input);
    start = Math.min(start, times[0]);
    end = Math.max(end, times[times.length - 1]);
  }
  return [start, end];
}

/**
 * A channel's keys as a track (keyframes.js): { times, values,
 * interpolation }, values one vector per key - for CUBICSPLINE each
 * [in-tangent, value, out-tangent]. Cached on the sampler: don't change it.
 */
export function trackOf(gltf, sampler) {
  if (gltf.tracks?.has(sampler)) return gltf.tracks.get(sampler);
  const times = Array.from(gltf.accessor(sampler.input));
  const flat = gltf.accessor(sampler.output);
  const mode = sampler.interpolation ?? 'LINEAR';
  const per = mode === 'CUBICSPLINE' ? 3 : 1, size = flat.length / times.length / per;
  const vec = (i) => Array.from(flat.subarray(i * size, (i + 1) * size));
  const values = times.map((_, k) => (per === 3 ? [vec(3 * k), vec(3 * k + 1), vec(3 * k + 2)] : vec(k)));
  const track = { times, values, interpolation: { LINEAR: 'linear', STEP: 'step', CUBICSPLINE: 'cubic' }[mode] ?? 'linear' };
  (gltf.tracks ??= new Map()).set(sampler, track);
  return track;
}

/**
 * The TRS, at time t, of every node an animation moves: a Map from node
 * index to { translation, rotation, scale }, each path the animation
 * doesn't drive left at the node's rest. t is clamped to each channel's
 * keys. Morph target weights are ignored.
 */
export function sample(gltf, animation, t) {
  const out = new Map();
  for (const channel of animation.channels) {
    const { node, path } = channel.target;
    if (node === undefined || !['translation', 'rotation', 'scale'].includes(path)) continue;
    if (!out.has(node)) out.set(node, { ...gltf.rest(node) });
    out.get(node)[path] = sampleTrack(trackOf(gltf, animation.samplers[channel.sampler]), t, { rotation: path === 'rotation' });
  }
  return out;
}

// -- geometry ---------------------------------------------------------------------

/**
 * Every triangle of the file's default scene, at rest, in its own
 * coordinates (glTF's: y up, metres): { triangles: [[p, p, p], ...],
 * skipped }, skipped counting the primitives that aren't triangles (points,
 * lines, strips, fans). Each mesh comes once for each node using it, placed
 * by that node's world matrix; a skinned mesh as its skin holds it at rest,
 * each vertex the weighted sum of what its joints make of it - a joint's
 * world matrix after its inverse bind matrix - as a viewer would show it.
 */
export function trianglesOf(gltf) {
  const json = gltf.json;
  const world = gltf.worldMatrices();
  // The default scene's nodes: json.scene's, else the first scene's, else
  // every node with no parent.
  const scene = json.scenes?.[json.scene ?? 0];
  const roots = scene?.nodes ?? gltf.nodes.map((_, i) => i).filter((i) => gltf.parents[i] < 0);
  const nodes = [];
  const walk = (i) => { nodes.push(i); for (const c of gltf.nodes[i].children ?? []) walk(c); };
  roots.forEach(walk);

  const triangles = [];
  let skipped = 0;
  for (const n of nodes) {
    const node = gltf.nodes[n];
    if (node.mesh === undefined) continue;
    const skin = node.skin === undefined ? null : json.skins?.[node.skin];
    let joints = null;
    if (skin) {
      const ibm = skin.inverseBindMatrices === undefined ? null : gltf.accessor(skin.inverseBindMatrices);
      joints = skin.joints.map((j, k) => (ibm ? multiply(world[j], ibm.subarray(16 * k, 16 * k + 16)) : world[j]));
    }
    for (const prim of json.meshes[node.mesh].primitives) {
      if ((prim.mode ?? 4) !== 4 || prim.attributes.POSITION === undefined) { skipped++; continue; }
      const pos = gltf.accessor(prim.attributes.POSITION);
      const count = pos.length / 3;
      const js = joints && prim.attributes.JOINTS_0 !== undefined ? gltf.accessor(prim.attributes.JOINTS_0) : null;
      const ws = js && prim.attributes.WEIGHTS_0 !== undefined ? gltf.accessor(prim.attributes.WEIGHTS_0) : null;
      const points = new Array(count);
      for (let v = 0; v < count; v++) {
        const p = [pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]];
        let at = null, total = 0;
        if (ws) {
          at = [0, 0, 0];
          for (let c = 0; c < 4; c++) {
            const w = ws[4 * v + c], joint = joints[js[4 * v + c]];
            if (!(w > 0) || !joint) continue;
            total += w;
            transformPoint(joint, p).forEach((x, i) => { at[i] += x * w; });
          }
        }
        points[v] = total > 0 ? at.map((x) => x / total) : transformPoint(world[n], p);
      }
      const order = prim.indices === undefined ? null : gltf.accessor(prim.indices);
      const corners = order ? order.length : count;
      for (let i = 0; i + 2 < corners; i += 3) {
        const [a, b, c] = order ? [order[i], order[i + 1], order[i + 2]] : [i, i + 1, i + 2];
        triangles.push([points[a], points[b], points[c]]);
      }
    }
  }
  return { triangles, skipped };
}

// -- maths -------------------------------------------------------------------------

const normalize4 = (q) => { const l = Math.hypot(...q) || 1; return q.map((v) => v / l); };

/** The matrix of a TRS: translate * rotate * scale. */
export function compose({ translation: [tx, ty, tz] = [0, 0, 0], rotation: [x, y, z, w] = [0, 0, 0, 1], scale: [sx, sy, sz] = [1, 1, 1] }) {
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * sx; m[1] = 2 * (x * y + z * w) * sx;       m[2] = 2 * (x * z - y * w) * sx;
  m[4] = 2 * (x * y - z * w) * sy;       m[5] = (1 - 2 * (x * x + z * z)) * sy; m[6] = 2 * (y * z + x * w) * sy;
  m[8] = 2 * (x * z + y * w) * sz;       m[9] = 2 * (y * z - x * w) * sz;       m[10] = (1 - 2 * (x * x + y * y)) * sz;
  m[12] = tx; m[13] = ty; m[14] = tz; m[15] = 1;
  return m;
}

/** a * b, column-major. */
export function multiply(a, b) {
  const m = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      m[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return m;
}

/** m applied to point p. */
export const transformPoint = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

/** m applied to direction d (no translation). */
export const transformDirection = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z,
  m[1] * x + m[5] * y + m[9] * z,
  m[2] * x + m[6] * y + m[10] * z,
];

/** A matrix without shear, back to TRS. */
export function decompose(m) {
  const col = (c) => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
  const scale = [0, 1, 2].map((c) => Math.hypot(...col(c)));
  const [r0, r1, r2] = [0, 1, 2].map((c) => col(c).map((v) => v / scale[c]));
  // The rotation matrix's columns r0, r1, r2, to a quaternion (Shepperd's method).
  const [m00, m10, m20] = r0, [m01, m11, m21] = r1, [m02, m12, m22] = r2;
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) {
    const s = 2 * Math.sqrt(tr + 1);
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  return { translation: [m[12], m[13], m[14]], rotation: normalize4(q), scale };
}
