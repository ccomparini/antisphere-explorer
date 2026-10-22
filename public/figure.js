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
//   clips     name -> a keyframed clip (keyframes.js): { duration, loop,
//             markers, channels: { bone: { rotation, translation } } },
//             each a track of the bone's local rotation ([x, y, z, w]) or
//             translation in its parent's frame. A bone a clip doesn't
//             move stays at its rest; a bone it moves that the figure
//             hasn't (fingers, on a figure without) is passed over.
//
// Each part is a spheroid, a quadric of revolution, so posing one is moving
// its centre and turning its axis: no transforms are left on the nodes.

import { compose, multiply, transformDirection, transformPoint } from './gltf.js';
import { sampleTrack, clipTime } from './keyframes.js';

// Clips asked for and not there, by figure: warned of once each.
const unknownClips = new WeakMap();

/**
 * Each bone's local { translation, rotation } at time t (seconds since the
 * clip started) in a clip, or at rest without one; a looping clip wraps,
 * any other holds its ends. A clip the figure hasn't is warned of (once)
 * and the figure stays at rest: it plays on.
 */
export function bonePose(figure, clipName, t = 0, { warn = console.warn } = {}) {
  let clip = clipName ? figure.clips?.[clipName] : null;
  if (clipName && !clip) {
    const seen = unknownClips.get(figure) ?? new Set();
    unknownClips.set(figure, seen);
    if (!seen.has(clipName)) {
      seen.add(clipName);
      warn(`figure: no clip "${clipName}" (has ${Object.keys(figure.clips ?? {}).join(', ') || 'none'}): at rest`);
    }
    clip = null;
  }
  const time = clip ? clipTime(clip, t) : 0;
  return figure.skeleton.map((bone) => {
    const channel = clip?.channels?.[bone.name];
    return {
      translation: channel?.translation ? sampleTrack(channel.translation, time) : bone.translation,
      rotation: channel?.rotation ? sampleTrack(channel.rotation, time, { rotation: true }) : bone.rotation,
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
export function poseFigure(figure, clipName = null, t = 0, { at = [0, 0, 0], warn } = {}) {
  const world = boneMatrices(figure, bonePose(figure, clipName, t, { warn }));
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
