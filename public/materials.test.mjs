// Tests for materials as the scene compiler reads them. Run with:
//   node --test public/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene } from './antisphere-scene.js';
import { quadricAt } from './quadric.js';

const withFloor = (floor) => ({
  materials: { floor },
  lights: [],
  root: { plane: { normal: [0, 0, 1], offset: 0 }, material: 'floor' },
});
const floorOf = (spec) => compileScene(spec).materials.find((m) => m.pattern !== 0);

test('a checker\'s scale is its tile size, passed through as given (1 by default)', () => {
  // The shader divides surface coordinates by it, so larger is bigger tiles.
  assert.equal(floorOf(withFloor({ pattern: 'checker', scale: 2.5 })).scale, 2.5);
  assert.equal(floorOf(withFloor({ pattern: 'checker' })).scale, 1);
});

test('scale must be a positive number', () => {
  for (const scale of [0, -1, 'big', Infinity]) {
    assert.throws(() => compileScene(withFloor({ pattern: 'checker', scale })),
                  /materials\.floor\.scale: must be a positive number/, String(scale));
  }
});

// The material filling a point: the tree walked as trace() walks it.
function materialAt(built, p) {
  let index = 1;
  while (index) {
    const n = built.nodes[index];
    if (quadricAt(n.prim, p) < 0) {
      if (!n.inside) return built.materials[n.material].name ?? null;
      index = n.inside;
    } else {
      index = n.outside;
    }
  }
  return null;
}

test('a material on a use is that use\'s alone: the object\'s tree, shared, is left as it was', () => {
  // As teapots.json does it: three uses of one object, the first untouched.
  const ball = { sphere: { center: [0, 0, 0], radius: 1 } };
  const spec = {
    materials: { jade: {}, gold: {}, brass: {} }, lights: [],
    objects: { pot: { use: 'shape', material: 'jade' }, shape: ball },
    root: { group: [
      { use: 'pot' },
      { use: 'pot', material: 'gold', translate: [5, 0, 0] },
      { use: 'pot', material: 'brass', translate: [0, 5, 0] },
    ] },
  };
  const built = compileScene(spec, { quiet: true });
  assert.equal(materialAt(built, [0, 0, 0]), 'jade', 'the first, untransformed: the object\'s own');
  assert.equal(materialAt(built, [5, 0, 0]), 'gold');
  assert.equal(materialAt(built, [0, 5, 0]), 'brass');
  // The same with the first use transformed, and the others untransformed.
  spec.root.group = [
    { use: 'pot', translate: [0, 0, 0.5] },
    { use: 'pot', material: 'gold', translate: [5, 0, 0] },
    { use: 'pot', material: 'brass' },
  ];
  const again = compileScene(spec, { quiet: true });
  assert.equal(materialAt(again, [0, 0, 0.5]), 'jade');
  assert.equal(materialAt(again, [5, 0, 0]), 'gold');
  // (The third sits on the first: the earlier claim stands, as in any group.)
});

test('a material on a use goes on the root it makes; a node naming its own keeps it', () => {
  // A shell naming nothing round a core of steel: the use names the shell.
  // (The shell is the inner sphere complemented, inside the outer; the core
  // its outside.)
  const core = { sphere: { center: [0, 0, 0], radius: 1 }, material: 'steel' };
  const built = compileScene({
    materials: { steel: {}, iron: {} }, lights: [],
    objects: { bolt: { sphere: { center: [0, 0, 0], radius: 2 },
                       inside: { sphere: { center: [0, 0, 0], radius: 1, complement: true }, outside: core } } },
    root: { use: 'bolt', material: 'iron' },
  }, { quiet: true });
  assert.equal(materialAt(built, [0, 0, 0]), 'steel', 'the core');
  assert.equal(materialAt(built, [1.5, 0, 0]), 'iron', 'the shell');
});
