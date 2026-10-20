// A figure: a skeleton, rigid quadric parts riding on its bones, and clips
// that move the bones - what tools/import-figure.mjs makes from a skinned,
// animated glTF. poseFigure() turns one into a scene subtree, posed.
//
// A figure, as JSON:
//
//   skeleton  bones, parents first: { name, parent (index, or -1),
//             translation, rotation } - each bone's rest transform in its
//             parent's frame (quaternions [x, y, z, w])
//   base      { translation, rotation }: the frame the skeleton's roots
//             stand in, in scene coordinates (z up)
//   parts     { bone, material, spheroid: { center, axis, height, radius } },
//             the spheroid in its bone's frame
//   clips     name -> { fps, frames, rotations: { bone: [[x, y, z, w], ...] },
//             translations: { bone: [[x, y, z], ...] } } - a bone a clip
//             doesn't list stays at its rest
//
// Each part is a spheroid, a quadric of revolution, so posing one is moving
// its centre and turning its axis: no transforms are left on the nodes.

import { compose, multiply, slerp, transformDirection, transformPoint } from './gltf.js';

/**
 * Each bone's local { translation, rotation } at time t (seconds) in a clip,
 * or at rest without one. Between frames, translations are interpolated
 * linearly and rotations by slerp; t is clamped to the clip.
 */
export function bonePose(figure, clipName, t = 0) {
  const clip = clipName ? figure.clips?.[clipName] : null;
  if (clipName && !clip) throw new Error(`figure: no clip "${clipName}" (has ${Object.keys(figure.clips ?? {}).join(', ') || 'none'})`);
  const f = clip ? Math.min(Math.max(t * clip.fps, 0), clip.frames - 1) : 0;
  const k = Math.floor(f), u = f - k, k1 = Math.min(k + 1, (clip?.frames ?? 1) - 1);
  return figure.skeleton.map((bone) => {
    const rotations = clip?.rotations?.[bone.name], translations = clip?.translations?.[bone.name];
    return {
      translation: translations ? translations[k].map((v, c) => v + (translations[k1][c] - v) * u) : bone.translation,
      rotation: rotations ? slerp(rotations[k], rotations[k1], u) : bone.rotation,
    };
  });
}

/** Each bone's matrix in scene coordinates, for a pose from bonePose(). */
export function boneMatrices(figure, pose) {
  const base = compose(figure.base);
  const world = [];
  figure.skeleton.forEach((bone, i) => {
    const local = compose(pose[i]);
    world[i] = multiply(bone.parent < 0 ? base : world[bone.parent], local);
  });
  return world;
}

/**
 * The figure posed at time t of a clip (or at rest, without one), as a scene
 * subtree: a group of its parts, each a spheroid placed in the world,
 * wrapped in a spheroid round them all. `at` moves the whole by a
 * translation, after posing.
 */
export function poseFigure(figure, clipName = null, t = 0, { at = [0, 0, 0] } = {}) {
  const world = boneMatrices(figure, bonePose(figure, clipName, t));
  const index = new Map(figure.skeleton.map((bone, i) => [bone.name, i]));
  const round = (v) => +v.toFixed(6);
  const group = figure.parts.map(({ bone, material, spheroid: s }) => {
    const m = world[index.get(bone)];
    const center = transformPoint(m, s.center).map((v, c) => round(v + at[c]));
    const axis = transformDirection(m, s.axis);
    const l = Math.hypot(...axis);
    return { spheroid: { center, axis: axis.map((v) => round(v / l)), height: s.height, radius: s.radius }, material };
  });
  return { group, wrap: 'spheroid' };
}
