// A tiny skinned, animated glTF, built in code: for the tests of gltf.js
// and tools/import-figure.mjs, not for the page.
//
// Three joints in a chain up +y, each 1 apart: j0 at the origin, j1 above
// it, j2 above that. The mesh, all one primitive, is rings of points round
// the y axis - radius 0.2 from y = 0.1 to 0.9 (on j0), from 1.1 to 1.9 (on
// j1) - and a thin tip on j2, radius 0.01 from 2.0 to 2.1. Positions are
// stored interleaved with padding (byteStride 16), weights as normalized
// bytes.
//
// One animation, "Bend", from 0 to 1 s:
//   j1 rotation, LINEAR:      identity -> 90 degrees about z
//   j0 translation, STEP:     [0, 0, 0] -> [1, 0, 0]
//   j2 translation, CUBICSPLINE: [0, 1, 0] -> [0, 2, 0], out-tangent of the
//     first key [0, 2, 0], every other tangent 0

export function fixture() {
  const rings = [[0, 0.1, 0.9, 0.2], [1, 1.1, 1.9, 0.2], [2, 2.0, 2.1, 0.01]];
  const positions = [], joints = [], weights = [];
  for (const [joint, y0, y1, r] of rings) {
    for (let i = 0; i <= 4; i++) {
      const y = y0 + (y1 - y0) * i / 4;
      for (let a = 0; a < 8; a++) {
        positions.push([r * Math.cos(a * Math.PI / 4), y, r * Math.sin(a * Math.PI / 4)]);
        joints.push([joint, 0, 0, 0]);
        weights.push([255, 0, 0, 0]);
      }
    }
  }
  const n = positions.length;
  const s = Math.SQRT1_2;
  const parts = [];                                         // [bytes, alignment]
  let offset = 0;
  const views = [];
  const add = (bytes, stride) => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { parts.push(new Uint8Array(pad)); offset += pad; }
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, ...(stride ? { byteStride: stride } : {}) });
    parts.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    offset += bytes.byteLength;
    return views.length - 1;
  };
  // Positions, interleaved: x y z and a float of padding.
  const interleaved = new Float32Array(n * 4);
  positions.forEach((p, i) => interleaved.set(p, i * 4));
  const vPos = add(interleaved, 16);
  const vJoints = add(Uint8Array.from(joints.flat()));
  const vWeights = add(Uint8Array.from(weights.flat()));
  // Inverse bind matrices: joint k at (0, k, 0), so its inverse moves by -k.
  const ibm = new Float32Array(48);
  for (let k = 0; k < 3; k++) ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -k, 0, 1], 16 * k);
  const vIbm = add(ibm);
  const vTimes = add(Float32Array.of(0, 1));
  const vRot = add(Float32Array.of(0, 0, 0, 1, 0, 0, s, s));
  const vStep = add(Float32Array.of(0, 0, 0, 1, 0, 0));
  const vCubic = add(Float32Array.of(0, 0, 0, 0, 1, 0, 0, 2, 0, /* key 2 */ 0, 0, 0, 0, 2, 0, 0, 0, 0));

  const bin = new Uint8Array(offset + ((4 - (offset % 4)) % 4));
  let at = 0;
  for (const p of parts) { bin.set(p, at); at += p.byteLength; }

  const json = {
    asset: { version: '2.0', generator: 'gltf-fixture' },
    scene: 0,
    scenes: [{ nodes: [4] }],
    nodes: [
      { name: 'j0', children: [1] },
      { name: 'j1', translation: [0, 1, 0], children: [2] },
      { name: 'j2', translation: [0, 1, 0] },
      { name: 'body', mesh: 0, skin: 0 },
      { name: 'Armature', children: [3, 0] },
    ],
    meshes: [{ name: 'body', primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 }, material: 0 }] }],
    materials: [{ name: 'M_Skin' }],
    skins: [{ joints: [0, 1, 2], inverseBindMatrices: 3 }],
    animations: [{
      name: 'Bend',
      samplers: [
        { input: 4, output: 5, interpolation: 'LINEAR' },
        { input: 4, output: 6, interpolation: 'STEP' },
        { input: 4, output: 7, interpolation: 'CUBICSPLINE' },
      ],
      channels: [
        { sampler: 0, target: { node: 1, path: 'rotation' } },
        { sampler: 1, target: { node: 0, path: 'translation' } },
        { sampler: 2, target: { node: 2, path: 'translation' } },
      ],
    }],
    accessors: [
      { bufferView: vPos, componentType: 5126, count: n, type: 'VEC3' },
      { bufferView: vJoints, componentType: 5121, count: n, type: 'VEC4' },
      { bufferView: vWeights, componentType: 5121, count: n, type: 'VEC4', normalized: true },
      { bufferView: vIbm, componentType: 5126, count: 3, type: 'MAT4' },
      { bufferView: vTimes, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: vRot, componentType: 5126, count: 2, type: 'VEC4' },
      { bufferView: vStep, componentType: 5126, count: 2, type: 'VEC3' },
      { bufferView: vCubic, componentType: 5126, count: 6, type: 'VEC3' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.byteLength }],
  };
  return { json, bin, positions };
}

/** The fixture (or any JSON and BIN) as .glb bytes. */
export function toGLB({ json, bin }) {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonBytes = new Uint8Array(text.length + ((4 - (text.length % 4)) % 4)).fill(0x20);
  jsonBytes.set(text);
  const total = 12 + 8 + jsonBytes.length + (bin ? 8 + bin.length : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true); view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  if (bin) {
    const at = 20 + jsonBytes.length;
    view.setUint32(at, bin.length, true); view.setUint32(at + 4, 0x004e4942, true);
    out.set(bin, at + 8);
  }
  return out;
}

/** The fixture as .gltf text, its buffer a base64 data: URI. */
export function toGLTFText({ json, bin }) {
  let s = '';
  for (const b of bin) s += String.fromCharCode(b);
  return JSON.stringify({ ...json, buffers: [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${btoa(s)}` }] });
}
