// What the animation viewer shows: a model on a floor, posed by a clip, as a
// scene spec. Apart from the page, so that it can be tested, and rendered
// headless, without one.
//
//   const spec = stageSpec(model, { modelRef: '@parts/quaternius/mannequin.json',
//                                   clips, clip: 'Walk_Loop', t: 0.4,
//                                   materials: ['@parts/quaternius/mannequin-materials.json'] });
//
// Two ways to pose it. stageSpec() places the posed parts as a group, which
// the compiler divides up anew for every pose: each pose a compile. Or, for
// a model made of self-contained shapes, the stage is compiled once without
// it, and the model's shapes, as a chain, are grafted into it wherever the
// model's reach takes it (movers.js) - above the floor, and below it too,
// for a swimmer. Each pose is then only the shapes' quadrics, written into
// every copy of them (ASScene.setNodePrims()):
//
//   const chain = chainOf(model);
//   const { built, nodes, rest } = graftedStage(model, chain, compile, { materials, reach: reachOf(model, chain, clips) });
//   scene.load(built);
//   ...each frame:
//   const prims = chainPrims(model, chain, rest, { clips, clip, t });
//   scene.setNodePrims(nodes.flatMap((copies, k) => copies.map((i) => [i, prims[k]])));
//
// A chain is right in any pose: what fills a point is the first shape in it
// holding the point, or, outside them all, nothing - the group's union,
// whatever moves where. Only where shapes overlap does the order matter,
// and the order is fixed. A group's dividers and the grafts it leaves out
// are bets on where things are, which is why the group needs recompiling.
//
// The spec is meant to be compiled as though it were a file in scenes/
// (STAGE_PATH, beside the scenes), so that its references - the model's
// file, the material libraries - are found from there.

import { poseModel, partMotions, partsOf, boneMatrices, bonePose } from '../figure.js';
import { movePrim } from '../antisphere-scene.js';
import { fromAxisAngle, rotate as turnBy } from '../quat.js';
import { graftMover } from '../movers.js';
import { boundingSpheroidOfPoints } from '../mesh-import.js';

/** Where a stage spec stands, for its references: as if a file in scenes/. */
export const STAGE_FILE = 'anim-viewer-stage.json';

// A light like the sun's, from in front, to the right and above.
const SUN = { direction: [0.25, -0.4, -0.35], color: [1.2, 1, 0.8] };

/**
 * Where to look at a model from: { focus, distance }. A model with a
 * skeleton by its bones at rest, any other by its recorded dimensions, or
 * two across, standing on z = 0, failing those.
 */
export function frameOf(model) {
  let lo, hi;
  if (model.skeleton) {
    const at = boneMatrices(model.skeleton, bonePose(model.skeleton, null)).map((m) => [m[12], m[13], m[14]]);
    lo = [0, 1, 2].map((k) => Math.min(...at.map((p) => p[k])));
    hi = [0, 1, 2].map((k) => Math.max(...at.map((p) => p[k])));
  } else {
    const [dx, dy, dz] = model._meta?.dimensions ?? [2, 2, 2];
    lo = [-dx / 2, -dy / 2, 0];
    hi = [dx / 2, dy / 2, dz];
  }
  const size = Math.max(...hi.map((v, k) => v - lo[k]), 0.1);
  return { focus: lo.map((v, k) => (v + hi[k]) / 2), distance: 2.2 * size };
}

/** The stage round `shown`: a checker floor, one light, a camera on `model`. */
function stage(model, shown, materials) {
  const { focus, distance } = frameOf(model);
  const direction = [-0.45, 0.85, -0.28];
  const length = Math.hypot(...direction);
  return {
    camera: { position: focus.map((v, k) => v - direction[k] / length * distance), direction, distance },
    materials: ['@lib/materials.json', ...materials],
    lights: [SUN],
    root: { plane: { normal: [0, 0, 1], offset: 0 }, material: 'floor', outside: shown },
  };
}

/**
 * The stage, as a scene spec: the model on a checker floor, lit by one
 * light, posed at time `t` of `clip` (a name in `clips`; none, at rest), its
 * parts referred to in its file, `modelRef`. A model with no skeleton is
 * shown as it is - a scene file, its root, with its objects. Materials:
 * lib/materials.json, the model file's own, then `materials` (more
 * references, or maps), a later one winning. `warn` hears of a clip not
 * there.
 */
export function stageSpec(model, { modelRef, clips = null, clip = null, t = 0, materials = [], warn = console.warn } = {}) {
  const shown = model.skeleton
    ? poseModel(model, clips, clip, t, { refer: (name) => `${modelRef}#/objects/${name}`, warn })
    : { use: model.root !== undefined ? `${modelRef}#/root` : modelRef };
  const spec = stage(model, shown, [...(model.materials ? [`${modelRef}#/materials`] : []), ...materials]);
  if (!model.skeleton && model.objects) spec.objects = `${modelRef}#/objects`;
  return spec;
}

const SHAPES = ['sphere', 'spheroid'];
const isShape = (def) => def && typeof def === 'object' && SHAPES.some((k) => def[k])
  && Object.keys(def).every((k) => SHAPES.includes(k) || k === 'material' || k === 'bone' || k.startsWith('_'));

/**
 * A model's parts as a chain of self-contained shapes - spheres and
 * spheroids, a part one of them or a group of them - [{ part, def }] in
 * chain order (partsOf()'s, each part's shapes in its own order), each def
 * a shape with its material. Null if some part is anything else (a mesh,
 * a part with a transform of its own): such a model is posed by
 * recompiling.
 */
export function chainOf(model, { warn = console.warn } = {}) {
  if (!model.skeleton) return null;
  const chain = [];
  for (const [part] of partsOf(model, { warn })) {
    const def = model.objects[part];
    const members = isShape(def) ? [def]
      : def?.group && Object.keys(def).every((k) => k === 'group' || k === 'material' || k === 'bone' || k.startsWith('_'))
        && def.group.every(isShape) ? def.group : null;
    if (!members) return null;
    for (const member of members) {
      const { bone, ...shape } = member;
      chain.push({ part, def: { ...shape, material: member.material ?? def.material ?? null } });
    }
  }
  return chain.length ? chain : null;
}

/**
 * The stage (as stageSpec()), the model as `chain` (chainOf()) at rest:
 * each shape in the outside of the one before.
 */
export function chainSpec(model, chain, { materials = [] } = {}) {
  let tree;
  for (let k = chain.length - 1; k >= 0; k--) tree = { ...chain[k].def, ...(tree ? { outside: tree } : {}) };
  return stage(model, tree, materials);
}

/**
 * Where a compiled chainSpec()'s shapes are: their node indices, in chain
 * order, from the root (the floor) along its outside. Null if the nodes
 * aren't a plain chain of that length.
 */
export function chainNodes(nodes, chain) {
  const out = [];
  for (let i = nodes[1]?.outside; i && out.length < chain.length + 1; i = nodes[i].outside) {
    if (nodes[i].inside) return null;
    out.push(i);
  }
  return out.length === chain.length ? out : null;
}

/**
 * Each chain shape's quadric at time t of `clip`: its quadric at rest
 * (`rest`, from the compiled nodes) moved as its part has (partMotions()).
 */
export function chainPrims(model, chain, rest, { clips = null, clip = null, t = 0, warn = console.warn } = {}) {
  const motion = new Map(partMotions(model, clips, clip, t, { warn }).map((m) => [m.name, m]));
  return chain.map(({ part }, k) => movePrim(rest[k], motion.get(part)));
}

/** The stage with nothing on it: the floor, the light, the camera on `model`. */
export function emptyStage(model, { materials = [] } = {}) {
  return stage(model, undefined, materials);
}

// The corners of a box round a shape, as moved by `rotate` and `translate`:
// a spheroid's extent along each world axis is
// sqrt(a^2 n_i^2 + r^2 (1 - n_i^2)), for half-height a, radius r, axis n.
function cornersOf(def, { rotate, translate }) {
  const q = rotate ? fromAxisAngle(rotate.axis, rotate.radians) : null;
  const turn = (v) => (q ? turnBy(q, v) : v);
  const shape = def.sphere ?? def.spheroid;
  const c = turn(shape.center ?? [0, 0, 0]).map((v, i) => v + translate[i]);
  let half;
  if (def.sphere) half = [shape.radius, shape.radius, shape.radius];
  else {
    const n = turn(shape.axis), a = shape.height / 2, r = shape.radius, len = Math.hypot(...n);
    half = n.map((v) => { const u = v / len; return Math.sqrt(a * a * u * u + r * r * (1 - u * u)); });
  }
  const out = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) out.push([c[0] + sx * half[0], c[1] + sy * half[1], c[2] + sz * half[2]]);
  return out;
}

/**
 * A spheroid holding the model in every pose of its clips, and at rest
 * ({ center, axis, height, radius }): each clip sampled `samples` times
 * through, the corners of a box round each shape as its part has moved it,
 * and boundingSpheroidOfPoints() round those - a box holds its shape, and
 * a spheroid holding a box's corners holds the box - grown by `margin`, so
 * that poses between the samples stay in it.
 */
export function reachOf(model, chain, clips, { samples = 24, margin = 0.05 } = {}) {
  const points = [];
  const quiet = () => {};
  for (const clip of [null, ...Object.keys(clips ?? {})]) {
    const duration = clip ? clips[clip].duration : 0;
    for (let s = 0; s <= (clip ? samples : 0); s++) {
      const motion = new Map(partMotions(model, clips, clip, duration * s / samples, { warn: quiet }).map((m) => [m.name, m]));
      for (const { part, def } of chain) points.push(...cornersOf(def, motion.get(part)));
    }
  }
  const { center, axis, height, radius } = boundingSpheroidOfPoints(points);
  return { center, axis, height: height * (1 + margin), radius: radius * (1 + margin) };
}

/**
 * The stage with the model grafted in as a mover: { built, nodes, rest,
 * copies } - the compiled scene, each chain shape's nodes (every copy), the
 * shapes' quadrics at rest, and where each copy starts. `compile(spec)`
 * compiles a spec (compileScene() with the stage's files and path), used
 * for the empty stage and for the chain's shapes, so their materials are
 * the same table.
 */
export function graftedStage(model, chain, compile, { materials = [], reach, budget, wrap } = {}) {
  const empty = compile(emptyStage(model, { materials }));
  const shapes = compile(chainSpec(model, chain, { materials }));
  const at = chainNodes(shapes.nodes, chain);
  if (!at) return null;
  // The same materials in both, but find each by name, to be sure.
  const index = new Map();
  empty.materials.forEach((m, i) => { if (m.name !== undefined && !index.has(m.name)) index.set(m.name, i); });
  const materialOf = (i) => index.get(shapes.materials[i]?.name) ?? i;
  const mover = {
    prims: at.map((i) => shapes.nodes[i].prim),
    materials: at.map((i) => materialOf(shapes.nodes[i].material)),
    prov: at.map((i) => shapes.nodes[i].prov),
  };
  const grafted = graftMover(empty, mover, { reach, ...(budget ? { budget } : {}), ...(wrap !== undefined ? { wrap } : {}) });
  return { ...grafted, rest: mover.prims };
}
