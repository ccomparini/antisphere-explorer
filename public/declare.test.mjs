// Tests for "declare": names the scene binds to values, "$name" anywhere a
// value goes, and references anywhere a value goes too (scene-format.md,
// Declarations). Run with:
//   node --test public/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene } from './antisphere-scene.js';
import { placeAll } from './movers.js';
import { quadricAt as H } from './quadric.js';

const PATH = 'scenes/s.json';
const compile = (spec, files = {}, warned = []) =>
  compileScene({ lights: [], ...spec }, { files, path: PATH, warn: (path, msg) => warned.push(`${path}: ${msg}`) });

/** The material filling p: its name, or 'empty'. */
function fillAt(built, p) {
  let i = 1;
  while (i) {
    const n = built.nodes[i];
    if (H(n.prim, p) < 0) { if (!n.inside) return built.materials[n.material]?.name ?? 'vacuum'; i = n.inside; }
    else i = n.outside;
  }
  return 'empty';
}
const material = (built, name) => built.materials.find((m) => m.name === name);

test('a declared name is its value, at any depth, wherever a value goes', () => {
  const built = compile({
    declare: { r: 0.5, z: 2, centre: [0, 0, '$z'], clay: [0.7, 0.5, 0.4] },
    materials: { clay: { albedo: '$clay' } },
    lights: [{ pos: [0, 0, '$z'], color: [1, 1, 1] }],
    root: { sphere: { center: '$centre', radius: '$r' }, material: 'clay' },
  });
  assert.equal(fillAt(built, [0, 0, 2.4]), 'clay', 'within 0.5 of (0, 0, 2)');
  assert.equal(fillAt(built, [0, 0, 2.6]), 'empty');
  assert.deepEqual(material(built, 'clay').albedo, [0.7, 0.5, 0.4], 'in a material');
  assert.deepEqual(built.lights[0].pos, [0, 0, 2], 'in a light');
});

test('a name for an object, a material, a subtree; one naming another', () => {
  const built = compile({
    declare: { which: 'ball', stuff: 'clay', also: '$stuff' },
    materials: { clay: {} },
    objects: { ball: { sphere: { center: [0, 0, 0], radius: 1 } } },
    root: { sphere: { center: [0, 0, 0], radius: 9 }, material: '$also', inside: { use: '$which', material: '$stuff' } },
  });
  assert.equal(fillAt(built, [0, 0, 0]), 'clay');
  assert.equal(fillAt(built, [0, 0, 5]), 'empty', 'a use is its inside: empty round the ball');
});

test('a name nothing declares is warned of and left out; one naming itself is said plainly', () => {
  const warned = [];
  const built = compile({ declare: {}, materials: { clay: {} },
                          root: { sphere: { center: [0, 0, 0], radius: '$nope' }, material: 'clay' } }, {}, warned);
  assert.ok(warned.some((w) => /"\$nope": no such name declared/.test(w)), warned.join('; '));
  assert.equal(fillAt(built, [0, 0, 0.9]), 'clay', 'the radius its default, 1');
  assert.throws(() => compile({ declare: { a: '$b', b: '$a' }, materials: { clay: {} },
                                root: { sphere: { center: [0, 0, 0], radius: '$a' }, material: 'clay' } }),
                /names itself, by way of \$a -> \$b -> \$a/);
});

test('a reference wherever a value goes: a point, a whole shape', () => {
  const files = { 'scenes/shapes.json': { points: { a: [3, 0, 0] }, ball: { center: [0, 3, 0], radius: 1 } } };
  const built = compile({ materials: { clay: {} }, root: { group: [
    { sphere: { center: '@shapes.json#/points/a', radius: 1 }, material: 'clay' },
    { sphere: '@shapes.json#/ball', material: 'clay' },
  ] } }, files);
  assert.equal(fillAt(built, [3, 0, 0]), 'clay');
  assert.equal(fillAt(built, [0, 3, 0]), 'clay');
});

test('a declared reference is followed from the scene, where it was written, wherever it is used', () => {
  // The tower is in parts/, and names "$trim" and "$size": what the scene
  // declares - its trim a reference, written in the scene, so lib/ is
  // scenes/lib/, not scenes/parts/lib/.
  const files = {
    'scenes/parts/tower.json': { sphere: { center: [0, 0, 0], radius: '$size' }, material: '$trim' },
    'scenes/lib/metals.json': { gold: { albedo: [1, 0.8, 0.2] } },
  };
  const warned = [];
  const built = compile({ declare: { trim: '@lib/metals.json#/gold', size: 2 },
                          root: { use: '@parts/tower.json' } }, files, warned);
  assert.deepEqual(warned, []);
  assert.equal(fillAt(built, [0, 0, 1.9]), 'scenes/lib/metals.json#/gold');
  assert.deepEqual(material(built, 'scenes/lib/metals.json#/gold').albedo, [1, 0.8, 0.2]);
});

test('a placed object reads the scene\'s names; a drop works with them', () => {
  const spec = { declare: { r: 0.4 }, materials: { clay: {}, floor: {} }, lights: [],
                 objects: { pebble: { sphere: { center: [0, 0, 0], radius: '$r' }, material: 'clay' } },
                 root: { group: [{ plane: { normal: [0, 0, 1], offset: 0 }, material: 'floor' },
                                 { place: 'pebble', translate: [0, 0, 1] }] } };
  const built = compileScene(spec, { path: PATH, quiet: true });
  const { built: placed } = placeAll(built, spec, { path: PATH, quiet: true });
  assert.equal(fillAt(placed, [0, 0, 1.35]), 'clay', 'within $r');
  assert.equal(fillAt(placed, [0, 0, 1.45]), 'empty');

  // Dropped from 3 onto the floor: its bottom, $r below its centre, comes to rest at 0.
  const dropped = compile({ declare: { r: 0.4 }, materials: { clay: {}, floor: {} }, root: { group: [
    { plane: { normal: [0, 0, 1], offset: 0 }, material: 'floor' },
    { sphere: { center: [0, 0, 3], radius: '$r' }, material: 'clay', drop: true },
  ] } });
  assert.equal(fillAt(dropped, [0, 0, 0.75]), 'clay', 'resting with its centre at $r');
  assert.equal(fillAt(dropped, [0, 0, 0.85]), 'empty');
});
