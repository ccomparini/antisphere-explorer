// Tests for expressions: a string starting = worked out - over numbers,
// vectors, lists and declared names (scene-format.md, Expressions). Run with:
//   node --test public/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene, evaluateExpression, parseExpression } from './antisphere-scene.js';
import { quadricAt as H } from './quadric.js';

const value = (text, names = {}) => evaluateExpression(parseExpression(text), (n) => names[n]);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const PATH = 'scenes/s.json';
const compile = (spec, warned = []) =>
  compileScene({ lights: [], ...spec }, { path: PATH, warn: (path, msg) => warned.push(`${path}: ${msg}`) });
// What an expression comes to in a scene: carried through its camera, which
// comes back as written.
const inScene = (expr, extra = {}, warned = []) =>
  compile({ materials: {}, root: { sphere: { center: [0, 0, 0], radius: 1 } }, camera: { v: expr }, ...extra }, warned).camera.v;

function fillAt(built, p) {
  let i = 1;
  while (i) {
    const n = built.nodes[i];
    if (H(n.prim, p) < 0) { if (!n.inside) return built.materials[n.material]?.name ?? 'vacuum'; i = n.inside; }
    else i = n.outside;
  }
  return 'empty';
}

test('arithmetic: precedence, left to right, unary minus, and % never negative', () => {
  assert.equal(value('1 + 2 * 3'), 7);
  assert.equal(value('(1 + 2) * 3'), 9);
  assert.equal(value('10 - 2 - 3'), 5);
  assert.equal(value('2 * 3 % 4'), 2);
  assert.equal(value('-2 * -3'), 6);
  assert.equal(value('-1 % 5'), 4);
  assert.equal(value('7 % 5'), 2);
  assert.equal(value('1.5e2 / .5'), 300);
});

test('vectors element by element, a number standing for every element; lists indexed round', () => {
  assert.deepEqual(value('[1, 2, 3] + [10, 20, 30]'), [11, 22, 33]);
  assert.deepEqual(value('[1, 2, 3] * 2'), [2, 4, 6]);
  assert.deepEqual(value('1 - [1, 2]'), [0, -1]);
  assert.deepEqual(value('-[1, -2]'), [-1, 2]);
  assert.equal(value('[5, 6, 7][1]'), 6);
  assert.equal(value('$s[5]', { s: ['a', 'b', 'c'] }), 'c', 'round again');
  assert.equal(value('$s[-1]', { s: ['a', 'b', 'c'] }), 'c');
  assert.equal(value('[[1, 2], [3, 4]][1][0]'), 3);
  assert.equal(value('"gold"'), 'gold');
});

test('functions in degrees; pi; names, with - joining words', () => {
  near(value('sin(30)'), 0.5);
  near(value('cos(60)'), 0.5);
  near(value('tan(45)'), 1);
  near(value('asin(0.5)'), 30);
  near(value('acos(0.5)'), 60);
  near(value('atan2(1, 1)'), 45);
  near(value('sqrt(2) * sqrt(2)'), 2);
  assert.deepEqual([value('abs(-3)'), value('floor(2.7)'), value('round(2.5)'), value('min(4, 2, 3)'), value('max(4, 2, 3)')], [3, 2, 3, 2, 4]);
  near(value('pi'), Math.PI);
  assert.deepEqual(value('cos([0, 60])'), [1, 0.5000000000000001]);
  assert.equal(value('$step-height * 2', { 'step-height': 0.25 }), 0.5);
  assert.equal(value('$a-1', { a: 3 }), 2, '$a minus 1');
});

test('mistakes are said: where, and what', () => {
  for (const [text, said] of [
    ['1 +', /expected a value, at column 4/],
    ['(1 + 2', /expected "\)"/],
    ['2 ** 3', /unexpected "\*", at column 4/],
    ['foo + 1', /"foo" isn't a value/],
    ['bar(1)', /"bar" isn't a function there is/],
    ['$nope', /"\$nope": no such name declared/],
    ['[1, 2] + [1, 2, 3]', /vectors of 2 and 3/],
    ['3[0]', /only a list can be/],
    ['[1, 2][0.5]', /a whole number only/],
  ]) assert.throws(() => value(text), said, text);
});

test('in a scene: wherever a value goes, its names the declarations; a mistake warned of, the default used', () => {
  assert.equal(inScene('=360 / $steps', { declare: { steps: 12 } }), 30);
  assert.deepEqual(inScene('=[0, 0, $k * $rise]', { declare: { k: 3, rise: 0.25 } }), [0, 0, 0.75]);
  assert.equal(inScene('=$w * 2', { declare: { w: '=360 / $n', n: 8 } }), 90, 'a declared expression');
  const warned = [];
  const built = compile({ materials: { clay: {} }, root: { sphere: { center: [0, 0, 0], radius: '=1 / 0' }, material: 'clay' } }, warned);
  assert.ok(warned.some((w) => /"=1 \/ 0" comes to null, not a number/.test(w)), warned.join('; '));
  assert.equal(fillAt(built, [0, 0, 0.9]), 'clay', 'the radius its default, 1');
  const cycle = [];
  compile({ declare: { a: '=$b + 1', b: '=$a + 1' }, materials: {}, root: { sphere: { center: [0, 0, 0], radius: '$a' } } }, cycle);
  assert.ok(cycle.some((w) => /names itself, by way of/.test(w)), cycle.join('; '));
});

test('in a repeat: its range names put into expressions; a material picked by expression', () => {
  const built = compile({
    declare: { stones: ['gold', 'brass', 'sand'] },
    materials: { gold: {}, brass: {}, sand: {} },
    root: { union: [{ repeat: { times: 6, range: { k: { start: 0 } }, repetend: {
      sphere: { center: ['=$k * 2', 0, 0], radius: 0.5 }, material: '=$stones[$k]' } } }] },
  });
  ['gold', 'brass', 'sand', 'gold', 'brass', 'sand'].forEach((m, k) => assert.equal(fillAt(built, [2 * k, 0, 0]), m, `ball ${k}`));
  assert.equal(fillAt(built, [1, 0, 0]), 'empty');
});

test('a grid\'s materials going round diagonally: one expression, as each row\'s own list did', () => {
  // The default scene's beads, small: 8 x 8 balls, the stone (i + j - 1)
  // mod 5. Before expressions, each row carried its own turn of the five.
  const C = ['brass-5', 'jade', 'rose', 'slate-2', 'stone-8'];
  const materials = Object.fromEntries(C.map((m) => [m, {}]));
  const grid = (outerRange, innerRange, material) => compile({ materials, root: { group: [{ repeat: {
    times: 8, range: { y: { start: 0, step: 1.5 }, ...outerRange },
    repetend: { repeat: { times: 8, range: { x: { start: 0, step: 1.5 }, ...innerRange },
      repetend: { sphere: { center: ['$x', '$y', 0], radius: 0.5 }, material } } },
  } }] } });
  const rows = [0, 1, 2, 3, 4].map((k) => C.map((_, i) => C[(i + k + 4) % 5]));
  const lists = grid({ row: rows }, { stone: '$row' }, '$stone');
  const expression = grid({ j: { start: 0 } }, { i: { start: 0 } }, `=${JSON.stringify(C)}[$i + $j - 1]`);
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
    const p = [1.5 * i, 1.5 * j, 0];
    assert.equal(fillAt(expression, p), C[(i + j + 4) % 5], `ball ${i}, ${j}`);
    assert.equal(fillAt(expression, p), fillAt(lists, p), `ball ${i}, ${j}, as the lists`);
  }
});

test('a spiral stair of fixed-width treads, their width 360 / steps', () => {
  const steps = 12;
  const built = compile({
    declare: { steps, rise: 0.18 },
    materials: { stone: {} },
    root: { intersection: [
      { cylinder: { center: [0, 0, 0], axis: [0, 0, 1], radius: 1.1 } },
      { union: [{ repeat: { times: '$steps', range: { k: { start: 0 } }, repetend: {
        material: 'stone',
        intersection: [
          { slab: { center: [0, 0, -0.03], axis: [0, 0, 1], thickness: 0.06 } },
          { plane: { normal: [0, -1, 0] } },
          { plane: { normal: [0, 1, 0] }, rotate: { axis: [0, 0, 1], degrees: '=360 / $steps' } },
        ],
        rotate: { axis: [0, 0, 1], degrees: '=$k * 360 / $steps' },
        translate: '=[0, 0, $k * $rise]',
      } } }] },
    ] },
  });
  for (let k = 0; k < steps; k++) {
    const a = (k + 0.5) * 2 * Math.PI / steps, z = k * 0.18 - 0.03;
    assert.equal(fillAt(built, [0.7 * Math.cos(a), 0.7 * Math.sin(a), z]), 'stone', `tread ${k}, in the middle of its sector`);
    assert.equal(fillAt(built, [0.7 * Math.cos(a), 0.7 * Math.sin(a), z + 0.09]), 'empty', `above tread ${k}`);
  }
});
