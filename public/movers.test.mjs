// Tests for grafting a mover into a compiled scene (movers.js): wherever it
// is within its reach, the scene with it grafted in is filled as "the mover
// where it is, and the scene where it isn't". Run with:
//   node --test public/movers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene, movePrim, envAt } from './antisphere-scene.js';
import { quadricAt as H } from './quadric.js';
import { graftMover, graftObject, placeAll, placeAllLoading } from './movers.js';
import { loadReferences, referencedFiles } from './antisphere-scene.js';

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

// -- any compiled object, not only a chain ----------------------------------------

// The object moved by `translate`, written into every copy (node k of copy
// c at copies[c] + k - 1), against the reference: the object moved, alone,
// where it is; else the scene.
function checkObject(scene, grafted, object, translate, what) {
  const moved = { ...grafted.built, nodes: grafted.built.nodes.slice() };
  for (const first of grafted.copies) {
    for (let k = 1; k <= grafted.size; k++) {
      moved.nodes[first + k - 1] = { ...moved.nodes[first + k - 1], prim: movePrim(object.nodes[k].prim, { translate }) };
    }
  }
  const alone = { ...object, nodes: object.nodes.map((n, i) => (i ? { ...n, prim: movePrim(n.prim, { translate }) } : n)) };
  let differ = 0, inObject = 0, holes = 0;
  for (let x = -2; x <= 2; x += 0.1) for (let z = -1.5; z <= 1.5; z += 0.1) for (const y of [-0.1, 0, 0.13]) {
    const p = [x, y, z], mine = fillAt(alone, p), want = mine !== 'empty' ? mine : fillAt(scene, p);
    if (mine !== 'empty') inObject++;
    else if (Math.hypot(p[0] - translate[0], p[1] - translate[1], p[2] - translate[2]) < 0.3) holes++;
    if (fillAt(moved, p) !== want) differ++;
  }
  assert.ok(inObject > 20, `${what}: the object is in the probed box`);
  assert.equal(differ, 0, `${what}: points filled wrongly`);
  return { holes };
}

test('a compiled object, hollow, grafted: itself where it is, the scene through its hollow and round it', () => {
  // A shell: a ball of 0.6 with a hole of 0.35 in it - the hole the
  // complemented sphere's outside, absent, so it hands on to the scene.
  const object = compile({ sphere: { center: [0, 0, 0], radius: 0.6 }, material: 'a',
                           inside: { sphere: { center: [0, 0, 0], radius: 0.35, complement: true }, material: 'a' } });
  const scene = compile({ plane: { normal: [0, 0, 1], offset: 0 }, material: 'floor' });
  const grafted = graftObject(scene, object, { reach: ball([0, 0, 0], 1.2) });
  assert.equal(grafted.copies.length, 2, 'one above the floor, one below');
  for (const t of [[0, 0, 0], [0.5, 0, -0.3], [-0.3, 0.1, 0.4]]) {   // within the reach: 0.6 more at most
    const { holes } = checkObject(scene, grafted, object, t, `moved by ${t}`);
    assert.ok(holes > 0, 'the hollow was probed');
  }
});

test('a compiled object with materials of its own: merged into the scene\'s, the same ones shared', () => {
  const object = compileScene({ materials: { a: {}, gilt: { albedo: [0.9, 0.7, 0.2] } }, lights: [],
                                root: { sphere: { center: [0, 0, 0], radius: 0.5 }, material: 'gilt',
                                        outside: { sphere: { center: [0.7, 0, 0], radius: 0.2 }, material: 'a' } } },
                              { quiet: true });
  const scene = compile({ plane: { normal: [0, 0, 1], offset: -2 }, material: 'floor' });
  const grafted = graftObject(scene, object, { reach: ball([0.2, 0, 0], 1.2) });
  const names = grafted.built.materials.map((m) => m.name);
  assert.equal(names.filter((n) => n === 'a').length, 1, 'a, the same in both, is one entry');
  assert.equal(names.filter((n) => n === 'gilt').length, 1, 'gilt is added');
  assert.equal(fillAt(grafted.built, [0, 0, 0]), 'gilt');
  assert.equal(fillAt(grafted.built, [0.7, 0, 0]), 'a');
  assert.equal(fillAt(grafted.built, [0, 0, -3]), 'floor');
});

test('an object\'s lit region comes with each copy: its own env, its lights under it, in env order', () => {
  // A ball of water (an ambient region, an env) carrying a light, round a
  // stone; placed twice, side by side.
  const object = compile({ sphere: { center: [0, 0, 0], radius: 0.8 }, material: 'water',
                           lights: [{ pos: [0, 0, 0.5], color: [5, 5, 5] }],
                           inside: { sphere: { center: [0, 0, 0], radius: 0.3 }, material: 'wall' } });
  const scene = compileScene({ materials: MATERIALS, lights: [{ pos: [0, 0, 9], color: [1, 1, 1] }],
                               root: { plane: { normal: [0, 0, 1], offset: -3 }, material: 'floor' } }, { quiet: true });
  const moveTo = (o, t) => ({ ...o, nodes: o.nodes.map((n, i) => (i ? { ...n, prim: movePrim(n.prim, { translate: t }) } : n)) });
  const once = graftObject(scene, moveTo(object, [-2, 0, 0]), { reach: ball([-2, 0, 0], 1) });
  const twice = graftObject(once.built, moveTo(object, [2, 0, 0]), { reach: ball([2, 0, 0], 1) });
  const built = twice.built;
  const envs = built.lights.map((lt) => lt.env);
  assert.deepEqual(envs, [...envs].sort((a, b) => a - b), 'lights in env order');
  assert.equal(built.lights.length, 1 + 2, 'the scene\'s, and one per placement');
  for (const [x, first] of [[-2, once.copies[0]], [2, twice.copies[0]]]) {
    const env = envAt(built, [x, 0, 0.5]);
    assert.equal(env, first, `inside the copy at ${x}, its own env node`);
    assert.ok(built.lights.some((lt) => lt.env === env), 'with its light under it');
    assert.equal(fillAt(built, [x, 0, 0]), 'wall');
  }
  assert.equal(envAt(built, [0, 0, 0]), 0, 'between them, the scene\'s');
});

// -- "place": an object placed at runtime -----------------------------------------

const placing = (root, objects, warned = []) => {
  const spec = { materials: MATERIALS, lights: [], objects, root };
  const warn = (path, msg) => warned.push(`${path}: ${msg}`);
  const compiled = compileScene(spec, { warn });
  return { spec, compiled, ...placeAll(compiled, spec, { warn }), warned };
};
const OBJECTS = { pebble: { sphere: { center: [0, 0, 0], radius: 0.5 }, material: 'a',
                            outside: { sphere: { center: [0.7, 0, 0], radius: 0.25 }, material: 'b' } } };

test('a place adds no nodes where it stands, and is listed; what it does not take is warned of', () => {
  const { compiled: built, warned } = placing({ group: [
    { plane: { normal: [0, 0, 1], offset: 0 }, material: 'floor' },
    { place: 'pebble', translate: [0, 0, 1], drop: true, inside: { sphere: { center: [0, 0, 0], radius: 1 } } },
  ] }, OBJECTS);
  const none = compileScene({ materials: MATERIALS, lights: [], root: { plane: { normal: [0, 0, 1], offset: 0 }, material: 'floor' } });
  assert.equal(built.nodes.length, none.nodes.length, 'nothing compiled in for it');
  assert.equal(built.placements.length, 1);
  assert.deepEqual([built.placements[0].ref, built.placements[0].translate], ['pebble', [0, 0, 1]]);
  for (const key of ['drop', 'inside']) {
    assert.ok(warned.some((w) => w.includes(`.${key}: not taken by a "place"`)), `${key}: ${warned.join('; ')}`);
  }
});

test('a place fills what a use of the same would, with nothing else near it', () => {
  const at = (root) => placing({ group: [{ plane: { normal: [0, 0, 1], offset: 0 }, material: 'floor' }, root] }, OBJECTS);
  const placed = at({ place: 'pebble', translate: [0.3, -0.2, 0.6], rotate: { axis: [0, 0, 1], degrees: 40 } });
  const used = at({ use: 'pebble', translate: [0.3, -0.2, 0.6], rotate: { axis: [0, 0, 1], degrees: 40 } });
  assert.equal(placed.placed.length, 1);
  assert.ok(placed.placed[0].copies.length >= 1);
  let differ = 0, inside = 0;
  for (let x = -1; x <= 1.6; x += 0.1) for (let y = -1; y <= 1; y += 0.1) for (let z = -0.5; z <= 1.4; z += 0.1) {
    const want = fillAt(used.built, [x, y, z]);
    if (want === 'a' || want === 'b') inside++;
    if (fillAt(placed.built, [x, y, z]) !== want) differ++;
  }
  assert.ok(inside > 50, 'the pebble was probed');
  assert.equal(differ, 0, 'points filled differently');
  const node = placed.placed[0].copies[0] + 1;          // after the spheroid round it, the compiler's
  assert.deepEqual([placed.built.provenance[node].owner, placed.built.provenance[node].path], ['@root', 'group/1'],
                   'its nodes name the place');
});

test('a place\'s reach: given, or the spheroid round it; one that can\'t be compiled is warned of and left out', () => {
  const reach = { center: [0, 0, 1], axis: [0, 0, 1], height: 6, radius: 3 };
  const given = placing({ place: 'pebble', translate: [0, 0, 1], reach }, OBJECTS);
  const round = placing({ place: 'pebble', translate: [0, 0, 1] }, OBJECTS);
  assert.equal(given.placed.length, 1);
  assert.equal(round.placed.length, 1);
  const missing = placing({ place: 'nobody' }, OBJECTS);
  assert.equal(missing.placed.length, 0);
  assert.ok(missing.warned.some((w) => /root/.test(w)), missing.warned.join('; '));
});

test('a place within a moved subtree moves with it, and takes the material it is within', () => {
  // A ball naming its material, a, with a lump naming none - which takes
  // what it is within. The knob is placed within a ball of b, itself moved
  // and turned; its lump pokes out of that ball, so what the lump is there
  // is only what it inherits. (A place lies over the scene: the ball of b
  // stays solid round it, where a use in its inside would have hollowed it.)
  const objects = { knob: { sphere: { center: [0, 0, 0], radius: 0.4 }, material: 'a',
                            outside: { sphere: { center: [0.5, 0, 0], radius: 0.2 } } } };
  const { built, placed } = placing({ sphere: { center: [0, 0, 0], radius: 1.5 }, material: 'b',
    inside: { place: 'knob', translate: [1.2, 0, 0] },
    rotate: { axis: [0, 0, 1], degrees: 90 }, translate: [0, 0, 1] }, objects);
  assert.equal(placed.length, 1);
  // Turned a quarter about z and lifted 1: the knob's centre (1.2, 0, 0)
  // goes to (0, 1.2, 1), its lump's (1.7, 0, 0) to (0, 1.7, 1).
  assert.equal(fillAt(built, [0, 1.2, 1]), 'a', 'the knob where the ball\'s moves took it');
  assert.equal(fillAt(built, [1.2, 0, 0]), 'empty', 'not where its own translate alone would put it');
  assert.equal(fillAt(built, [0, 1.7, 1]), 'b', 'the lump, out of the ball, b by inheritance');
  assert.equal(fillAt(built, [0, 0, 1]), 'b', 'the ball, solid round the knob');
});

test('a placed object\'s file is read when it is placed, not with the scene; its own references from beside it', async () => {
  // The pebble's file names its material by reference, relative to itself.
  const disk = {
    'scenes/s.json': { materials: { floor: {} }, lights: [], root: { group: [
      { plane: { normal: [0, 0, 1], offset: 0 }, material: 'floor' },
      { place: '@parts/pebble.json', translate: [0, 0, 1] },
    ] } },
    'scenes/parts/pebble.json': { sphere: { center: [0, 0, 0], radius: 0.5 }, material: '@stone.json#/stone' },
    'scenes/parts/stone.json': { stone: { albedo: [0.4, 0.4, 0.4] } },
  };
  const asked = [];
  const readText = async (path) => { asked.push(path); return JSON.stringify(disk[path]); };
  assert.deepEqual([...referencedFiles(disk['scenes/s.json'], 'scenes/s.json')], [], 'nothing the scene needs read');
  const spec = disk['scenes/s.json'], path = 'scenes/s.json';
  const files = await loadReferences(spec, { from: path, readText, readBytes: async () => new Uint8Array() });
  assert.deepEqual(asked, [], 'loading the scene reads nothing for the placed pebble');

  const built = compileScene(spec, { files, path, quiet: true });
  const now = placeAll(built, spec, { files, path, quiet: true });
  assert.equal(now.placed.length, 0);
  assert.equal(now.pending.length, 1, 'waiting on its file');

  const later = await placeAllLoading(built, spec, { files, path, readText, readBytes: async () => new Uint8Array(), warn: () => {} });
  assert.deepEqual(asked.sort(), ['scenes/parts/pebble.json', 'scenes/parts/stone.json'], 'read when placed');
  assert.equal(later.placed.length, 1);
  assert.equal(fillAt(later.built, [0, 0, 1]), 'scenes/parts/stone.json#/stone', 'its material, found beside it');
});
