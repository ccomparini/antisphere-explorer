// A glTF skin as a model wants it: its skeleton, in scene coordinates (z
// up), and its meshes' triangles at rest, each vertex with its weights.
// tools/import-model.mjs builds models from it (--skeleton); posing them by
// a clip is to come.
//
// A skeleton, as a model holds it:
//
//   { base:  { translation, rotation },     the frame the root bones stand in,
//                                           in scene coordinates
//     bones: [ { name, parent, translation, rotation }, ... ] }
//                                           parents first; each bone's rest
//                                           transform in its parent's frame
//                                           (a root's in base), quaternions
//                                           [x, y, z, w]
//
// glTF is y up and the scene z up: base carries the turn, so the bones keep
// their own frames, and clips made for them - whose roots' transforms are in
// that same frame - fit unchanged.

import { compose, multiply, decompose, transformPoint } from './gltf.js';
import { meshToTree } from './mesh-import.js';

// glTF's y up to the scene's z up: +90 degrees about x.
export const Y_UP_TO_Z_UP = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

/**
 * A glTF's skin `index`: { skeleton, joints, worldOf, primitives }.
 *
 *   skeleton     as above, every joint of the skin a bone, parents first
 *   joints       the skin's joint node indices, in skeleton order
 *   worldOf(i)   bone i's rest matrix in scene coordinates
 *   primitives   each mesh primitive the skin moves: { material (the
 *                source's name, or null), points (each vertex at rest, in
 *                scene coordinates), weights (each vertex's [[bone, weight],
 *                ...], bones by skeleton index, heaviest first), triangles
 *                ([a, b, c] vertex indices) }
 */
export function skinOf(gltf, index = 0) {
  const json = gltf.json;
  const skin = json.skins?.[index];
  if (!skin) throw new Error(`no skin ${index} (the file has ${json.skins?.length ?? 0})`);
  const isJoint = new Set(skin.joints);
  const nameOf = (node) => json.nodes[node].name ?? `joint${node}`;
  // A joint's parent joint: its nearest ancestor that is one.
  const parentNode = (node) => {
    for (let p = gltf.parents[node]; p >= 0; p = gltf.parents[p]) if (isJoint.has(p)) return p;
    return -1;
  };
  const depth = (node) => (parentNode(node) < 0 ? 0 : 1 + depth(parentNode(node)));
  const joints = [...skin.joints].sort((a, b) => depth(a) - depth(b) || skin.joints.indexOf(a) - skin.joints.indexOf(b));
  const boneOf = new Map(joints.map((node, i) => [node, i]));
  // The roots stand in whatever is above them, which must be one node; and a
  // joint must sit directly under its parent joint.
  const above = new Set(joints.filter((node) => parentNode(node) < 0).map((node) => gltf.parents[node]));
  if (above.size > 1) throw new Error('the skeleton\'s roots stand under different nodes');
  for (const node of joints) {
    if (parentNode(node) >= 0 && gltf.parents[node] !== parentNode(node)) {
      throw new Error(`joint ${nameOf(node)} has a node between it and its parent joint, which isn't supported`);
    }
  }
  const restWorld = gltf.worldMatrices();
  const [top] = above;
  const toScene = compose({ rotation: Y_UP_TO_Z_UP });
  const base = decompose(multiply(toScene, top >= 0 ? restWorld[top] : compose({})));
  const skeleton = {
    base: { translation: base.translation, rotation: base.rotation },
    bones: joints.map((node) => {
      const rest = gltf.rest(node), p = parentNode(node);
      return { name: nameOf(node), parent: p < 0 ? -1 : boneOf.get(p), translation: rest.translation, rotation: rest.rotation };
    }),
  };
  const worldOf = (i) => multiply(toScene, restWorld[joints[i]]);

  // Skinning at rest: each joint's matrix times its inverse bind matrix,
  // in scene coordinates; a vertex is the weighted sum of what they make of it.
  const ibm = skin.inverseBindMatrices === undefined ? null : gltf.accessor(skin.inverseBindMatrices);
  const skinning = skin.joints.map((node, k) =>
    multiply(worldOf(boneOf.get(node)), ibm ? ibm.subarray(16 * k, 16 * k + 16) : compose({})));
  const primitives = [];
  json.nodes.forEach((node) => {
    if (node.skin !== index || node.mesh === undefined) return;
    for (const prim of json.meshes[node.mesh].primitives) {
      const { POSITION, JOINTS_0, WEIGHTS_0 } = prim.attributes;
      if (POSITION === undefined || JOINTS_0 === undefined || WEIGHTS_0 === undefined) continue;
      if ((prim.mode ?? 4) !== 4) continue;                                    // triangles only
      const pos = gltf.accessor(POSITION), js = gltf.accessor(JOINTS_0), ws = gltf.accessor(WEIGHTS_0);
      const n = pos.length / 3;
      const points = [], weights = [];
      for (let v = 0; v < n; v++) {
        const p = [pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]];
        const w = [];
        for (let c = 0; c < 4; c++) if (ws[4 * v + c] > 0) w.push([js[4 * v + c], ws[4 * v + c]]);
        const total = w.reduce((s, [, x]) => s + x, 0) || 1;
        const at = [0, 0, 0];
        for (const [k, x] of w) transformPoint(skinning[k], p).forEach((value, i) => { at[i] += value * x / total; });
        points.push(at);
        weights.push(w.map(([k, x]) => [boneOf.get(skin.joints[k]), x / total]).sort((a, b) => b[1] - a[1]));
      }
      const order = prim.indices === undefined ? Array.from({ length: n }, (_, i) => i) : Array.from(gltf.accessor(prim.indices));
      const triangles = [];
      for (let i = 0; i + 2 < order.length; i += 3) triangles.push([order[i], order[i + 1], order[i + 2]]);
      primitives.push({ material: prim.material === undefined ? null : json.materials?.[prim.material]?.name ?? null,
                        points, weights, triangles });
    }
  });
  return { skeleton, joints, worldOf, primitives };
}

/**
 * A primitive's triangles shared among the bones: a Map from bone to its
 * triangles, as points. A triangle goes to its dominant bone - the bone
 * most of its vertices weigh most, else its first vertex's - and, given
 * `overlap`, also to any bone weighting one of its vertices at least that
 * much, so neighbouring pieces overlap round a joint.
 *
 * Everything a smarter split needs (cutting where a blend is half one bone,
 * half the next; capping what is cut) is in a primitive's weights, so it
 * would change this function and nothing that calls it.
 */
export function splitByBone({ points, weights, triangles }, { overlap = null } = {}) {
  const out = new Map();
  const add = (bone, tri) => (out.get(bone) ?? out.set(bone, []).get(bone)).push(tri.map((v) => points[v]));
  for (const tri of triangles) {
    const owners = tri.map((v) => weights[v][0]?.[0]);
    const dominant = owners[1] === owners[2] ? owners[1] : owners[0];
    if (dominant === undefined) continue;
    const bones = new Set([dominant]);
    if (overlap !== null) for (const v of tri) for (const [bone, w] of weights[v]) if (w >= overlap) bones.add(bone);
    for (const bone of bones) add(bone, tri);
  }
  return out;
}

// -- parts ------------------------------------------------------------------------
//
// A skinned model's parts, one object per bone that has any, in the rest
// pose, in scene coordinates: a Map from bone index to a subtree. Three
// ways to make them, by what is wanted of the geometry - import-model's
// --skeleton mesh, fit-to-mesh and along-bones.

/**
 * --skeleton mesh: the model's own mesh, shared among its bones
 * (splitByBone()), each bone's triangles of each primitive a tree
 * (meshToTree()) made of the primitive's own material, as the source names
 * it.
 */
export function meshParts({ primitives }, { overlap = null } = {}) {
  const pieces = new Map();
  for (const prim of primitives) {
    for (const [bone, triangles] of splitByBone(prim, { overlap })) {
      const tree = meshToTree(triangles);
      if (!tree) continue;
      (pieces.get(bone) ?? pieces.set(bone, []).get(bone)).push(prim.material ? { material: prim.material, ...tree } : tree);
    }
  }
  return gathered(pieces);
}

/**
 * What fit-to-mesh calls a source material: `<prefix>-<its name>`, lowercased,
 * hyphenated, without the M_ many exporters start with (M_Main: figure-main);
 * one with no name, `<prefix>-body`.
 */
export const fitToMeshMaterial = (prefix, source) =>
  `${prefix}-${String(source ?? '').replace(/^M_/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'body'}`;

/**
 * --skeleton fit-to-mesh: a spheroid per bone per primitive, fitted to the
 * vertices the bone weighs most (fitSpheroid()), made of
 * `<prefix>-<the primitive's material>`. A bone thinner than `minThickness`
 * gives its vertices to its parent, leaves first, so fingers fold into
 * mitten hands.
 */
export function fitToMeshParts({ skeleton, primitives }, { minThickness = 0.06, percentile = 0.95, prefix = 'figure' } = {}) {
  const vertices = [];                                      // { p, owner, material }
  for (const prim of primitives) {
    const material = fitToMeshMaterial(prefix, prim.material);
    prim.points.forEach((p, v) => { if (prim.weights[v].length) vertices.push({ p, owner: prim.weights[v][0][0], material }); });
  }
  // Thin bones, leaves first, give their vertices (theirs, and what their
  // children gave them) to their parents.
  for (let i = skeleton.bones.length - 1; i >= 0; i--) {
    const parent = skeleton.bones[i].parent;
    if (parent < 0) continue;
    const mine = vertices.filter((v) => v.owner === i);
    if (mine.length && thickness(mine.map((v) => v.p), percentile) < minThickness) for (const v of mine) v.owner = parent;
  }
  const pieces = new Map();
  for (let i = 0; i < skeleton.bones.length; i++) {
    const byMaterial = new Map();
    for (const v of vertices) if (v.owner === i) (byMaterial.get(v.material) ?? byMaterial.set(v.material, []).get(v.material)).push(v.p);
    for (const [material, points] of byMaterial) {
      if (points.length < 4) continue;
      (pieces.get(i) ?? pieces.set(i, []).get(i)).push({ spheroid: fitSpheroid(points, percentile), material });
    }
  }
  return gathered(pieces);
}

/**
 * --skeleton along-bones: spheroids along the bones themselves, needing no
 * geometry: one from each joint to each child joint, a fifth as thick as it
 * is long, and a ball at each end bone, half the length of the bone leading
 * to it. Made of `<prefix>-bone`.
 */
export function alongBonesParts({ skeleton, worldOf }, { prefix = 'figure' } = {}) {
  const at = (i) => { const m = worldOf(i); return [m[12], m[13], m[14]]; };
  const children = skeleton.bones.map(() => []);
  skeleton.bones.forEach((bone, i) => { if (bone.parent >= 0) children[bone.parent].push(i); });
  const material = `${prefix}-bone`;
  const pieces = new Map();
  skeleton.bones.forEach((bone, i) => {
    const a = at(i);
    for (const c of children[i]) {
      const b = at(c), d = b.map((v, k) => v - a[k]), length = Math.hypot(...d);
      if (length < 1e-6) continue;
      (pieces.get(i) ?? pieces.set(i, []).get(i)).push({
        spheroid: { center: a.map((v, k) => (v + b[k]) / 2), axis: d.map((v) => v / length), height: length, radius: length / 10 },
        material,
      });
    }
    if (!children[i].length && bone.parent >= 0) {
      const p = at(bone.parent), r = Math.hypot(...a.map((v, k) => v - p[k])) / 2;
      if (r > 1e-6) (pieces.get(i) ?? pieces.set(i, []).get(i)).push({ sphere: { center: a, radius: r }, material });
    }
  });
  return gathered(pieces);
}

// One piece as itself, several as a group.
const gathered = (pieces) => new Map([...pieces].map(([bone, list]) => [bone, list.length === 1 ? list[0] : { group: list }]));

// -- fitting ------------------------------------------------------------------------

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];

/** The unit eigenvector of a symmetric 3x3 matrix with the largest eigenvalue (Jacobi). */
function principalAxis(m) {
  const a = m.map((row) => row.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
        for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
        for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
      }
    }
  }
  const best = [0, 1, 2].reduce((i, j) => (a[j][j] > a[i][i] ? j : i), 0);
  const axis = [v[0][best], v[1][best], v[2][best]];
  const l = Math.hypot(...axis);
  return axis.map((x) => x / l);
}

/**
 * A spheroid round points: its axis their principal direction, its height
 * and radius covering `percentile` of them along and around it.
 */
export function fitSpheroid(points, percentile = 0.95) {
  const n = points.length;
  const mean = [0, 1, 2].map((c) => points.reduce((s, p) => s + p[c], 0) / n);
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of points) {
    const d = sub3(p, mean);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[r][c] += d[r] * d[c] / n;
  }
  let axis = principalAxis(cov);
  // A consistent sign: the largest component positive.
  const big = [0, 1, 2].reduce((i, j) => (Math.abs(axis[j]) > Math.abs(axis[i]) ? j : i), 0);
  if (axis[big] < 0) axis = axis.map((x) => -x);
  // Both ends at mirrored ranks, so which way the axis points can't change
  // which points they fall on: the fit is the same in any frame.
  const along = points.map((p) => dot3(sub3(p, mean), axis)).sort((a, b) => a - b);
  const skip = Math.round((1 - percentile) * (along.length - 1));
  const lo = along[skip], hi = along[along.length - 1 - skip];
  const around = points.map((p) => {
    const d = sub3(p, mean), s = dot3(d, axis);
    return Math.hypot(d[0] - s * axis[0], d[1] - s * axis[1], d[2] - s * axis[2]);
  }).sort((a, b) => a - b);
  return {
    center: mean.map((m, c) => m + axis[c] * (lo + hi) / 2),
    axis,
    height: Math.max(hi - lo, 1e-4),
    radius: Math.max(quantile(around, percentile), 1e-4),
  };
}

// How thick points are across: their fitted spheroid's diameter.
const thickness = (points, percentile) => (points.length < 4 ? 0 : 2 * fitSpheroid(points, percentile).radius);
