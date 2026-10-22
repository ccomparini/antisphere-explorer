// Posing a model by a clip: its bones moved as the clip says, and each of
// its parts carried by its bone.
//
// A model with a skeleton (tools/import-model.mjs makes one from a skinned
// glTF; one can be written by hand) is:
//
//   skeleton   { base, bones } - see public/skin.js
//   scale      optional: the model's size against the skeleton its clips
//              were made for; a clip's translations are multiplied by it
//   objects    its parts, in its rest pose, in scene coordinates. A part is
//              an object named for a bone, or one naming its bone
//              ("bone": "hand_r"). Objects that other objects use are
//              helpers, and objects that only gather others (the whole
//              model, at rest) are assemblies: neither is moved itself.
//              Anything else rides on the root bone, warned of.
//
// Clips come separately (tools/import-animations.mjs): keyframed
// (keyframes.js), each bone's channels by its name. A bone the clip doesn't
// move stays at rest; a bone it moves that the model hasn't - fingers, on a
// model without - is passed over.

import { compose, multiply, decompose } from './gltf.js';
import { sampleTrack, clipTime } from './keyframes.js';

// Clips asked for and not there, by clip set: warned of once each.
const unknownClips = new WeakMap();

/**
 * Each bone's local { translation, rotation } at time t (seconds since the
 * clip started) in `clip`, or at rest without one; a looping clip wraps,
 * any other holds its ends. Translations from the clip are scaled by
 * `scale`.
 */
export function bonePose(skeleton, clip, t = 0, { scale = 1 } = {}) {
  const time = clip ? clipTime(clip, t) : 0;
  return skeleton.bones.map((bone) => {
    const channel = clip?.channels?.[bone.name];
    return {
      translation: channel?.translation ? sampleTrack(channel.translation, time).map((v) => v * scale) : bone.translation,
      rotation: channel?.rotation ? sampleTrack(channel.rotation, time, { rotation: true }) : bone.rotation,
    };
  });
}

/** Each bone's matrix in scene coordinates, for a pose from bonePose(). */
export function boneMatrices(skeleton, pose) {
  const base = compose(skeleton.base);
  const world = [];
  skeleton.bones.forEach((bone, i) => {
    world[i] = multiply(bone.parent < 0 ? base : world[bone.parent], compose(pose[i]));
  });
  return world;
}

// A rigid matrix's inverse: its rotation transposed, its translation undone.
function invertRigid(m) {
  const out = new Float64Array(16);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[c * 4 + r] = m[r * 4 + c];
  for (let r = 0; r < 3; r++) out[12 + r] = -(out[r] * m[12] + out[4 + r] * m[13] + out[8 + r] * m[14]);
  out[15] = 1;
  return out;
}

/**
 * Which bone each of a model's objects rides on: a Map from object name to
 * bone index, for its parts. Objects named for a bone, or naming one, are
 * its; helpers and assemblies (see above) are none; any other is the root's,
 * and `warn` is told.
 */
export function partsOf(model, { warn = console.warn } = {}) {
  const bones = new Map(model.skeleton.bones.map((bone, i) => [bone.name, i]));
  const objects = model.objects ?? {};
  // The names each object refers to, and so which are used.
  const refers = new Map(), used = new Set();
  for (const [name, def] of Object.entries(objects)) {
    const names = new Set();
    const walk = (v) => {
      if (typeof v === 'string') { if (v in objects) names.add(v); return; }
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === 'object') {
        if (typeof v.use === 'string' && v.use in objects) names.add(v.use);
        for (const key of ['inside', 'outside', 'group', 'union', 'intersection', 'difference']) if (v[key] !== undefined) walk(v[key]);
      }
    };
    walk(def);
    refers.set(name, names);
    for (const n of names) used.add(n);
  }
  const out = new Map();
  for (const [name, def] of Object.entries(objects)) {
    const boneName = def?.bone ?? (bones.has(name) ? name : null);
    if (boneName !== null) {
      if (bones.has(boneName)) out.set(name, bones.get(boneName));
      else { warn(`model: objects.${name} names a bone "${boneName}" the skeleton hasn't: on the root`); out.set(name, 0); }
    } else if (!used.has(name) && !refers.get(name).size) {
      warn(`model: objects.${name} names no bone, and nothing uses it: on the root`);
      out.set(name, 0);
    }
  }
  return out;
}

/**
 * The model posed at time t of a clip from `clips` (or at rest, without
 * one), as a scene subtree: a group of its parts, each turned and moved as
 * its bone has from rest. A clip not in `clips` is warned of (once) and
 * leaves the model at rest: it plays on. `at` moves the whole after posing.
 */
export function poseModel(model, clips, clipName = null, t = 0, { at = [0, 0, 0], warn = console.warn } = {}) {
  let clip = clipName ? clips?.[clipName] : null;
  if (clipName && !clip) {
    const key = clips ?? model;
    const seen = unknownClips.get(key) ?? new Set();
    unknownClips.set(key, seen);
    if (!seen.has(clipName)) {
      seen.add(clipName);
      warn(`model: no clip "${clipName}" (has ${Object.keys(clips ?? {}).join(', ') || 'none'}): at rest`);
    }
    clip = null;
  }
  const { skeleton } = model;
  const rest = boneMatrices(skeleton, bonePose(skeleton, null));
  const posed = boneMatrices(skeleton, bonePose(skeleton, clip, t, { scale: model.scale ?? 1 }));
  const group = [];
  for (const [name, bone] of partsOf(model, { warn })) {
    // The bone's motion since rest: posed, after undoing rest.
    const { translation, rotation } = decompose(multiply(posed[bone], invertRigid(rest[bone])));
    const [x, y, z, w] = rotation;
    const s = Math.hypot(x, y, z), angle = 2 * Math.atan2(s, w);
    group.push({
      group: [model.objects[name]],
      ...(s > 1e-12 ? { rotate: { axis: [x / s, y / s, z / s], radians: angle } } : {}),
      translate: translation.map((v, i) => v + at[i]),
    });
  }
  return { group };
}
