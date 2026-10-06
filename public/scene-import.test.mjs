// Tests for importing objects between scene files. Run with:
//   node --test scene-import.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene, importsOf, resolveImports, loadImports } from './antisphere-scene.js';

/** A file offering two parts and a thing made of them. */
const boltFile = () => ({
  materials: { steel: { albedo: [0.6, 0.6, 0.7] } },
  lights: [{ pos: [1, 1, 1], color: [5, 5, 5] }],
  objects: {
    head: { cylinder: { center: [0,0,0], axis: [0,0,1], radius: 0.4 }, material: 'steel',
            inside: { slab: { center: [0,0,0], axis: [0,0,1], thickness: 0.2 } } },
    shaft: { cylinder: { center: [0,0,-0.6], axis: [0,0,1], radius: 0.15 }, material: 'steel',
             inside: { slab: { center: [0,0,-0.6], axis: [0,0,1], thickness: 1 } } },
    bolt: { union: ['head', 'shaft'] },
  },
  root: { sphere: { center: [0,0,0], radius: 9 }, inside: { use: 'bolt' } },
});

const hostFile = (extra = {}) => ({
  import: ['parts/bolt.json'],
  materials: { clay: {} },
  lights: [{ pos: [0,0,5], color: [9,9,9] }],
  objects: { post: { use: 'bolt:bolt', translate: [2,0,0] } },
  root: { sphere: { center: [0,0,0], radius: 40 }, inside: { union: ['post'] } },
  ...extra,
});

const imports = () => ({ 'parts/bolt.json': boltFile() });

test('what a scene imports, and under what name', () => {
  assert.deepEqual(importsOf(hostFile()), [{ alias: 'bolt', path: 'parts/bolt.json' }]);
  assert.deepEqual(importsOf({}), []);
  // The name comes from the file unless the scene chooses one.
  assert.deepEqual(importsOf({ import: { fixings: 'parts/bolt.json' } }),
                   [{ alias: 'fixings', path: 'parts/bolt.json' }]);
});

test('imported objects arrive under their file\'s name', () => {
  const flat = resolveImports(hostFile(), imports());
  assert.deepEqual(Object.keys(flat.objects).sort(),
                   ['bolt:bolt', 'bolt:head', 'bolt:shaft', 'post']);
  assert.equal(flat.import, undefined, 'and the scene no longer imports anything');
});

test('references inside an imported file follow it across', () => {
  const flat = resolveImports(hostFile(), imports());
  // "bolt" was a union of "head" and "shaft" where it came from.
  assert.deepEqual(flat.objects['bolt:bolt'], { union: ['bolt:head', 'bolt:shaft'] });
  assert.equal(flat.objects['bolt:head'].material, 'bolt:steel');
  assert.ok('bolt:steel' in flat.materials, 'and its materials came too');
});

test('a host name and an imported name can be the same word', () => {
  const host = hostFile({ objects: { head: { sphere: { center: [0,0,0], radius: 1 } },
                                     post: { use: 'bolt:head', translate: [2,0,0] } } });
  const flat = resolveImports(host, imports());
  assert.ok(flat.objects.head.sphere, 'the host keeps its own');
  assert.ok(flat.objects['bolt:head'].cylinder, 'and the import keeps its own');
});

test('it compiles, and the imported geometry is really there', () => {
  const built = compileScene(hostFile(), { imports: imports() });
  assert.ok(built.nodes.length > 4);
  const owners = new Set(built.provenance.filter(Boolean).map((p) => p.owner));
  assert.ok([...owners].some((o) => o.startsWith('bolt:')), [...owners].join(','));
  // Only the host's own lights and camera: an imported file's are how it
  // is looked at, not part of what it lends.
  assert.equal(built.lights.length, 1);
  assert.deepEqual(built.lights[0].pos, [0, 0, 5]);
});

test('an unnamed import is refused with something to do about it', () => {
  assert.throws(() => compileScene(hostFile(), { imports: {} }),
                /nothing supplied for "parts\/bolt.json".*loadImports/s);
  assert.throws(() => compileScene(hostFile()), /nothing supplied/);
});

test('two imports that both offer a "body" do not argue', () => {
  const a = { objects: { body: { sphere: { center: [0,0,0], radius: 1 } } } };
  const b = { objects: { body: { sphere: { center: [0,0,0], radius: 2 } } } };
  const flat = resolveImports({ import: ['a.json', 'b.json'], objects: {}, materials: {} },
                              { 'a.json': a, 'b.json': b });
  assert.equal(flat.objects['a:body'].sphere.radius, 1);
  assert.equal(flat.objects['b:body'].sphere.radius, 2);
});

test('imports of imports, by paths relative to whoever named them', async () => {
  const files = {
    'scenes/parts/bolt.json': { import: ['../common/metal.json'], objects: {
      bolt: { use: 'metal:blank', translate: [1, 0, 0] } } },
    'scenes/common/metal.json': { materials: { steel: {} }, objects: {
      blank: { sphere: { center: [0,0,0], radius: 1 }, material: 'steel' } } },
  };
  const spec = { import: ['parts/bolt.json'], materials: {}, lights: [], objects: {},
                 root: { sphere: { center: [0,0,0], radius: 9 }, inside: { use: 'bolt:bolt' } } };

  const loaded = await loadImports(spec, async (path) => {
    if (!files[path]) throw new Error('no such file');
    return files[path];
  }, { from: 'scenes/scene.json' });
  assert.deepEqual(Object.keys(loaded).sort(),
                   ['scenes/common/metal.json', 'scenes/parts/bolt.json']);

  const built = compileScene(spec, { imports: loaded, path: 'scenes/scene.json' });
  assert.ok(built.nodes.length > 1);
  const flat = resolveImports(spec, loaded, { from: 'scenes/scene.json' });
  // Two hops of prefixing, so the blank is findable from either end.
  assert.ok('bolt:metal:blank' in flat.objects, Object.keys(flat.objects).join(','));
});

test('a file that imports itself is refused rather than followed', () => {
  const loop = { import: ['loop.json'], objects: { thing: { sphere: { center: [0,0,0], radius: 1 } } } };
  assert.throws(() => resolveImports({ import: ['loop.json'], objects: {}, materials: {} },
                                     { 'loop.json': loop }),
                /imports itself/);
});

test('loadImports reports a file it cannot read', async () => {
  await assert.rejects(
    loadImports({ import: ['missing.json'] }, async () => { throw new Error('ENOENT'); }),
    /cannot read imported scene "missing.json"/);
});

test('the scene overrides what it imports, for materials and objects alike', () => {
  const host = hostFile({
    materials: { clay: {}, 'bolt:steel': { albedo: [0.9, 0.2, 0.2] } },
    objects: { post: { use: 'bolt:bolt', translate: [2, 0, 0] },
               'bolt:head': { sphere: { center: [0, 0, 0], radius: 0.5 }, material: 'bolt:steel' } },
  });
  const flat = resolveImports(host, imports());
  // Re-skinning an imported part without editing the file it came from.
  assert.deepEqual(flat.materials['bolt:steel'].albedo, [0.9, 0.2, 0.2]);
  // And replacing one of its pieces, which the rest of the import still uses.
  assert.ok(flat.objects['bolt:head'].sphere, 'the scene\'s own head');
  assert.deepEqual(flat.objects['bolt:bolt'], { union: ['bolt:head', 'bolt:shaft'] });
  compileScene(host, { imports: imports() });        // and it still compiles
});

test('two files that would share a name are refused, with the remedy', () => {
  const two = { import: ['a/bolt.json', 'b/bolt.json'], objects: {}, materials: {} };
  assert.throws(() => resolveImports(two, { 'a/bolt.json': { objects: {} },
                                            'b/bolt.json': { objects: {} } }),
                /would both be called "bolt".*"import": \{ "bolt-2"/s);
  // Naming one settles it.
  const named = { import: { bolt: 'a/bolt.json', fasteners: 'b/bolt.json' },
                  objects: {}, materials: {} };
  const flat = resolveImports(named, {
    'a/bolt.json': { objects: { body: { sphere: { center: [0,0,0], radius: 1 } } } },
    'b/bolt.json': { objects: { body: { sphere: { center: [0,0,0], radius: 2 } } } },
  });
  assert.deepEqual(Object.keys(flat.objects).sort(), ['bolt:body', 'fasteners:body']);
});

test('the same file imported twice under one name is not a clash', () => {
  const twice = { import: ['parts/bolt.json', 'parts/bolt.json'], objects: {}, materials: {},
                  lights: [], root: { sphere: { center: [0,0,0], radius: 9 },
                                      inside: { use: 'bolt:bolt' } } };
  const flat = resolveImports(twice, imports());
  assert.ok('bolt:bolt' in flat.objects);
});

test('an imported object\'s lights come with it, moved where it is placed', () => {
  const lampFile = {
    materials: { glass: { albedo: [0.9, 0.9, 1] } },
    objects: { lamp: { sphere: { center: [0, 0, 0], radius: 1 },
                       lights: [{ pos: [0, 0, 0.5], color: [20, 18, 15] }],
                       inside: { sphere: { center: [0, 0, 0], radius: 0.2 }, material: 'glass' } } },
  };
  const spec = { import: ['parts/lamp.json'], materials: {}, lights: [],
                 root: { sphere: { center: [0, 0, 0], radius: 40 }, inside: { use: 'lamp:lamp', translate: [3, 0, 0] } } };
  const built = compileScene(spec, { imports: { 'parts/lamp.json': lampFile } });
  assert.equal(built.topLights, 0);
  assert.deepEqual(built.lights.map((lt) => lt.pos), [[3, 0, 0.5]]);
  assert.ok(built.lights[0].env > 0, 'in the lamp\'s own env');
});
