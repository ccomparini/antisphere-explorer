#!/usr/bin/env node
// Make a figure - a skeleton, a body of quadric parts riding on its bones,
// and its animations - from a skinned, animated glTF (public/figure.js
// says what a figure is).
//
//   node tools/import-figure.mjs public/scenes/parts/quaternius/UAL1_Standard.glb \
//     -o public/scenes/parts/quaternius/mannequin.json
//   node tools/import-figure.mjs model.glb --clips Walk_Loop,Idle_Loop --pose Walk_Loop@0.5 -o walker.json
//
// The skin's mesh isn't kept: a mesh that bends each frame would have to be
// rebuilt each frame. Instead each bone gets a spheroid fitted to the
// vertices it carries most of, one per mesh primitive (a body and its
// joints, say) - rigid parts, which move as the bones do. A bone thinner
// than --min-thickness gives its vertices to its parent, so fingers become
// mittens unless told otherwise.
//
// Each clip is resampled at --fps into each bone's local rotation, and the
// translations of the bones that move (a walk's pelvis). Its "objects"
// hold the figure posed - at rest, or as --pose says - as a scene subtree,
// named as the file is (or --name), as other parts files hold theirs:
// "use": "@parts/quaternius/mannequin.json#/objects/mannequin".
//
// glTF is y up; scenes are z up, and the figure is turned to match.
// Reports on stderr; writes the figure on stdout unless told where.

const VERSION_MAJ = 0;
const VERSION_MIN = 1;

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { readGLTF, sample, clipRange, compose, multiply, transformPoint, decompose } from '../public/gltf.js';
import { poseFigure } from '../public/figure.js';
import { compileScene } from '../public/antisphere-scene.js';
import { parseOptions, commandLine } from './args.mjs';

const USAGE = `
import-figure - a figure (skeleton, quadric body, clips) from a skinned glTF

  node tools/import-figure.mjs <source.glb|.gltf> [options]

  -o, --out <file>          write here instead of stdout; a name ending .gz
                            is gzipped
      --no-check            write it without compiling its posed object first
      --name <n>            the posed object's name in "objects" (default: the
                            output file's name, mannequin for mannequin.json;
                            on stdout, figure)
      --prefix <p>          its materials are <p>-<primitive's material>, as
                            figure-main (default "figure")
      --min-thickness <m>   a bone whose vertices are thinner than this
                            across, in metres, gives them to its parent
                            (default 0.06: fingers into hands; 0 keeps all)
      --fit-percentile <p>  how much of a bone's vertices its part covers,
                            along and around it (default 95)
      --fps <n>             frames per second the clips are kept at (default 30)
      --clips <a,b,...>     which animations to keep (default all)
      --pose <clip>[@t]     the posed object: a clip at t seconds (default:
                            the bind pose)
      --skin <n>            which of the file's skins (default 0)
      --pretty              make the output more readable
`.trim();

// glTF's y up to the scene's z up: +90 degrees about x.
const Y_UP_TO_Z_UP = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

function parseArguments(argv) {
  const { values, positionals } = parseOptions(argv, {
    out: { type: 'string', short: 'o' },
    'no-check': { type: 'boolean' },
    prefix: { type: 'string', default: 'figure' },
    'min-thickness': { type: 'number', default: 0.06 },
    'fit-percentile': { type: 'number', default: 95 },
    fps: { type: 'number', default: 30 },
    clips: { type: 'string' },
    pose: { type: 'string' },
    name: { type: 'string' },
    skin: { type: 'number', default: 0 },
    pretty: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  }, { positionals: true });
  if (positionals.length > 1) throw new Error(`one source at a time, not ${positionals.length}`);
  if (!(values['min-thickness'] >= 0)) throw new Error('--min-thickness needs a number, 0 or more');
  if (!(values['fit-percentile'] > 50 && values['fit-percentile'] <= 100)) throw new Error('--fit-percentile needs a number above 50, up to 100');
  if (!(values.fps > 0)) throw new Error('--fps needs a positive number');
  if (values.name !== undefined && !/^[^/#~\s]+$/.test(values.name)) throw new Error(`--name ${JSON.stringify(values.name)}: a name, with no / # ~ or spaces`);
  return {
    source: positionals[0], out: values.out, check: !values['no-check'], prefix: values.prefix,
    minThickness: values['min-thickness'], percentile: values['fit-percentile'] / 100, fps: values.fps,
    clips: values.clips?.split(',').map((s) => s.trim()).filter(Boolean), pose: values.pose,
    name: values.name ?? (values.out ? path.basename(values.out).replace(/\.json(\.gz)?$/i, '') : 'figure'),
    skin: values.skin, pretty: values.pretty, help: values.help,
  };
}

// -- fitting ------------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
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
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
        }
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
    const d = sub(p, mean);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[r][c] += d[r] * d[c] / n;
  }
  let axis = principalAxis(cov);
  // A consistent sign: the largest component positive.
  const big = [0, 1, 2].reduce((i, j) => (Math.abs(axis[j]) > Math.abs(axis[i]) ? j : i), 0);
  if (axis[big] < 0) axis = axis.map((x) => -x);
  const along = points.map((p) => dot(sub(p, mean), axis)).sort((a, b) => a - b);
  const lo = quantile(along, 1 - percentile), hi = quantile(along, percentile);
  const around = points.map((p) => {
    const d = sub(p, mean), s = dot(d, axis);
    return Math.hypot(d[0] - s * axis[0], d[1] - s * axis[1], d[2] - s * axis[2]);
  }).sort((a, b) => a - b);
  const radius = quantile(around, percentile);
  return {
    center: mean.map((m, c) => m + axis[c] * (lo + hi) / 2),
    axis,
    height: Math.max(hi - lo, 1e-4),
    radius: Math.max(radius, 1e-4),
  };
}

// How thick a bone's points are across: their fitted spheroid's diameter.
const thickness = (points, percentile) => (points.length < 4 ? 0 : 2 * fitSpheroid(points, percentile).radius);

// -- the figure ------------------------------------------------------------------

/**
 * A figure from a parsed glTF (see public/gltf.js). Options: skin, prefix,
 * minThickness, percentile, fps, clips (names), warn.
 */
export function figureFromGLTF(gltf, { skin: skinIndex = 0, prefix = 'figure', minThickness = 0.06, percentile = 0.95,
                                       fps = 30, clips: wanted, warn = console.warn } = {}) {
  const json = gltf.json;
  const skin = json.skins?.[skinIndex];
  if (!skin) throw new Error(`no skin ${skinIndex} (the file has ${json.skins?.length ?? 0})`);
  const joints = skin.joints;                               // skin joint k is node joints[k]
  const jointOf = new Map(joints.map((node, k) => [node, k]));
  const ibm = skin.inverseBindMatrices === undefined ? null : gltf.accessor(skin.inverseBindMatrices);
  const ibmOf = (k) => (ibm ? ibm.subarray(16 * k, 16 * k + 16) : identity());
  const name = (k) => json.nodes[joints[k]].name ?? `joint${k}`;
  // A joint's parent joint: its nearest ancestor that is a joint.
  const parentJoint = joints.map((node) => {
    for (let p = gltf.parents[node]; p >= 0; p = gltf.parents[p]) if (jointOf.has(p)) return jointOf.get(p);
    return -1;
  });
  // Parents first.
  const depth = (k) => (parentJoint[k] < 0 ? 0 : 1 + depth(parentJoint[k]));
  const order = joints.map((_, k) => k).sort((a, b) => depth(a) - depth(b) || a - b);

  // Every vertex of every primitive the skin moves, to the joint carrying
  // most of it, kept in mesh space; `material` names the primitive's.
  const slug = (s) => String(s).replace(/^M_/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'body';
  const vertices = [];                                      // { p, owner, material }
  json.nodes.forEach((node) => {
    if (node.skin !== skinIndex || node.mesh === undefined) return;
    for (const [i, prim] of json.meshes[node.mesh].primitives.entries()) {
      const { POSITION, JOINTS_0, WEIGHTS_0 } = prim.attributes;
      if (POSITION === undefined || JOINTS_0 === undefined || WEIGHTS_0 === undefined) continue;
      const pos = gltf.accessor(POSITION), js = gltf.accessor(JOINTS_0), ws = gltf.accessor(WEIGHTS_0);
      const materialName = prim.material === undefined ? `part-${i}` : json.materials?.[prim.material]?.name ?? `material-${prim.material}`;
      const material = `${prefix}-${slug(materialName)}`;
      for (let v = 0; v < pos.length / 3; v++) {
        let best = 0;
        for (let c = 1; c < 4; c++) if (ws[4 * v + c] > ws[4 * v + best]) best = c;
        vertices.push({ p: [pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]], owner: js[4 * v + best], material });
      }
    }
  });
  if (!vertices.length) throw new Error(`no mesh is skinned to skin ${skinIndex}`);

  // A point in mesh space, in joint k's frame (as skinning does it).
  const inJoint = (k, p) => transformPoint(ibmOf(k), p);
  // Thin bones, leaves first, give their vertices (theirs, and what their
  // children gave them) to their parents: a finger's tip to its middle, and
  // on to the hand.
  for (const k of [...order].reverse()) {
    if (parentJoint[k] < 0) continue;
    const mine = vertices.filter((v) => v.owner === k);
    if (mine.length && thickness(mine.map((v) => inJoint(k, v.p)), percentile) < minThickness) {
      for (const v of mine) v.owner = parentJoint[k];
    }
  }

  // Parts: a spheroid per joint per primitive, in the joint's frame.
  const parts = [];
  for (const k of order) {
    const byMaterial = new Map();
    for (const v of vertices) if (v.owner === k) (byMaterial.get(v.material) ?? byMaterial.set(v.material, []).get(v.material)).push(v);
    for (const [material, vs] of byMaterial) {
      if (vs.length < 4) continue;
      parts.push({ bone: name(k), material, spheroid: fitSpheroid(vs.map((v) => inJoint(k, v.p)), percentile) });
    }
  }

  // The skeleton: the joints carrying parts, and those above them.
  const kept = new Set();
  for (const part of parts) {
    for (let k = joints.findIndex((_, j) => name(j) === part.bone); k >= 0 && !kept.has(k); k = parentJoint[k]) kept.add(k);
  }
  const bones = order.filter((k) => kept.has(k));
  const index = new Map(bones.map((k, i) => [k, i]));
  // What the roots stand in: whatever is above them, turned z up. A joint
  // must sit directly under its parent joint, or every root under one node.
  const above = new Set(bones.filter((k) => parentJoint[k] < 0).map((k) => gltf.parents[joints[k]]));
  if (above.size > 1) throw new Error('the skeleton\'s roots stand under different nodes');
  for (const k of bones) {
    if (parentJoint[k] >= 0 && gltf.parents[joints[k]] !== joints[parentJoint[k]]) {
      throw new Error(`joint ${name(k)} has a node between it and its parent joint, which isn't supported`);
    }
  }
  const [top] = above;
  const restWorld = gltf.worldMatrices();
  const baseMatrix = multiply(compose({ rotation: Y_UP_TO_Z_UP }), top >= 0 ? restWorld[top] : identity());
  const { translation, rotation } = decompose(baseMatrix);
  const skeleton = bones.map((k) => {
    const rest = gltf.rest(joints[k]);
    return { name: name(k), parent: parentJoint[k] < 0 ? -1 : index.get(parentJoint[k]), translation: rest.translation, rotation: rest.rotation };
  });

  // Clips: resampled, each bone's channels kept only where they move.
  const clips = {};
  const animations = (json.animations ?? []).filter((a, i) => !wanted || wanted.includes(a.name ?? `animation${i}`));
  for (const name_ of wanted ?? []) {
    if (!(json.animations ?? []).some((a, i) => (a.name ?? `animation${i}`) === name_)) throw new Error(`no animation "${name_}"`);
  }
  for (const [i, animation] of animations.entries()) {
    const clipName = animation.name ?? `animation${i}`;
    const [start, end] = clipRange(gltf, animation);
    const frames = Math.max(1, Math.round((end - start) * fps) + 1);
    const rotations = {}, translations = {};
    let scaled = false;
    for (let f = 0; f < frames; f++) {
      const trs = sample(gltf, animation, Math.min(start + f / fps, end));
      for (const k of bones) {
        const at = trs.get(joints[k]) ?? gltf.rest(joints[k]);
        (rotations[name(k)] ??= []).push(at.rotation);
        (translations[name(k)] ??= []).push(at.translation);
        if (at.scale.some((s) => Math.abs(s - 1) > 1e-3)) scaled = true;
      }
    }
    if (scaled) warn(`${clipName}: scales a bone, which a figure doesn't keep`);
    for (const k of bones) {
      const bone = skeleton[index.get(k)];
      if (rotations[bone.name].every((q) => Math.abs(Math.abs(dot4(q, bone.rotation)) - 1) < 1e-9)) delete rotations[bone.name];
      if (translations[bone.name].every((t) => Math.hypot(...sub(t, bone.translation)) < 1e-5)) delete translations[bone.name];
    }
    clips[clipName] = { fps, frames, rotations, ...(Object.keys(translations).length ? { translations } : {}) };
  }

  return { skeleton, base: { translation, rotation }, parts, clips };
}

const dot4 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const identity = () => compose({});

// -- the command ------------------------------------------------------------------

// Numbers in as few digits as a float32 holds, which is all the file had.
const shorter = (key, value) => (typeof value === 'number' && !Number.isInteger(value) ? +value.toPrecision(7) : value);

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help || !options.source) {
    console.log(USAGE);
    process.exit(options.help ? 0 : 1);
  }
  const say = (...parts) => console.error(...parts);
  const gltf = await readGLTF(readFileSync(options.source),
                              { readBytes: async (file) => readFileSync(file), base: options.source });
  const figure = figureFromGLTF(gltf, { ...options, warn: (msg) => say(`  ${msg}`) });
  const [poseClip, poseTime = '0'] = options.pose ? options.pose.split('@') : [null];
  if (poseTime.trim() === '' || !Number.isFinite(Number(poseTime))) {
    throw new Error(`--pose ${options.pose}: the time after @ needs to be a number`);
  }
  const object = poseFigure(figure, poseClip, Number(poseTime));
  const out = {
    _meta: {
      generatedBy: commandLine(),
      generatorVersionMaj: VERSION_MAJ,
      generatorVersionMin: VERSION_MIN,
      source: path.basename(options.source),
      ...(options.pose ? { pose: options.pose } : {}),
    },
    ...figure,
    objects: { [options.name]: object },
  };
  const materials = [...new Set(figure.parts.map((p) => p.material))];
  say(`${path.basename(options.source)}: ${figure.skeleton.length} bones, ${figure.parts.length} parts ` +
      `(${materials.join(', ')}), ${Object.keys(figure.clips).length} clips; posed as objects.${options.name}`);

  if (options.check) {
    try {
      const built = compileScene({ materials: Object.fromEntries(materials.map((m) => [m, {}])), lights: [], root: structuredClone(object) });
      say(`  posed, compiles to ${built.nodes.length - 1} nodes`);
    } catch (error) {
      throw new Error(`${error.message} (--no-check writes it anyway)`);
    }
  }
  const json = JSON.stringify(out, shorter, options.pretty ? 1 : 0) + '\n';
  if (options.out) {
    mkdirSync(path.dirname(options.out), { recursive: true });
    writeFileSync(options.out, /\.gz$/i.test(options.out) ? gzipSync(json, { level: 9 }) : json);
    say(`  written to ${options.out} (${(json.length / 1024).toFixed(0)} KB of JSON)`);
  } else {
    process.stdout.write(json);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`import-figure: ${error.message}`);
    process.exit(1);
  });
}
