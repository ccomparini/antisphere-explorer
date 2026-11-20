// Tests for "repeat": copies of a repetend spliced into a list, each with
// its range's values put in (scene-format.md, "repeat"). Run with:
//   node --test public/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene } from './antisphere-scene.js';
import { quadricAt as H } from './quadric.js';

const PATH = 'scenes/s.json';
const compile = (spec, files = {}, warned = []) =>
  compileScene({ lights: [], ...spec }, { files, path: PATH, warn: (path, msg) => warned.push(`${path}: ${msg}`) });
// What a list expands to: carried through the scene's camera, which comes
// back from the compiler as written.
const expand = (list, extra = {}, warned = []) => compile({
  materials: {}, root: { sphere: { center: [0, 0, 0], radius: 1 } }, camera: { list }, ...extra }, {}, warned).camera.list;

function fillAt(built, p) {
  let i = 1;
  while (i) {
    const n = built.nodes[i];
    if (H(n.prim, p) < 0) { if (!n.inside) return built.materials[n.material]?.name ?? 'vacuum'; i = n.inside; }
    else i = n.outside;
  }
  return 'empty';
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('the numbers 1 to 6, then "beagle" three times: nine elements', () => {
  assert.deepEqual(expand([
    { repeat: { _comment: 'the numbers 1 through 6', range: { num: { start: 1, end: 6 } }, repetend: '$num' } },
    { repeat: { times: 3, repetend: 'beagle' } },
  ]), [1, 2, 3, 4, 5, 6, 'beagle', 'beagle', 'beagle']);
});

test('each kind of range: a list cycling, start and step, start to end (both included), vectors', () => {
  assert.deepEqual(expand([{ repeat: { times: 5, range: { s: ['gold', 'brass', 'sand'] }, repetend: '$s' } }]),
                   ['gold', 'brass', 'sand', 'gold', 'brass']);
  assert.deepEqual(expand([{ repeat: { times: 4, range: { x: { start: 2, step: 0.5 } }, repetend: '$x' } }]), [2, 2.5, 3, 3.5]);
  assert.deepEqual(expand([{ repeat: { times: 3, range: { x: { start: 7 } }, repetend: '$x' } }]), [7, 8, 9], 'step 1 by default');
  const turns = expand([{ repeat: { times: 13, range: { a: { start: 360, end: 0 } }, repetend: '$a' } }]);
  assert.equal(turns.length, 13);
  turns.forEach((a, k) => close(a, 360 - 30 * k));
  assert.deepEqual(expand([{ repeat: { range: { x: { start: 0, end: 1, step: 0.25 } }, repetend: '$x' } }]), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(expand([{ repeat: { times: 3, range: { p: { start: [0, 0, 0], step: [1, 0, 0.5] } }, repetend: '$p' } }]),
                   [[0, 0, 0], [1, 0, 0.5], [2, 0, 1]]);
  assert.deepEqual(expand([{ repeat: { times: 3, range: { p: { start: [0, 0, 0], end: [4, 2, 0] } }, repetend: '$p' } }]),
                   [[0, 0, 0], [2, 1, 0], [4, 2, 0]]);
});

test('times: given, from the longest list, or a declared name; range values may be declared names', () => {
  assert.deepEqual(expand([{ repeat: { range: { a: [1, 2], b: ['x', 'y', 'z'] }, repetend: ['$a', '$b'] } }]),
                   [[1, 'x'], [2, 'y'], [1, 'z']], 'three, the longest; the shorter cycling');
  assert.deepEqual(expand([{ repeat: { times: '$n', range: { h: { start: 0, step: '$rise' } }, repetend: '$h' } }],
                          { declare: { n: 3, rise: 0.25 } }), [0, 0.25, 0.5]);
});

test('names: a scene declaration left for later, unless the range shadows it; a repeat inside a repetend', () => {
  assert.deepEqual(expand([{ repeat: { times: 2, range: { k: [1, 2] }, repetend: { k: '$k', r: '$r' } } }],
                          { declare: { r: 9, k: 'shadowed' } }), [{ k: 1, r: 9 }, { k: 2, r: 9 }]);
  assert.deepEqual(expand([{ repeat: { range: { row: [0, 1] }, repetend: { cells: [
    { repeat: { range: { col: [0, 1, 2] }, repetend: ['$row', '$col'] } },
  ] } } }]), [{ cells: [[0, 0], [0, 1], [0, 2]] }, { cells: [[1, 0], [1, 1], [1, 2]] }]);
});

test('a repeat whose repetend is a repeat is one flat list: a grid, row by row', () => {
  assert.deepEqual(expand([{ repeat: { range: { row: [0, 1] }, repetend:
    { repeat: { range: { col: [0, 1, 2] }, repetend: ['$row', '$col'] } } } }]),
  [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]]);
});

test('slips are warned of, and the repeat gives nothing', () => {
  for (const [list, said] of [
    [[{ repeat: { range: { x: { start: 1 } }, repetend: '$x' } }], /needs "times"/],
    [[{ repeat: { times: -1, repetend: 1 } }], /"times" is a whole number/],
    [[{ repeat: { times: 2, range: { x: { start: 1, step: [1, 2] } }, repetend: '$x' } }], /step must be a number/],
    [[{ repeat: { times: 2 } }], /needs a "repetend"/],
  ]) {
    const warned = [];
    assert.deepEqual(expand(list, {}, warned), [], JSON.stringify(list));
    assert.ok(warned.some((w) => said.test(w)), warned.join('; '));
  }
  const warned = [];
  const built = compile({ materials: {}, root: { sphere: { center: [0, 0, 0], radius: 1 } },
                          camera: { where: { repeat: { times: 2, repetend: 1 } } } }, {}, warned);
  assert.ok(!('where' in built.camera), 'not in a list: left out');
  assert.ok(warned.some((w) => /a repeat makes a list, and goes in one/.test(w)), warned.join('; '));
});

test('stairs: five treads, each a step up and along', () => {
  const built = compile({ materials: { stone: {} }, root: { union: [{ repeat: {
    range: { at: { start: [0, 0, 0], step: [0.3, 0, 0.2] } }, times: 5,
    repetend: { slab: { center: [0, 0, 0.1], axis: [0, 0, 1], thickness: 0.2 }, material: 'stone',
                inside: { slab: { center: [0.15, 0, 0], axis: [1, 0, 0], thickness: 0.3 } }, translate: '$at' },
  } }] } });
  for (let k = 0; k < 5; k++) {
    assert.equal(fillAt(built, [0.15 + 0.3 * k, 0, 0.1 + 0.2 * k]), 'stone', `tread ${k}`);
    assert.equal(fillAt(built, [0.15 + 0.3 * k, 0, 0.3 + 0.2 * k]), 'empty', `above tread ${k}`);
  }
});

test('Chris\'s spiral stair compiles, its treads cycling through the stones', () => {
  const warned = [];
  const built = compile({
    declare: { radius: 1.1, 'step-height': 0.18, 'stair-steps': 12 },
    materials: { gold: {}, brass: {}, sand: {} },
    objects: { 'spiral-stair': { intersection: [
      { cylinder: { radius: '$radius' } },
      { union: [{ repeat: {
        times: '$stair-steps',
        range: { angle: { start: 360, end: 0 }, rise: { start: 0, step: '$step-height' }, stone: ['gold', 'brass', 'sand'] },
        repetend: {
          material: '$stone', translate: [0, 0, '$rise'],
          rotate: { pivot: ['$radius', 0, 0], degrees: [0, 0, '$angle'] },
          intersection: [
            { plane: { offset: '$rise' } },
            { plane: { normal: [0, -1, 0] } },
            { plane: { normal: [0, 1, 0] }, rotate: { degrees: [0, 0, '$angle'] } },
            { plane: { offset: 0, normal: [0, 0, -1] } },
          ],
        },
      } }] },
    ] } },
    root: { use: 'spiral-stair' },
  }, {}, warned);
  assert.deepEqual(warned, []);
  const named = new Set(built.nodes.slice(1).map((n) => built.materials[n.material]?.name));
  for (const stone of ['gold', 'brass', 'sand']) assert.ok(named.has(stone), `${stone} among the treads`);
});

test('a repeat in an object from another file expands too', () => {
  const files = { 'scenes/row.json': { union: [{ repeat: { range: { x: [-2, 0, 2] },
    repetend: { sphere: { center: ['$x', 0, 0], radius: 0.5 }, material: 'clay' } } }] } };
  const built = compile({ materials: { clay: {} }, root: { use: '@row.json' } }, files);
  for (const x of [-2, 0, 2]) assert.equal(fillAt(built, [x, 0, 0]), 'clay');
  assert.equal(fillAt(built, [1, 0, 0]), 'empty');
});
