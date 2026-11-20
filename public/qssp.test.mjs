// Tests for precompiled objects: an object compiled once and written
// (precompileObject(), qssp.js), then used as its source would be
// (compiled-format.md, "A precompiled object"). Run with:
//   node --test public/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene, loadReferences, precompileObject } from './antisphere-scene.js';
import { encodeQSSP, decodeQSSP, QSSPObject } from './qssp.js';
import { placeAll } from './movers.js';
import { quadricAt as H } from './quadric.js';

const PATH = 'scenes/s.json';

/** The material filling p: its name, or 'empty' (or 'vacuum'). */
function fillAt(built, p) {
  let i = 1;
  while (i) {
    const n = built.nodes[i];
    if (H(n.prim, p) < 0) { if (!n.inside) return built.materials[n.material]?.name ?? 'vacuum'; i = n.inside; }
    else i = n.outside;
  }
  return 'empty';
}

/** `object` (an object's JSON) precompiled, as the bytes of its file. */
function precompiled(object, warned = []) {
  const files = { 'scenes/obj.json': object };
  return encodeQSSP(precompileObject('@obj.json', { files, path: PATH, warn: (path, msg) => warned.push(`${path}: ${msg}`) }));
}

/** A scene compiled, `obj` in it either as written (obj.json) or precompiled (obj.qssp). */
function compileWith(spec, object, kind, warned = []) {
  const files = kind === 'json' ? { 'scenes/obj.json': object } : { 'scenes/obj.qssp': decodeQSSP(precompiled(object)) };
  const text = JSON.stringify(spec).replaceAll('@obj', `@obj.${kind}`);
  return compileScene(JSON.parse(text), { files, path: PATH, warn: (path, msg) => warned.push(`${path}: ${msg}`) });
}

// Every point of a grid round `centre`, `half` each way, as each scene
// fills it: a grid set off a little, so that no point is on a surface,
// which the file's 32-bit numbers may move by a hair.
function sameFill(a, b, centre, half, step) {
  let compared = 0;
  const off = [0.0123, 0.0217, 0.0371];
  for (let x = -half; x <= half; x += step) for (let y = -half; y <= half; y += step) for (let z = -half; z <= half; z += step) {
    const p = [centre[0] + x + off[0], centre[1] + y + off[1], centre[2] + z + off[2]];
    assert.equal(fillAt(b, p), fillAt(a, p), `at [${p.map((v) => v.toFixed(2))}]`);
    compared++;
  }
  return compared;
}

// Two balls, wrapped: everything in it inherits, or passes it on - the
// material round it fills it, as a mesh's tree in its spheroid.
const BALLS = { union: [
  { sphere: { center: [-0.5, 0, 0], radius: 0.75 } },
  { sphere: { center: [0.75, 0, 0.25], radius: 0.5 } },
], wrap: 'spheroid' };

// A lamp naming its own materials, in a ball naming none: a jade shade
// with a ruby in it, and a stem that is whatever the lamp is used as.
const SHADE = { center: [0, 0, 1], radius: 0.6 };
const LAMP = { sphere: { center: [0, 0, 0.5], radius: 1.5 }, inside: {
  sphere: SHADE, material: 'jade',
  inside: { sphere: { center: [0, 0, 1], radius: 0.3 }, material: 'ruby', outside: { sphere: SHADE, material: 'jade' } },
  outside: { cylinder: { center: [0, 0, 0], axis: [0, 0, 1], radius: 0.1 }, inside: { slab: { center: [0, 0, 0.25], axis: [0, 0, 1], thickness: 0.5 } } },
} };

const MATERIALS = { gold: {}, stone: {}, jade: {}, ruby: {} };

test('the file: what is written is read back', () => {
  const manifest = { source: 'x.json', nodes: 2, surfaces: 1, materials: [{ inherit: true }], owners: [''], reach: null };
  const surfaces = new Float32Array([0, 0, 1, 0.5, 0.5, 0.25, 0, -1, 0.125]);
  const nodes = new Int32Array([1, 0, 1, 0, 0, 0, -1, 0]);
  const bytes = encodeQSSP({ manifest, surfaces, nodes });
  assert.equal(bytes.length % 4, 0);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'QSSP');
  const read = decodeQSSP(bytes);
  assert.ok(read instanceof QSSPObject);
  assert.equal(read.nodeCount, 2);
  assert.deepEqual([...read.surfaces], [...surfaces]);
  assert.deepEqual([...read.nodes], [...nodes]);
  assert.equal(read.owners, null, 'one owner: none stored');
  assert.equal(read.manifest.source, 'x.json');
  // Not one, or not this version, or cut short: said.
  assert.throws(() => decodeQSSP(new Uint8Array(40)), /not a precompiled object/);
  const later = bytes.slice();
  new DataView(later.buffer).setUint32(4, 99, true);
  assert.throws(() => decodeQSSP(later), /version 99.*precompile it again/);
  assert.throws(() => decodeQSSP(bytes.subarray(0, bytes.length - 4)), /cut short/);
});

test('precompiled: each surface once, its nodes and materials as compiled', () => {
  const object = precompileObject('@obj.json', { files: { 'scenes/obj.json': LAMP }, path: PATH, warn: () => {} });
  const { manifest } = object;
  assert.equal(manifest.nodes, object.nodes.length / 4);
  assert.equal(manifest.surfaces, object.surfaces.length / 9);
  assert.ok(manifest.surfaces < manifest.nodes, 'the shade twice, kept once');
  assert.deepEqual(manifest.materials.map((m) => m?.name ?? (m?.inherit ? 'inherit' : m)).sort(), ['inherit', 'jade', 'ruby']);
  assert.deepEqual(manifest.owners, [''], 'all its own');
  assert.ok(manifest.reach, 'its extent found');
});

test('used sealed - turned, scaled, moved, given a material - it fills space as its source does', () => {
  const spec = { materials: MATERIALS, lights: [],
                 objects: { thing: { use: '@obj', material: 'gold', scale: 2, rotate: { axis: [0, 0, 1], degrees: 90 }, translate: [5, 1, 0] } },
                 root: { plane: { normal: [0, 0, 1], offset: -1.5 }, material: 'stone', outside: { use: 'thing' } } };
  const warned = [];
  const source = compileWith(spec, BALLS, 'json'), sealed = compileWith(spec, BALLS, 'qssp', warned);
  assert.deepEqual(warned, []);
  assert.equal(sealed.nodes.length, source.nodes.length);
  assert.ok(sameFill(source, sealed, [5, 1, 0], 2.6, 0.2) > 10000);
  assert.equal(fillAt(sealed, [5, 1, 0]), 'gold');
  assert.equal(fillAt(sealed, [5, 1, -2]), 'stone');
  // Its nodes are the object's: the instance's, as its source's would be.
  const owners = new Set(sealed.provenance.filter((p) => p && p.owner !== '@root').map((p) => p.owner));
  assert.deepEqual([...owners], ['thing']);
});

test('opened where a pass reaches into it - a group, a complement - and still as its source', () => {
  const grouped = { materials: MATERIALS, lights: [], root: { group: [
    { plane: { normal: [0, 0, 1], offset: -0.5 }, material: 'stone' },
    { use: '@obj', material: 'gold', translate: [0, 0, 0.5] },
    { sphere: { center: [2.5, 0, 0], radius: 0.5 }, material: 'jade' },
  ] } };
  assert.ok(sameFill(compileWith(grouped, BALLS, 'json'), compileWith(grouped, BALLS, 'qssp'), [0.5, 0, 0], 3, 0.25) > 10000);
  const complemented = { materials: MATERIALS, lights: [], root: { intersection: [
    { sphere: { center: [0, 0, 0], radius: 2 }, material: 'stone' },
    { use: '@obj', complement: true, material: 'stone' },
  ] } };
  const source = compileWith(complemented, BALLS, 'json'), opened = compileWith(complemented, BALLS, 'qssp');
  sameFill(source, opened, [0, 0, 0], 2.2, 0.2);
  assert.equal(fillAt(opened, [-0.5, 0, 0]), 'empty', 'the ball taken out');
  assert.equal(fillAt(opened, [0, 1.5, 0]), 'stone');
});

test('one naming its own materials: theirs where it names them, the use\'s where it inherits', () => {
  const spec = { materials: MATERIALS, lights: [], root: { group: [
    { use: '@obj', material: 'gold' },
    { use: '@obj', translate: [4, 0, 0], material: 'stone' },
  ] } };
  const source = compileWith(spec, LAMP, 'json'), used = compileWith(spec, LAMP, 'qssp');
  assert.ok(sameFill(source, used, [2, 0, 0.5], 3.6, 0.15) > 20000);
  assert.equal(fillAt(used, [0, 0, 1.45]), 'jade');
  assert.equal(fillAt(used, [0, 0, 1]), 'ruby');
  assert.equal(fillAt(used, [0, 0, 0.25]), 'gold', 'the stem, the use\'s');
  assert.equal(fillAt(used, [4, 0, 0.25]), 'stone');
  assert.equal(fillAt(used, [4, 0, 1]), 'ruby');
});

test('its reach wraps it, moved with it, and places it', () => {
  const spec = { materials: MATERIALS, lights: [],
                 objects: { thing: { use: '@obj', scale: 2, translate: [5, 0, 0], wrap: 'spheroid' } },
                 root: { plane: { normal: [0, 0, 1], offset: -3 }, material: 'stone', outside: { use: 'thing', material: 'gold' } } };
  const built = compileWith(spec, BALLS, 'qssp');
  assert.equal(fillAt(built, [5 - 1, 0, 0]), 'gold');
  // The wrap is round the moved object: everything gold lies inside it.
  const wrap = built.nodes.find((n, i) => i && n.inside && built.nodes[n.inside].prov?.owner === 'thing' && !n.prov);
  assert.ok(wrap, 'a wrap round it');
  for (const p of [[3.5, 0, 0], [6.5, 0, 0.5], [5, 1.4, 0]]) {
    if (fillAt(built, p) === 'gold') assert.ok(H(wrap.prim, p) < 0, `[${p}] is in its wrap`);
  }

  // Placed: compiled on its own and grafted in, its reach its spheroid.
  const files = { 'scenes/obj.qssp': decodeQSSP(precompiled(BALLS)) };
  const placing = { materials: MATERIALS, lights: [], root: { group: [
    { plane: { normal: [0, 0, 1], offset: -1 }, material: 'stone' },
    { place: '@obj.qssp', material: 'gold', translate: [0, 0, 0.5] },
  ] } };
  const warned = [];
  const base = compileScene(placing, { files, path: PATH, quiet: true });
  const { built: placed } = placeAll(base, placing, { files, path: PATH, warn: (path, msg) => warned.push(`${path}: ${msg}`) });
  assert.deepEqual(warned, []);
  assert.equal(fillAt(placed, [-0.5, 0, 0.5]), 'gold');
  assert.equal(fillAt(placed, [0.75, 0, 0.75]), 'gold');
  assert.equal(fillAt(placed, [0, 0, -2]), 'stone');
});

test('read by reference, as a .qssp or .qssp.gz; a damaged one warned of and left out', async () => {
  const bytes = precompiled(BALLS);
  const zipped = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const store = { 'scenes/obj.qssp': bytes, 'scenes/zip.qssp.gz': zipped, 'scenes/bad.qssp': new Uint8Array(64) };
  const readBytes = async (path) => { if (!store[path]) throw new Error('no such file'); return store[path]; };
  const said = [];
  const spec = { materials: MATERIALS, lights: [], root: { group: [
    { use: '@obj.qssp', material: 'gold' }, { use: '@zip.qssp.gz', material: 'jade', translate: [4, 0, 0] }, { use: '@bad.qssp', translate: [8, 0, 0] },
  ] } };
  const files = await loadReferences(spec, { from: PATH, readBytes, readText: async () => { throw new Error('read as text'); }, warn: (msg) => said.push(msg) });
  assert.ok(files['scenes/obj.qssp'] instanceof QSSPObject);
  assert.ok(files['scenes/zip.qssp.gz'] instanceof QSSPObject);
  assert.ok(said.some((m) => /cannot load "scenes\/bad\.qssp": .*not a precompiled object.*left out/.test(m)), said.join('; '));
  const built = compileScene(spec, { files, path: PATH, quiet: true });
  assert.equal(fillAt(built, [-0.5, 0, 0]), 'gold');
  assert.equal(fillAt(built, [3.5, 0, 0]), 'jade');
});

test('what it can\'t hold yet is refused: lights, a textured face, a place', () => {
  const lit = { sphere: { center: [0, 0, 0], radius: 1 }, lights: [{ pos: [0, 0, 0], color: [1, 1, 1] }] };
  assert.throws(() => precompiled(lit), /has lights, which a precompiled object can't hold yet/);
  const placing = { group: [{ place: 'x' }] };
  assert.throws(() => precompiled(placing), /places objects/);
  const textured = { plane: { normal: [0, 0, 1], offset: 0 }, textureOffset: [0.5, 0.5] };
  assert.throws(() => precompiled(textured), /textured face/);
});
