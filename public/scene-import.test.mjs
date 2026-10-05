// Tests for importing objects between scene files. Run with:
//   node --test scene-import.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene, importsOf, resolveImports, loadImports, sceneForMesh, isSTL } from './antisphere-scene.js';
import { writeSTL } from './stl.js';

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

// -- STL imports --------------------------------------------------------------------

// A closed tetrahedron, outward by the right-hand rule, and an open one.
const tetrahedron = [
  [[0,0,0],[0,1,0],[1,0,0]], [[0,0,0],[0,0,1],[0,1,0]],
  [[0,0,0],[1,0,0],[0,0,1]], [[1,0,0],[0,1,0],[0,0,1]],
];

/** loadImports() over a fake disk: JSON files by path, and STL bytes. */
const loadFrom = (files, options = {}) => (spec, from) => loadImports(spec, async (path) => {
  if (!(path in files)) throw new Error('no such file');
  return files[path];
}, {
  from,
  readBytes: async (path) => {
    if (!(path in files)) throw new Error('no such file');
    return files[path];
  },
  ...options,
});

const meshHost = (imported, use, extra = {}) => ({
  import: imported,
  materials: {},
  lights: [],
  objects: { piece: { use, translate: [3, 0, 0] } },
  root: { sphere: { center: [0,0,0], radius: 40 }, inside: { union: ['piece'] } },
  ...extra,
});

test('an STL imports as one object, named for the file, and no material', async () => {
  const spec = meshHost(['parts/tet.stl'], 'tet:tet');
  const loaded = await loadFrom({ 'scenes/parts/tet.stl': writeSTL(tetrahedron) })(spec, 'scenes/a.json');
  assert.deepEqual(loaded['scenes/parts/tet.stl'].materials, undefined, 'a mesh has none');
  const flat = resolveImports(spec, loaded, { from: 'scenes/a.json' });
  assert.deepEqual(Object.keys(flat.objects).sort(), ['piece', 'tet:tet']);
  assert.deepEqual(Object.keys(flat.materials), [], 'nor does importing one add any');
  const built = compileScene(spec, { imports: loaded, path: 'scenes/a.json' });
  // Four faces, and a tetrahedron is convex, so a chain of four planes,
  // in its bounding spheroid, inside the scene's sphere.
  assert.equal(built.nodes.length - 1, 6);
});

test('an STL import can be renamed, and imported by an imported file that makes it of something', async () => {
  const files = {
    'scenes/parts/kit.json': {
      import: { spike: 'mesh/tet.stl' },
      materials: { iron: { albedo: [0.4, 0.4, 0.45] } },
      objects: { spike: { use: 'spike:tet', material: 'iron' } },
    },
    'scenes/parts/mesh/tet.stl': writeSTL(tetrahedron),
  };
  const spec = meshHost(['parts/kit.json'], 'kit:spike');
  const loaded = await loadFrom(files)(spec, 'scenes/a.json');
  const flat = resolveImports(spec, loaded, { from: 'scenes/a.json' });
  assert.ok('kit:spike:tet' in flat.objects, Object.keys(flat.objects).join(','));
  assert.equal(flat.objects['kit:spike'].material, 'kit:iron');
  const built = compileScene(spec, { imports: loaded, path: 'scenes/a.json' });
  const iron = built.materials.findIndex((m) => m.albedo?.[2] === 0.45);
  assert.ok(built.nodes.slice(2).every((nd) => nd.material === iron), 'every node of it iron');
});

test('an STL import needs readBytes, and says so', async () => {
  await assert.rejects(
    loadImports(meshHost(['tet.stl'], 'tet:tet'), async () => ({})),
    /cannot import "tet.stl": an STL needs loadImports\(\) given readBytes/);
});

test('an STL that does not close imports with a warning; one with no area does not import', async () => {
  const warnings = [];
  const open = tetrahedron.slice(0, 3);
  await loadFrom({ 'open.stl': writeSTL(open) }, { warn: (msg) => warnings.push(msg) })(
    meshHost(['open.stl'], 'open:open'), '');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^open\.stl: 3 open edges/);

  const flat = [[[0,0,0],[1,0,0],[2,0,0]]];
  await assert.rejects(
    loadFrom({ 'flat.stl': writeSTL(flat) })(meshHost(['flat.stl'], 'flat:flat'), ''),
    /cannot import mesh "flat.stl": the mesh has no triangles with any area/);
});

test('a use paints an imported object, from a scene file or an STL alike', async () => {
  const red = { albedo: [0.9, 0.1, 0.1] };
  const spec = {
    import: ['parts/bolt.json', 'parts/tet.stl'],
    materials: { red },
    lights: [],
    objects: {},
    root: { sphere: { center: [0,0,0], radius: 40 }, material: null, inside: { union: [
      { use: 'bolt:bolt', material: 'red' },
      { use: 'tet:tet', material: 'red', translate: [3, 0, 0] },
    ] } },
  };
  const loaded = await loadFrom({
    'parts/bolt.json': boltFile(),
    'parts/tet.stl': writeSTL(tetrahedron),
  })(spec, '');
  const built = compileScene(spec, { imports: loaded });
  // Every node below the root's sphere: all the bolt's and the mesh's,
  // which named steel and tet:tet, now red.
  const named = new Set(built.nodes.slice(2).map((nd) => built.materials[nd.material].albedo));
  assert.deepEqual([...named], [red.albedo]);
});

// -- an import's name alone ---------------------------------------------------------

test('an import\'s name alone is its object of that name, or its only object', async () => {
  const tet = writeSTL(tetrahedron);
  const host = (imported, use, extra) => ({ ...meshHost(imported, use, extra), materials: { clay: {} } });
  const compiled = async (spec, files) => {
    const loaded = await loadFrom(files)(spec, '');
    return { flat: resolveImports(spec, loaded), built: compileScene(spec, { imports: loaded }) };
  };

  // An STL's one object; and a renamed one, whose object keeps the file's name.
  let { flat } = await compiled(host(['tet.stl'], 'tet'), { 'tet.stl': tet });
  assert.equal(flat.objects.piece.use, 'tet:tet');
  ({ flat } = await compiled(host({ pot: 'tet.stl' }, 'pot'), { 'tet.stl': tet }));
  assert.equal(flat.objects.piece.use, 'pot:tet');

  // A scene file's object named for it, among others.
  ({ flat } = await compiled(host(['parts/bolt.json'], 'bolt'), { 'parts/bolt.json': boltFile() }));
  assert.equal(flat.objects.piece.use, 'bolt:bolt');

  // In an imported file, for what it imports - and in the root and arrays.
  const files = {
    'kit.json': { import: ['spike.stl'], objects: { pin: { union: ['spike'] } } },
    'spike.stl': tet,
  };
  const nested = { ...host(['kit.json'], 'kit:pin'), root: { sphere: { center: [0, 0, 0], radius: 40 },
                   inside: { union: ['piece', { use: 'kit:pin', translate: [0, 5, 0] }] } } };
  let built;
  ({ flat, built } = await compiled(nested, files));
  assert.deepEqual(flat.objects['kit:pin'].union, ['kit:spike:spike']);
  assert.ok(built.nodes.length > 1);
});

test('an import\'s name alone defers to the scene\'s own object, and needs one to mean', async () => {
  const tet = writeSTL(tetrahedron);
  // The scene's own "tet" wins; the import is still there by its full name.
  const own = meshHost(['tet.stl'], 'tet:tet', {
    objects: { tet: { sphere: { center: [0, 0, 0], radius: 1 } }, piece: { use: 'tet' } },
  });
  const loaded = await loadFrom({ 'tet.stl': tet })(own, '');
  const flat = resolveImports(own, loaded);
  assert.equal(flat.objects.piece.use, 'tet');
  assert.ok('tet:tet' in flat.objects);

  // A file with several objects, none named for it, offers no short name.
  const parts = { objects: { a: { sphere: { center: [0, 0, 0], radius: 1 } },
                             b: { sphere: { center: [2, 0, 0], radius: 1 } } } };
  const many = meshHost(['parts.json'], 'parts');
  assert.throws(() => compileScene(many, { imports: { 'parts.json': parts } }), /unknown object "parts"/);
});

// -- by URL -------------------------------------------------------------------------

test('imports by URL: kept as they are, and paths in a file from a URL resolved against it', async () => {
  const asked = [];
  const files = {
    'https://host.example/scenes/parts/kit.json': { import: ['../common/metal.json'], objects: { pin: { use: 'metal' } } },
    'https://host.example/scenes/common/metal.json': { objects: { metal: { sphere: { center: [0, 0, 0], radius: 1 } } } },
    'https://cdn.example/models/torus.stl?raw=true': writeSTL(tetrahedron),
  };
  const read = async (path) => { asked.push(path); if (!(path in files)) throw new Error('404'); return files[path]; };
  const spec = {
    import: ['parts/kit.json', 'https://cdn.example/models/torus.stl?raw=true'],
    materials: { clay: {} },
    lights: [],
    root: { sphere: { center: [0, 0, 0], radius: 40 }, inside: { union: [
      { use: 'kit:pin' },
      { use: 'torus', material: 'clay', translate: [3, 0, 0] },
    ] } },
  };
  const from = 'https://host.example/scenes/scene.json';
  const loaded = await loadImports(spec, read, { from, readBytes: read });
  assert.deepEqual(asked.sort(), Object.keys(files).sort());
  // The query is no part of its name, or of whether it is an STL.
  assert.ok(isSTL('https://cdn.example/models/torus.stl?raw=true'));
  const flat = resolveImports(spec, loaded, { from });
  assert.ok('torus:torus' in flat.objects && 'kit:metal:metal' in flat.objects, Object.keys(flat.objects).join());
  assert.ok(compileScene(spec, { imports: loaded, path: from }).nodes.length > 1);
});

test('an STL on its own makes a scene round it, the mesh 2 across and standing on the floor', () => {
  // A tetrahedron 10 across, well away from the origin.
  const far = tetrahedron.map((tri) => tri.map((v) => v.map((x, i) => x * 10 + [100, -50, 7][i])));
  const { spec, imports } = sceneForMesh('https://host.example/m/spike.stl', writeSTL(far));
  assert.deepEqual(spec.import, ['https://host.example/m/spike.stl']);
  const placed = spec.objects.model;
  assert.equal(placed.use, 'spike');
  assert.ok(Math.abs(placed.scale * 10 - 2) < 1e-6, `scale ${placed.scale}`);
  // Lowest point at z = 7, so lifted by -7 (scaled); centred in x and y.
  assert.ok(Math.abs(placed.translate[2] + 7 * placed.scale) < 1e-6, `translate ${placed.translate}`);
  assert.ok(Math.abs(placed.translate[0] + 105 * placed.scale) < 1e-6);
  const built = compileScene(spec, { imports, path: 'https://host.example/m/spike.stl' });
  assert.ok(built.nodes.length > 6 && built.lights.length === 3 && built.camera);
});
