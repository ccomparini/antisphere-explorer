// Tests for references between scene files: a path or URL wherever a scene
// expects an object (scene-format.md, References). Run with:
//   node --test scene-references.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { compileScene, expandReferences, loadReferences, isReference } from './antisphere-scene.js';
import { writeSTL } from './stl.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const H = (prim, R) => {
  const along = dot(prim.axis, R);
  return prim.k_perp * dot(R, R) + (prim.k_par - prim.k_perp) * along * along + 2 * dot(prim.linear, R) + prim.constant;
};
/** What fills point R, by trace()'s rules: the material's albedo, or null where nothing solid does. */
function albedoAt(built, R) {
  let index = 1, found = 0;
  while (index) {
    const nd = built.nodes[index];
    if (H(nd.prim, R) < 0) {
      if (built.materials[nd.material].solid) { if (!found) found = index; } else found = 0;
      if (!nd.inside) break;
      index = nd.inside;
    } else {
      found = 0;
      index = nd.outside;
    }
  }
  return found ? built.materials[built.nodes[found].material].albedo : null;
}

const STEEL = [0.6, 0.6, 0.7], IRON = [0.3, 0.3, 0.32], CLAY = [0.7, 0.5, 0.4];

/** A file offering two parts and a thing made of them, linking its own parts by reference. */
const boltFile = () => ({
  materials: { steel: { albedo: STEEL } },
  objects: {
    head: { cylinder: { center: [0, 0, 0], axis: [0, 0, 1], radius: 0.4 }, material: 'steel',
            inside: { slab: { center: [0, 0, 0], axis: [0, 0, 1], thickness: 0.2 } } },
    shaft: { cylinder: { center: [0, 0, -0.6], axis: [0, 0, 1], radius: 0.15 }, material: 'steel',
             inside: { slab: { center: [0, 0, -0.6], axis: [0, 0, 1], thickness: 1 } } },
    bolt: { union: ['@#/objects/head', '@#/objects/shaft'] },
  },
});

const host = (extra = {}) => ({
  materials: { clay: { albedo: CLAY }, steel: '@parts/bolt.json#/materials/steel' },
  lights: [{ pos: [0, 0, 5], color: [9, 9, 9] }],
  root: { sphere: { center: [0, 0, 0], radius: 40 }, inside: { use: '@parts/bolt.json#/objects/bolt', translate: [2, 0, 0] } },
  ...extra,
});
const files = () => ({ 'scenes/parts/bolt.json': boltFile() });
const compile = (spec, more = {}) => compileScene(spec, { files: { ...files(), ...more }, path: 'scenes/host.json' });

test('what is a reference, and what a name: a reference starts @', () => {
  for (const ref of ['@parts/bolt.json', '@bolt.json#/objects/bolt', '@../lib/m.json', '@torus.stl', '@torus.stl.gz',
                     '@https://example.com/scene', '@#/objects/head', '@#', '@a.json?v=2']) {
    assert.ok(isReference(ref), ref);
  }
  for (const name of ['bolt', 'steel', 'bolt:steel', 'parts/bolt.json', 'torus.stl', '#/objects/head',
                      'https://example.com/scene', '', 'lib@home']) {
    assert.ok(!isReference(name), name);
  }
  assert.ok(!isReference(null) && !isReference({ use: '@x.json' }));
});

test('a subtree by reference, relative to the file naming it, and its own parts by "@#/..."', () => {
  const built = compile(host());
  assert.deepEqual(albedoAt(built, [2, 0, 0]), STEEL, 'the head');
  assert.deepEqual(albedoAt(built, [2, 0, -0.6]), STEEL, 'the shaft');
  assert.equal(albedoAt(built, [2, 0.3, -0.6]), null, 'beside the shaft');
});

test('names in what a reference brings are the scene\'s', () => {
  // The scene calls something else steel: the bolt is made of that.
  const built = compile(host({ materials: { steel: { albedo: IRON } } }));
  assert.deepEqual(albedoAt(built, [2, 0, 0]), IRON);
  // And with none, it is the scene's problem, named as the compiler names it.
  assert.throws(() => compile(host({ materials: { clay: {} } })), /steel/);
});

test('every use of one reference shares one set of nodes', () => {
  const one = compile(host());
  const twice = compile(host({ root: { sphere: { center: [0, 0, 0], radius: 40 }, inside: { union: [
    { use: '@parts/bolt.json#/objects/bolt', translate: [2, 0, 0] },
    { use: '@parts/bolt.json#/objects/bolt', translate: [-2, 0, 0] },
  ] } } }));
  const { spec } = expandReferences(host(), files(), { from: 'scenes/host.json' });
  assert.deepEqual(Object.keys(spec.objects).filter((k) => k.includes('bolt.json')).sort(),
    ['scenes/parts/bolt.json#/objects/bolt', 'scenes/parts/bolt.json#/objects/head', 'scenes/parts/bolt.json#/objects/shaft']);
  assert.deepEqual(albedoAt(twice, [-2, 0, 0]), STEEL);
  assert.ok(twice.nodes.length < 2 * one.nodes.length, `${twice.nodes.length} nodes for two, ${one.nodes.length} for one`);
});

test('references in every place an object goes', () => {
  const lib = {
    _comment: 'a note, not a material',
    clay: { albedo: CLAY },
    iron: { albedo: IRON },
  };
  const lightsFile = [{ pos: [1, 2, 3], color: [1, 1, 1] }, { pos: [4, 5, 6], color: [2, 2, 2] }];
  const extra = {
    'scenes/lib/m.json': lib,
    'scenes/lights.json': { key: { pos: [0, 0, 9], color: [3, 3, 3] }, set: lightsFile },
    'scenes/view.json': { camera: { position: [1, 1, 1], direction: [-1, 0, 0], distance: 3 }, gravity: { strength: 3, down: [0, 0, -1] } },
    'scenes/ball.json': { sphere: { center: [0, 0, 0], radius: 1 } },
  };
  const spec = {
    materials: ['@lib/m.json', { iron: { albedo: STEEL }, steel: { albedo: STEEL } }],   // merged in order: later wins
    lights: ['@lights.json#/key', '@lights.json#/set', { pos: [7, 7, 7], color: [1, 1, 1] }],
    camera: '@view.json#/camera',
    gravity: '@view.json#/gravity',
    objects: '@parts/bolt.json#/objects',                               // a whole map
    root: { sphere: { center: [0, 0, 0], radius: 40 }, inside: { union: [
      { sphere: { center: [5, 0, 0], radius: 1 }, material: '@lib/m.json#/iron' },   // a material by reference
      { sphere: { center: [-5, 0, 0], radius: 2 }, material: 'clay', inside: { use: '@ball.json', translate: [-5, 0, 0] } },
      'head',                                                          // a name: the map's head
    ] } },
  };
  const built = compile(spec, extra);
  assert.deepEqual(built.lights.map((light) => light.pos), [[0, 0, 9], [1, 2, 3], [4, 5, 6], [7, 7, 7]]);
  assert.deepEqual(built.camera.position, [1, 1, 1]);
  assert.equal(built.gravity.strength, 3);
  assert.deepEqual(albedoAt(built, [5, 0, 0]), IRON, 'lib/m.json#/iron, not the scene\'s iron');
  assert.deepEqual(albedoAt(built, [-5, 0, 0]), CLAY, 'the referenced ball, made of the clay around it');
  assert.deepEqual(albedoAt(built, [0, 0, 0]), STEEL, 'the head, by name, from the referenced map');
  const merged = expandReferences(spec, { ...files(), ...extra }, { from: 'scenes/host.json' }).spec.materials;
  assert.deepEqual(merged.iron.albedo, STEEL, 'the scene\'s iron, after the library\'s');
  assert.ok(!('_comment' in merged), 'a note in a map is dropped, not brought over');
});

test('JSON pointers: escapes, arrays, and a pointer that misses', () => {
  const extra = { 'scenes/odd.json': { 'a/b': { 'c~d': [{ sphere: { center: [0, 0, 0], radius: 1 } }] } } };
  const spec = { materials: { clay: { albedo: CLAY } }, lights: [],
                 root: { sphere: { center: [0, 0, 0], radius: 9 }, material: 'clay', inside: '@odd.json#/a~1b/c~0d/0' } };
  assert.deepEqual(albedoAt(compile(spec, extra), [0, 0, 0]), CLAY);
  assert.deepEqual(albedoAt(compile({ ...spec, root: { ...spec.root, inside: '@odd.json#/a%7E1b/c~0d/0' } }, extra), [0, 0, 0]),
                   CLAY, 'percent-encoded, as a URL fragment may be');
  assert.throws(() => compile({ ...spec, root: { ...spec.root, inside: '@odd.json#/a~1b/nothing' } }, extra),
                /odd.json#\/a~1b\/nothing.*nothing at/);
  assert.throws(() => compile({ ...spec, root: { ...spec.root, inside: '@odd.json#a' } }, extra), /JSON pointer/);
});

test('relative to the file that names them, and to a URL', () => {
  // parts/bolt.json names ../lib/m.json: scenes/lib/m.json.
  const part = { objects: { ball: { sphere: { center: [0, 0, 0], radius: 1 }, material: '@../lib/m.json#/iron' } } };
  const spec = { materials: {}, lights: [], root: { sphere: { center: [0, 0, 0], radius: 9 }, inside: '@parts/ball.json#/objects/ball' } };
  const extra = { 'scenes/parts/ball.json': part, 'scenes/lib/m.json': { iron: { albedo: IRON } } };
  assert.deepEqual(albedoAt(compile(spec, extra), [0, 0, 0]), IRON);
  const { missing } = expandReferences(spec, {}, { from: 'https://example.com/models/scene.json' });
  assert.deepEqual([...missing], ['https://example.com/models/parts/ball.json']);
  const urls = { 'https://example.com/models/parts/ball.json': part, 'https://example.com/models/lib/m.json': { iron: { albedo: IRON } } };
  const built = compileScene(spec, { files: urls, path: 'https://example.com/models/scene.json' });
  assert.deepEqual(albedoAt(built, [0, 0, 0]), IRON);
});

test('what is missing, a cycle, and "import" are each said plainly', () => {
  assert.throws(() => compileScene(host(), { path: 'scenes/host.json' }),
                /scenes\/parts\/bolt.json: not loaded.*loadReferences\(\)/);
  // A file that is itself a reference is followed - round, here.
  const loop = { 'scenes/a.json': '@b.json', 'scenes/b.json': '@a.json' };
  assert.throws(() => compileScene({ materials: '@a.json', lights: [], root: null }, { files: loop, path: 'scenes/s.json' }),
                /includes itself/);
  // A subtree that uses itself is a use cycle, which the compiler reports as ever.
  const self = { 'scenes/self.json': { sphere: { center: [0, 0, 0], radius: 1 }, inside: '@self.json' } };
  assert.throws(() => compileScene({ materials: {}, lights: [], root: '@self.json' }, { files: self, path: 'scenes/s.json' }),
                /refers to itself/);
  assert.throws(() => compileScene({ import: ['parts/bolt.json'], materials: {}, lights: [], root: null }),
                /references replace "import"/);
});

test('loadReferences fetches everything, and what that references, once each', async () => {
  const served = { 'scenes/parts/bolt.json': boltFile(), 'scenes/lib/m.json': { clay: { albedo: CLAY } } };
  const asked = [];
  const spec = { ...host(), materials: ['@lib/m.json', { steel: '@parts/bolt.json#/materials/steel' }] };
  const got = await loadReferences(spec, { from: 'scenes/host.json', readText: async (path) => {
    asked.push(path);
    if (!(path in served)) throw new Error('ENOENT');
    return JSON.stringify(served[path]);
  } });
  assert.deepEqual(asked.sort(), ['scenes/lib/m.json', 'scenes/parts/bolt.json']);
  assert.deepEqual(albedoAt(compileScene(spec, { files: got, path: 'scenes/host.json' }), [2, 0, 0]), STEEL);
  await assert.rejects(loadReferences({ root: '@missing.json' }, { readText: async () => { throw new Error('ENOENT'); } }),
                       /cannot load "missing.json": ENOENT/);
});

test('an STL by reference, and gzipped files', async () => {
  const tetrahedron = [
    [[0, 0, 0], [0, 1, 0], [1, 0, 0]], [[0, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 0, 0], [1, 0, 0], [0, 0, 1]], [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  ];
  const stl = new Uint8Array(writeSTL(tetrahedron));
  const bytes = {
    'scenes/tet.stl': stl,
    'scenes/tet.stl.gz': gzipSync(stl),
    'scenes/lib/m.json.gz': gzipSync(JSON.stringify({ clay: { albedo: CLAY } })),
  };
  for (const mesh of ['tet.stl', 'tet.stl.gz']) {
    // A mesh names no material: it is made of the clay of the node around it.
    const spec = { materials: '@lib/m.json.gz', lights: [],
                   root: { sphere: { center: [0, 0, 0], radius: 9 }, material: 'clay', inside: { use: `@${mesh}`, scale: 2 } } };
    const got = await loadReferences(spec, { from: 'scenes/s.json', readBytes: async (path) => bytes[path] });
    const built = compileScene(spec, { files: got, path: 'scenes/s.json' });
    assert.deepEqual(albedoAt(built, [0.2, 0.2, 0.2]), CLAY, mesh);
    assert.equal(albedoAt(built, [1, 1, 1]), null, `${mesh}: outside the slanted face`);
  }
  await assert.rejects(loadReferences({ root: '@tet.stl' }, { readText: async () => '' }), /needs loadReferences\(\) given readBytes/);
  assert.throws(() => compileScene({ materials: {}, lights: [], root: '@tet.stl#/x' }, { files: { 'tet.stl': {} } }),
                /no parts to point into/);
});

test('a scene with no references is left as it is', () => {
  const plain = { materials: { clay: {} }, lights: [], root: { sphere: { center: [0, 0, 0], radius: 1 }, material: 'clay' } };
  assert.equal(expandReferences(plain).spec, plain);
});

test('a referenced object\'s lights come with it, moved where it is placed', () => {
  const lampFile = {
    lamp: { sphere: { center: [0, 0, 0], radius: 1 },
            lights: [{ pos: [0, 0, 0.5], color: [20, 18, 15] }],
            inside: { sphere: { center: [0, 0, 0], radius: 0.2 }, material: 'glass' } },
  };
  const spec = { materials: { glass: { albedo: [0.9, 0.9, 1] } }, lights: [],
                 root: { sphere: { center: [0, 0, 0], radius: 40 }, inside: { use: '@parts/lamp.json#/lamp', translate: [3, 0, 0] } } };
  const built = compile(spec, { 'scenes/parts/lamp.json': lampFile });
  assert.equal(built.topLights, 0);
  assert.deepEqual(built.lights.map((lt) => lt.pos), [[3, 0, 0.5]]);
  assert.ok(built.lights[0].env > 0, 'in the lamp\'s own env');
});
