// Tests for materials as the scene compiler reads them. Run with:
//   node --test public/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene } from './antisphere-scene.js';

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
