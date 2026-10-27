// Tests for grafting a mover into a compiled scene (movers.js): wherever it
// is within its reach, the scene with it grafted in is filled as "the mover
// where it is, and the scene where it isn't". Run with:
//   node --test public/movers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene, movePrim, envAt } from './antisphere-scene.js';
import { quadricAt as H } from './quadric.js';
import { graftMover } from './movers.js';

const MATERIALS = { floor: {}, water: { kind: 'ambient', albedo: [0.1, 0.2, 0.4] }, wall: {}, a: {}, b: {} };
// A reach that is a ball, as a spheroid: height twice its radius.
const ball = (center, r) => ({ center, axis: [0, 0, 1], height: 2 * r, radius: r });
const compile = (root) => compileScene({ materials: MATERIALS, lights: [], root }, { quiet: true });

/** What fills p: an absent inside, the node's material; an absent outside, nothing. */
function fillAt(built, p) {
  let i = 1;
  while (i) {
    const n = built.nodes[i];
    if (H(n.prim, p) < 0) { if (!n.inside) return built.materials[n.material]?.name ?? 'vacuum'; i = n.inside; }
    else i = n.outside;
  }
  return 'empty';
}

// A mover of two balls, from a compiled chain of them.
function mover() {
  const shapes = compile({ sphere: { center: [0, 0, 0], radius: 0.4 }, material: 'a',
                           outside: { sphere: { center: [0.6, 0, 0], radius: 0.3 }, material: 'b' } });
  return { prims: [shapes.nodes[1].prim, shapes.nodes[2].prim], materials: [shapes.nodes[1].material, shapes.nodes[2].material], built: shapes };
}

// The mover moved by `translate`, written into every copy, against the
// reference: the mover moved, alone, where it is; else the scene.
function check(scene, grafted, m, translate, what) {
  const moved = { ...grafted.built, nodes: grafted.built.nodes.slice() };
  grafted.nodes.forEach((copies, k) => copies.forEach((i) => { moved.nodes[i] = { ...moved.nodes[i], prim: movePrim(m.prims[k], { translate }) }; }));
  const alone = { ...m.built, nodes: m.built.nodes.map((n, i) => (i ? { ...n, prim: movePrim(n.prim, { translate }) } : n)) };
  let differ = 0, inMover = 0;
  for (let x = -2; x <= 2; x += 0.1) for (let z = -1.5; z <= 1.5; z += 0.1) for (const y of [-0.1, 0, 0.13]) {
    const p = [x, y, z], mine = fillAt(alone, p), want = mine !== 'empty' ? mine : fillAt(scene, p);
    if (mine !== 'empty') inMover++;
    if (fillAt(moved, p) !== want) differ++;
  }
  assert.ok(inMover > 20, `${what}: the mover is in the probed box`);
  assert.equal(differ, 0, `${what}: points filled wrongly`);
}

test('a floor straddled: a copy above, ending in nothing, and one below, ending in the floor; right wherever it moves in its reach', () => {
  const scene = compile({ plane: { normal: [0, 0, 1], offset: 0 }, material: 'floor' });
  const m = mover();
  const grafted = graftMover(scene, m, { reach: ball([0.3, 0, 0], 1.2) });
  assert.equal(grafted.copies.length, 2);
  assert.equal(grafted.built.nodes.length - 1, 1 + 2 * (1 + 2) + 1, 'the floor, two wrapped copies, and the filler');
  assert.equal(scene.nodes.length - 1, 1, 'the compiled scene itself left alone');
  for (const t of [[0, 0, 0], [0, 0, 0.5], [0, 0, -0.5], [0.3, 0, -0.2]]) check(scene, grafted, m, t, `moved ${t}`);
  // Unwrapped, the same, two nodes fewer.
  const bare = graftMover(scene, m, { reach: ball([0.3, 0, 0], 1.2), wrap: false });
  assert.equal(bare.built.nodes.length - 1, 1 + 2 * 2 + 1);
  for (const t of [[0, 0, 0], [0.3, 0, -0.2]]) check(scene, bare, m, t, `unwrapped, moved ${t}`);
});

test('a reach on one side of a surface takes one copy, there', () => {
  const scene = compile({ plane: { normal: [0, 0, 1], offset: 0 }, material: 'floor' });
  const m = mover();
  const above = graftMover(scene, m, { reach: ball([0.3, 0, 1], 0.8) });
  assert.equal(above.copies.length, 1);
  const wrapper = above.built.nodes[above.built.nodes[1].outside];
  assert.equal(wrapper.inside, above.copies[0], 'in the floor\'s outside, in its wrapper');
  assert.equal(wrapper.outside, 0, 'which goes on to what was there: nothing');
  check(scene, above, m, [0, 0, 1], 'above');
});

test('an elongated reach takes fewer copies than the ball round it would', () => {
  // A wall beside a standing figure: its tall, thin reach is clear of the
  // wall; the ball round it is not. The mover (x from -0.4 to 0.9) fits in both.
  const scene = compile({ plane: { normal: [0, 0, 1], offset: 0 }, material: 'floor',
                          outside: { slab: { center: [1.5, 0, 1], axis: [1, 0, 0], thickness: 0.2 }, material: 'wall' } });
  const m = mover();
  const tall = graftMover(scene, m, { reach: { center: [0.25, 0, 1], axis: [0, 0, 1], height: 3, radius: 1 } });
  const round = graftMover(scene, m, { reach: ball([0.25, 0, 1], 1.5) });
  assert.equal(tall.copies.length, 2, 'above the floor and below: the wall is clear');
  assert.equal(round.copies.length, 3, 'and in the wall too');
  check(scene, tall, m, [0, 0, 0.3], 'tall');
  check(scene, round, m, [0, 0, 0.3], 'round');
});

test('a copy in an ambient region is in its env, and inside a node with children goes down among them', () => {
  // Water: a ball of ambient material, with a wall in it; the mover in the water.
  const scene = compile({ sphere: { center: [0, 0, 0], radius: 5 }, material: 'water',
                          inside: { slab: { center: [3, 0, 0], axis: [1, 0, 0], thickness: 0.5 }, material: 'wall' } });
  const m = mover();
  const grafted = graftMover(scene, m, { reach: ball([0, 0, 0], 1.5) });
  assert.equal(grafted.copies.length, 1, 'the wall\'s outside only: the reach is clear of it');
  // A hit on the mover is lit as the water is: found by where it is.
  assert.equal(envAt(grafted.built, [0.6, 0, 0]), 1, 'in the mover\'s second ball, the water\'s env');
  assert.equal(envAt(grafted.built, [0.6, 0, 9]), 0, 'and out of the water, none');
  check(scene, grafted, m, [0.2, 0, 0.3], 'in the water');
});

test('a subtree that would take more copies than the budget takes one, in front of it', () => {
  // Six slabs, nested, each straddled: every one doubles the copies.
  let tree = null;
  for (let k = 5; k >= 0; k--) tree = { slab: { center: [0, 0, 0], axis: [Math.cos(k), Math.sin(k), 0.3], thickness: 0.2 + k * 0.1 }, material: 'wall', ...(tree ? { outside: tree } : {}) };
  const scene = compile({ plane: { normal: [0, 0, 1], offset: -1.4 }, material: 'floor', outside: tree });
  const m = mover();
  const grafted = graftMover(scene, m, { reach: ball([0, 0, 0], 1), budget: 4 });
  assert.ok(grafted.copies.length <= 4, `${grafted.copies.length} copies`);
  check(scene, grafted, m, [0.1, 0, 0.1], 'among the slabs');
});
