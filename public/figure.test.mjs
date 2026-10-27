// Tests for posing a model by a clip, on the tiny model in gltf-fixture.mjs:
// three joints up glTF's +y (the scene's +z), and a clip, "Bend", that turns
// j1 90 degrees about glTF's z and steps j0 a unit along glTF's x. Run with:
//   node --test public/figure.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGLTF } from './gltf.js';
import { fixture, toGLB } from './gltf-fixture.mjs';
import { skinOf, fitToMeshParts } from './skin.js';
import { poseModel, partsOf } from './figure.js';
import { compileScene } from './antisphere-scene.js';

const near = (got, want, what, tol = 1e-6) => {
  [want].flat().forEach((w, i) => assert.ok(Math.abs([got].flat()[i] - w) <= tol, `${what}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`));
};
const s = Math.SQRT1_2;
const CLIPS = {
  Bend: { duration: 1, channels: {
    j1: { rotation: { times: [0, 1], values: [[0, 0, 0, 1], [0, 0, s, s]] } },
    j0: { translation: { times: [0, 1], values: [[0, 0, 0], [1, 0, 0]], interpolation: 'step' } },
    finger: { rotation: { times: [0], values: [[0, 0, 1, 0]] } },          // a bone the model hasn't
  } },
};
async function model(extra = {}) {
  const skin = skinOf(await readGLTF(toGLB(fixture())));
  const parts = fitToMeshParts(skin, { percentile: 1 });
  return { skeleton: skin.skeleton, objects: { j0: parts.get(0), j1: parts.get(1), ...extra } };
}

// Where a posed part's spheroid ends up: its rotate, then its translate.
function placed(part) {
  const inner = part.group[0], sph = (inner.group ?? [inner])[0].spheroid;
  let c = sph.center;
  if (part.rotate) {
    const { axis: [x, y, z], radians: a } = part.rotate, cs = Math.cos(a), sn = Math.sin(a), d = x * c[0] + y * c[1] + z * c[2];
    const cr = [y * c[2] - z * c[1], z * c[0] - x * c[2], x * c[1] - y * c[0]];
    c = c.map((v, i) => v * cs + cr[i] * sn + [x, y, z][i] * d * (1 - cs));
  }
  return c.map((v, i) => v + part.translate[i]);
}

test('at rest a model is as written; bent, each part goes where its bone takes it', async () => {
  const m = await model();
  const rest = poseModel(m, CLIPS);
  near(placed(rest.group[0]), [0, 0, 0.5], 'j0\'s part, at rest');
  near(placed(rest.group[1]), [0, 0, 1.6], 'j1\'s');
  const bent = poseModel(m, CLIPS, 'Bend', 1);
  near(placed(bent.group[0]), [1, 0, 0.5], 'j0\'s, stepped a unit along x');
  near(placed(bent.group[1]), [0.4, 0, 1], 'j1\'s, bent over from j1, which stepped too');
  near(placed(poseModel(m, CLIPS, 'Bend', 0.5).group[0]), [0, 0, 0.5], 'halfway: the step not taken yet');
  const built = compileScene({ materials: { 'figure-skin': {} }, lights: [], root: bent });
  assert.ok(built.nodes.length > 2, 'a posed model compiles');
});

test('a model\'s scale scales its clips\' translations', async () => {
  const m = { ...(await model()), scale: 2 };
  near(placed(poseModel(m, CLIPS, 'Bend', 1).group[0]), [2, 0, 0.5], 'stepped two units');
});

test('parts by name or "bone"; helpers and assemblies left as they are; anything else on the root, warned', async () => {
  const ball = { sphere: { center: [0, 0, 1.6], radius: 0.1 }, material: 'figure-skin' };
  const m = await model({
    rivet: ball,                                                  // a helper: used by the glove
    glove: { bone: 'j1', group: ['rivet'] },                      // rides j1, by its "bone"
    whole: { group: ['j0', '@#/objects/j1', 'glove'] },           // an assembly, by name or within the file
    stray: { sphere: { center: [0, 0, 0], radius: 0.1 } },        // none of these
    lost: { bone: 'j9', sphere: { center: [0, 0, 0], radius: 0.1 } },
  });
  const warned = [];
  const parts = partsOf(m, { warn: (msg) => warned.push(msg) });
  assert.deepEqual([...parts].sort(), [['glove', 1], ['j0', 0], ['j1', 1], ['lost', 0], ['stray', 0]].sort());
  assert.deepEqual(warned.sort(), [
    'model: objects.lost names a bone "j9" the skeleton hasn\'t: on the root',
    'model: objects.stray names no bone, and nothing uses it: on the root',
  ]);
});

test('a clip the model hasn\'t: warned once, and the model at rest', async () => {
  const m = await model();
  const warned = [];
  const rest = poseModel(m, CLIPS);
  for (let i = 0; i < 3; i++) assert.deepEqual(poseModel(m, CLIPS, 'Dance', 0.5, { warn: (msg) => warned.push(msg) }), rest);
  assert.deepEqual(warned, ['model: no clip "Dance" (has Bend): at rest']);
});
