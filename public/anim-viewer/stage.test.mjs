// Tests for the animation viewer's stage: the tiny skinned model in
// gltf-fixture.mjs, and the mannequin and its clips the viewer opens on.
// Run with:
//   node --test public/anim-viewer/stage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readGLTF } from '../gltf.js';
import { fixture, toGLB } from '../gltf-fixture.mjs';
import { skinOf, fitToMeshParts } from '../skin.js';
import { compileScene, loadReferences } from '../antisphere-scene.js';
import { stageSpec, frameOf, STAGE_FILE, chainOf, chainSpec, chainNodes, chainPrims, reachOf, graftedStage, emptyStage } from './stage.js';
import { poseModel } from '../figure.js';
import { quadricAt as H } from '../quadric.js';

const SCENES = fileURLToPath(new URL('../scenes/', import.meta.url));
const STAGE = join(SCENES, STAGE_FILE);
const readJSON = (name) => JSON.parse(readFileSync(join(SCENES, name), 'utf8'));

const s = Math.SQRT1_2;
const CLIPS = {
  Bend: { duration: 1, channels: { j1: { rotation: { times: [0, 1], values: [[0, 0, 0, 1], [0, 0, s, s]] } } } },
};

async function chain() {
  const skin = skinOf(await readGLTF(toGLB(fixture())));
  const parts = fitToMeshParts(skin, { percentile: 1 });
  return { skeleton: skin.skeleton, objects: { j0: parts.get(0), j1: parts.get(1) } };
}

/** Compile a stage, its model given as the file `modelRef` names, the rest read from scenes/. */
async function compile(spec, model, modelRef) {
  const files = await loadReferences(spec, { from: STAGE, readText: (p) => readFileSync(p, 'utf8'), warn: () => {} });
  files[join(SCENES, modelRef.slice(1))] = model;
  const warned = [];
  const built = compileScene(spec, { files, path: STAGE, warn: (path, msg) => warned.push(`${path}: ${msg}`) });
  return { built, warned };
}

test('a model on the floor, its parts referred to in its file, posed; at rest without a clip', async () => {
  const m = await chain();
  const rest = stageSpec(m, { modelRef: '@chain.json', clips: CLIPS, materials: [{ 'figure-skin': {} }] });
  assert.deepEqual(rest.materials[0], '@lib/materials.json');
  assert.equal(rest.root.material, 'floor');
  assert.deepEqual(rest.root.outside.group.map((part) => part.group[0]), ['@chain.json#/objects/j0', '@chain.json#/objects/j1']);
  const bent = stageSpec(m, { modelRef: '@chain.json', clips: CLIPS, clip: 'Bend', t: 1, materials: [{ 'figure-skin': {} }] });
  assert.ok(bent.root.outside.group[1].rotate, 'j1\'s part turned');
  for (const spec of [rest, bent]) {
    const { built, warned } = await compile(spec, m, '@chain.json');
    assert.deepEqual(warned, []);
    assert.ok(built.nodes.length > 3, 'the floor and both parts');
  }
});

test('a clip that isn\'t there: warned of, and the model at rest', async () => {
  const m = await chain();
  const warned = [];
  const spec = stageSpec(m, { modelRef: '@chain.json', clips: CLIPS, clip: 'Dance', t: 0.3, warn: (msg) => warned.push(msg) });
  assert.deepEqual(spec, stageSpec(m, { modelRef: '@chain.json', clips: CLIPS }));
  assert.deepEqual(warned, ['model: no clip "Dance" (has Bend): at rest']);
});

test('a model without a skeleton is shown as it is, framed by its dimensions', () => {
  const tet = { _meta: { dimensions: [2, 2, 4] }, spheroid: { center: [0, 0, 2], radii: [1, 1, 2] } };
  const spec = stageSpec(tet, { modelRef: '@parts/tet.json' });
  assert.deepEqual(spec.root.outside, { use: '@parts/tet.json' });
  assert.deepEqual(frameOf(tet).focus, [0, 0, 2]);
});

test('a scene file is shown by its root, with its own objects and materials', async () => {
  const bolt = readJSON('parts/bolt.json');
  const spec = stageSpec(bolt, { modelRef: '@parts/bolt.json' });
  assert.deepEqual(spec.root.outside, { use: '@parts/bolt.json#/root' });
  assert.deepEqual(spec.materials, ['@lib/materials.json', '@parts/bolt.json#/materials']);
  const { built, warned } = await compile(spec, bolt, '@parts/bolt.json');
  assert.deepEqual(warned, []);
  assert.ok(built.nodes.length > 3, 'the bolt, head and shaft');
});

test('the mannequin the viewer opens on: walking, its feet move; it compiles, of its own materials', async () => {
  const model = readJSON('parts/quaternius/mannequin.json');
  const { clips } = readJSON('anim/quaternius/ual.json');
  assert.ok(clips.Walk_Loop && clips.Walk_Loop.loop, 'Walk_Loop, looping');
  const modelRef = '@parts/quaternius/mannequin.json', materials = ['@parts/quaternius/mannequin-materials.json'];
  const { focus, distance } = frameOf(model);
  assert.ok(focus[2] > 0.6 && focus[2] < 1.2, `framed on its middle, ${focus}`);
  assert.ok(distance > 3 && distance < 5, `from ${distance} away`);

  const foot = (spec) => spec.root.outside.group.find((part) => part.group[0].endsWith('/foot_l')).translate;
  const at = (t) => stageSpec(model, { modelRef, clips, clip: 'Walk_Loop', t, materials });
  const [a, b] = [at(0), at(clips.Walk_Loop.duration / 2)];
  const moved = Math.hypot(...foot(a).map((v, i) => v - foot(b)[i]));
  assert.ok(moved > 0.1, `the left foot moved ${moved.toFixed(3)} in half a stride`);
  for (const spec of [stageSpec(model, { modelRef, clips, materials }), a, b]) {
    const { built, warned } = await compile(spec, model, modelRef);
    assert.deepEqual(warned, [], 'every material defined');
    assert.ok(built.nodes.length > 200, `${built.nodes.length} nodes: all of it`);
  }
});

// What fills p, by a compiled tree: an absent inside, the node's material;
// an absent outside, nothing.
function fillAt(built, p) {
  let i = 1;
  while (i) {
    const n = built.nodes[i];
    if (H(n.prim, p) < 0) { if (!n.inside) return built.materials[n.material]?.name ?? n.material; i = n.inside; }
    else i = n.outside;
  }
  return 'empty';
}

test('posed by coefficients alone, the chain compiled once fills every point as the posed group recompiled does', async () => {
  const model = readJSON('parts/quaternius/mannequin.json');
  const { clips } = readJSON('anim/quaternius/ual.json');
  const modelRef = '@parts/quaternius/mannequin.json', materials = ['@parts/quaternius/mannequin-materials.json'];
  const chain = chainOf(model);
  assert.equal(chain.length, 41, 'every spheroid of 22 parts');
  const once = (await compile(chainSpec(model, chain, { materials }), model, modelRef)).built;
  const nodes = chainNodes(once.nodes, chain);
  assert.equal(nodes.length, 41);
  assert.equal(once.nodes.length - 1, 42, 'the floor and the chain: nothing else');
  const rest = nodes.map((i) => once.nodes[i].prim);
  let seed = 11;
  const random = () => {                       // mulberry32
    seed = (seed + 0x6D2B79F5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  for (const [clip, t] of [[null, 0], ['Walk_Loop', 0.3], ['Sitting_Idle_Loop', 0.5], ['Roll', 0.5], ['Swim_Fwd_Loop', 0.6]]) {
    const posed = { ...once, nodes: once.nodes.slice() };
    const prims = chainPrims(model, chain, rest, { clips, clip, t });
    nodes.forEach((i, k) => { posed.nodes[i] = { ...posed.nodes[i], prim: prims[k] }; });
    const group = (await compile(stageSpec(model, { modelRef, clips, clip, t, materials }), model, modelRef)).built;
    let solid = 0, differ = 0;
    for (let k = 0; k < 20000; k++) {
      const p = [(random() - 0.5) * 2.4, (random() - 0.5) * 2.4, random() * 2.1 - 0.3];
      const a = fillAt(group, p), b = fillAt(posed, p);
      if (a !== 'empty' && a !== 'floor') solid++;
      if (a !== b) differ++;
    }
    assert.ok(solid > 30, `${clip ?? 'rest'}: ${solid} points in the mannequin`);
    assert.equal(differ, 0, `${clip ?? 'rest'}: points filled differently`);
  }
});

test('a model whose parts aren\'t self-contained shapes has no chain: it is posed by recompiling', async () => {
  const m = await chain();
  assert.equal(chainOf(m).length, 2, 'the fixture\'s spheroids chain');
  assert.equal(chainOf({ ...m, objects: { ...m.objects, j1: { spheroid: m.objects.j1.spheroid, inside: { sphere: { radius: 1 } } } } }), null, 'one with an inside');
  assert.equal(chainOf({ ...m, objects: { ...m.objects, j1: { use: 'other' } } }), null, 'one placed by use');
  assert.equal(chainOf({ objects: {} }), null, 'no skeleton');
});

test('grafted into the stage for its reach, the mannequin is right in every pose, above the floor and below it', async () => {
  const model = readJSON('parts/quaternius/mannequin.json');
  const { clips } = readJSON('anim/quaternius/ual.json');
  const materials = ['@parts/quaternius/mannequin-materials.json'];
  const chain = chainOf(model);
  const reach = reachOf(model, chain, clips);
  const size = Math.max(reach.height / 2, reach.radius);
  assert.ok(size > 0.9 && size < 3, `reach ${reach.height.toFixed(2)} by ${reach.radius.toFixed(2)} round ${reach.center.map((v) => v.toFixed(2))}`);
  // Its lowest point: the extent along z of a spheroid of that axis.
  const nz = reach.axis[2] / Math.hypot(...reach.axis), a = reach.height / 2;
  assert.ok(reach.center[2] - Math.sqrt(a * a * nz * nz + reach.radius ** 2 * (1 - nz * nz)) < 0, 'some clip takes it below the floor (Swim)');
  const files = await loadReferences(chainSpec(model, chain, { materials }), { from: STAGE, readText: (p) => readFileSync(p, 'utf8'), warn: () => {} });
  const compileSpec = (spec) => compileScene(spec, { files, path: STAGE, quiet: true });
  const grafted = graftedStage(model, chain, compileSpec, { materials, reach });
  assert.equal(grafted.copies.length, 2, 'above the floor and below it');
  assert.equal(grafted.built.nodes.length - 1, 1 + (1 + 41) * 2 + 1, 'the floor, two wrapped chains of 41, the filler');
  const floor = compileSpec(emptyStage(model, { materials }));
  let seed = 5;
  const random = () => {                       // mulberry32
    seed = (seed + 0x6D2B79F5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  for (const [clip, t] of [[null, 0], ['Walk_Loop', 0.3], ['Swim_Fwd_Loop', 0.6], ['Swim_Idle_Loop', 1.0], ['Sitting_Idle_Loop', 0.5], ['Roll', 0.5]]) {
    const prims = chainPrims(model, chain, grafted.rest, { clips, clip, t });
    const posed = { ...grafted.built, nodes: grafted.built.nodes.slice() };
    grafted.nodes.forEach((copies, k) => copies.forEach((i) => { posed.nodes[i] = { ...posed.nodes[i], prim: prims[k] }; }));
    // The reference: the posed model alone where it is, and the floor where it isn't.
    const alone = compileSpec({ materials: ['@lib/materials.json', ...materials], lights: [], root: poseModel(model, clips, clip, t) });
    let below = 0, differ = 0;
    for (let k = 0; k < 20000; k++) {
      const p = [(random() - 0.5) * 2.4, (random() - 0.5) * 2.4, random() * 2.4 - 0.6];
      const mine = fillAt(alone, p), want = mine !== 'empty' ? mine : fillAt(floor, p);
      if (mine !== 'empty' && p[2] < 0) below++;
      if (fillAt(posed, p) !== want) differ++;
    }
    assert.equal(differ, 0, `${clip ?? 'rest'}: points filled wrongly`);
    if (clip?.startsWith('Swim')) assert.ok(below > 10, `${clip}: ${below} points of the mannequin below the floor`);
  }
});
