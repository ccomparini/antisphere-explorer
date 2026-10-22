// Tests for the mesh importer, offline: files of our own, local paths and a
// local HTTP server. Run with:
//   node --test tools/import-model.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { writeSTL } from '../public/stl.js';
import { compileScene, isSolid } from '../public/antisphere-scene.js';
import { quadricAt as H } from '../public/quadric.js';
import { fixture, toGLB } from '../public/gltf-fixture.mjs';

const script = fileURLToPath(new URL('./import-model.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'import-model-'));

/** Run the tool: { status, stdout, stderr }. Asynchronous, so a server in this process can answer it. */
function run(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}
const model = async (args) => {
  const got = await run(args);
  assert.equal(got.status, 0, got.stderr);
  return JSON.parse(got.stdout);
};

// A tetrahedron 2 across, as a PLY and as an STL.
const VERTICES = [[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2]];
const FACES = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
const PLY = `ply
format ascii 1.0
element vertex 4
property float x
property float y
property float z
element face 4
property list uchar int vertex_indices
end_header
${VERTICES.map((v) => v.join(' ')).join('\n')}
${FACES.map((f) => `3 ${f.join(' ')}`).join('\n')}
`;
const STL = Buffer.from(writeSTL(FACES.map((f) => f.map((i) => VERTICES[i]))));

/** A ustar archive of { name: bytes or text } files. */
function tar(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write('0000644\0', 100);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('0', 156);
    header.write('ustar\0' + '00', 257);
    header.write('        ', 148);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const file = (name, content) => { const path = join(scratch, name); writeFileSync(path, content); return path; };

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const CLAY = [0.7, 0.5, 0.4], BRASS = [0.7, 0.6, 0.2];

/**
 * What fills point R of a model, as a scene places it: inside a ball of
 * clay, which it is made of unless it names a material of its own - the
 * albedo there, or null where nothing solid is. By trace()'s rules, from
 * the model down: a ray reaches it through the empty space round it,
 * which forgets the ball's own claim.
 */
function albedoAt(got, R) {
  const built = compileScene({
    materials: { clay: { albedo: CLAY }, brass: { albedo: BRASS } },
    lights: [],
    root: { sphere: { center: [0, 0, 0], radius: 100 }, material: 'clay', inside: got },
  });
  let index = built.nodes[1].inside, found = 0;
  while (index) {
    const nd = built.nodes[index];
    if (H(nd.prim, R) < 0) {
      if (isSolid(built.materials[nd.material])) { if (!found) found = index; } else found = 0;
      if (!nd.inside) break;
      index = nd.inside;
    } else {
      found = 0;
      index = nd.outside;
    }
  }
  return found ? built.materials[built.nodes[found].material].albedo : null;
}

// The tetrahedron as placed - centred over the origin, standing on z = 0 -
// spans x and y from -1 to 1 and z from 0 to 2: its centroid is here.
const INSIDE = [-0.5, -0.5, 0.5];

/** The model alone - a subtree, no scene round it - and solid where the mesh is. */
function checkMesh(got, inside = INSIDE, albedo = CLAY) {
  assert.ok(got.spheroid, 'the mesh\'s bounding spheroid, at the top');
  for (const key of ['objects', 'materials', 'lights', 'camera', 'root']) assert.ok(!(key in got), `no ${key}`);
  assert.deepEqual(albedoAt(got, inside), albedo);
  assert.equal(albedoAt(got, [0.9, 0.9, 1.9]), null, 'outside the slanted face');
}

test('PLY and STL files become models: the mesh alone, as a subtree', async () => {
  checkMesh(await model([file('tet.ply', PLY)]));
  checkMesh(await model([file('wedge.stl', STL)]));
});

test('--fit and --material, as stl-to-scene takes them', async () => {
  // 5 across rather than 2: the centroid 2.5 times as far out.
  const got = await model([file('tet.ply', PLY), '--fit', '5', '--material', 'brass']);
  assert.equal(got.material, 'brass');
  assert.deepEqual(albedoAt(got, INSIDE.map((v) => v * 2.5)), BRASS, 'made of brass, whatever is round it');
  assert.equal(albedoAt(got, [2.3, 2.3, 4.8]), null);
  // With none, it names none, and is made of what is round it.
  assert.ok(!('material' in await model([file('tet.ply', PLY)])));
});

test('--up turns the axis named onto the scene\'s up', async () => {
  // A box 1 by 4 by 1, tall along y: as written it lies 1 high, so solid
  // half a unit up and empty 3.5 up; with --up y (or -y) it stands 4 high,
  // solid at both.
  const v = [[0, 0, 0], [1, 0, 0], [1, 4, 0], [0, 4, 0], [0, 0, 1], [1, 0, 1], [1, 4, 1], [0, 4, 1]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const box = file('post.stl', Buffer.from(writeSTL(quads.flatMap(([a, b, c, d]) => [[v[a], v[b], v[c]], [v[a], v[c], v[d]]]))));
  const standing = (got) => [albedoAt(got, [0, 0, 0.5]) !== null, albedoAt(got, [0, 0, 3.5]) !== null];
  assert.deepEqual(standing(await model([box])), [true, false]);
  for (const up of ['y', '-y']) assert.deepEqual(standing(await model([box, '--up', up])), [true, true], `--up ${up}`);
  assert.deepEqual(standing(await model([box, '--up', 'x'])), [true, false], '--up x: 1 wide, so 1 high');
  assert.match((await run([box, '--up', 'w'])).stderr, /--up w: x, y, z, -x, -y or -z/);
});

test('gzipped, and out of archives: by name after a #, or the one mesh there', async () => {
  checkMesh(await model([file('tet.ply.gz', gzipSync(PLY))]));
  checkMesh(await model([file('wedge.stl.gz', gzipSync(STL))]));
  const archive = file('models.tar.gz', gzipSync(tar({ 'models/readme.txt': 'hello', 'models/scan/tet.ply': PLY, 'models/wedge.stl.gz': gzipSync(STL) })));
  checkMesh(await model([`${archive}#models/scan/tet.ply`]));
  checkMesh(await model([`${archive}#models/wedge.stl.gz`]));
  const one = file('one.tgz', gzipSync(tar({ 'readme.txt': 'hi', 'only/tet.ply': PLY })));
  checkMesh(await model([one]));
  checkMesh(await model([file('plain.tar', tar({ 'tet.ply': PLY }))]));
  const which = await run([archive]);
  assert.equal(which.status, 1);
  assert.match(which.stderr, /holds 2 meshes; name one after a #:\n {2}models\/scan\/tet.ply\n {2}models\/wedge.stl.gz/);
  assert.match((await run([`${archive}#models/nope.ply`])).stderr, /has no models\/nope.ply/);
  assert.match((await run([`${file('tet.ply', PLY)}#x.ply`])).stderr, /is not an archive/);
  assert.match((await run([file('notes.txt', 'hello')])).stderr, /not a mesh this reads/);
});

test('from a URL, http or file', async () => {
  const served = { '/m/tet.ply.gz': gzipSync(PLY), '/m/a.tar.gz': gzipSync(tar({ 'x/wedge.stl': STL })) };
  const server = createServer((req, res) => {
    const body = served[req.url];
    res.writeHead(body ? 200 : 404);
    res.end(body ?? 'not found');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    checkMesh(await model([`${base}/m/tet.ply.gz`]));
    checkMesh(await model([`${base}/m/a.tar.gz#x/wedge.stl`]));
    const missing = await run([`${base}/m/nope.ply`]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /nope.ply: 404/);
  } finally {
    server.close();
  }
  checkMesh(await model([pathToFileURL(file('tet.ply', PLY)).href]));
});

test('-o writes there, gzipped if its name ends .gz; --float32 rounds every number to a float32', async () => {
  const source = file('tet.ply', PLY);
  const plain = join(scratch, 'out/tet.json');
  assert.equal((await run([source, '--fit', '3', '-o', plain])).status, 0);
  const full = JSON.parse(readFileSync(plain, 'utf8'));
  checkMesh(full);
  const zipped = join(scratch, 'out/tet32.json.gz');
  assert.equal((await run([source, '--fit', '3', '--float32', '-o', zipped])).status, 0);
  const text = gunzipSync(readFileSync(zipped)).toString();
  const short = JSON.parse(text);
  checkMesh(short);
  const numbers = (value, out = []) => {
    if (typeof value === 'number') out.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => numbers(v, out));
    return out;
  };
  const before = numbers(full), after = numbers(short);
  assert.equal(after.length, before.length);
  // Each the same float32 as the full number, written as briefly as that allows.
  after.forEach((v, i) => assert.equal(Math.fround(v), Math.fround(before[i]), `number ${i}: ${v} for ${before[i]}`));
  assert.ok(before.some((v, i) => v !== after[i]), 'some were rounded');
  assert.ok(text.match(/\d\.\d{10,}/) === null, 'none written with more digits than a float32 needs');
});

test('what it cannot do, it says', async () => {
  const none = await run([]);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /import-model - convert a mesh/);
  assert.match((await run(['a.ply', '--fit', '-1'])).stderr, /--fit needs a positive number/);
  assert.match((await run(['a.ply', '--bogus'])).stderr, /unknown option --bogus/);
  assert.match((await run(['a.ply', 'b.ply'])).stderr, /one source at a time/);
});

// -- glTF: the tiny skinned model of public/gltf-fixture.mjs --------------------

const glbFile = () => {
  const file = join(scratch, 'chain.glb');
  writeFileSync(file, toGLB(fixture()));
  return file;
};

test('a skinned glTF is a model with a skeleton: an object per bone, in its rest pose, and the whole', async () => {
  const m = await model([glbFile()]);
  assert.deepEqual(m.skeleton.bones.map((b) => b.name), ['j0', 'j1', 'j2']);
  assert.ok(m.skeleton.base, 'with its base frame');
  assert.deepEqual(Object.keys(m.objects).sort(), ['j0', 'j1', 'j2', 'model']);
  assert.deepEqual(m.objects.model, { group: ['@#/objects/j0', '@#/objects/j1', '@#/objects/j2'] },
                   'the whole, named "model" on stdout, its parts referred to within the file');
  assert.equal(m.objects.j0.material, 'M_Skin', 'mesh parts: the source\'s own material');
  // Placed in a scene, at rest: j0's tube round the scene's z axis, from 0.1 to 0.9.
  const built = compileScene({ materials: { M_Skin: {} }, lights: [], objects: m.objects, root: { use: 'model' } });
  const solid = (p) => {
    let i = 1, found = 0;
    while (i) {
      const n = built.nodes[i];
      if (H(n.prim, p) < 0) { if (isSolid(built.materials[n.material])) found = found || i; else found = 0; if (!n.inside) break; i = n.inside; }
      else { found = 0; i = n.outside; }
    }
    return !!found;
  };
  assert.equal(solid([0, 0, 0.5]), true, 'inside j0\'s tube');
  assert.equal(solid([0.5, 0, 0.5]), false, 'beside it');
});

test('--parts spheroid and bones, of <prefix>-...; --name names the whole', async () => {
  const sph = await model([glbFile(), '--parts', 'spheroid', '--prefix', 'robot', '--name', 'chain']);
  assert.deepEqual(Object.keys(sph.objects).sort(), ['chain', 'j0', 'j1'], 'the thin j2 folded into j1');
  assert.equal(sph.objects.j0.material, 'robot-skin');
  const bones = await model([glbFile(), '--parts', 'bones']);
  assert.equal(bones.objects.j0.material, 'figure-bone');
  assert.ok(bones.objects.j2.sphere, 'the end bone a ball');
  assert.match((await run([glbFile(), '--parts', 'clay'])).stderr, /--parts clay: mesh, spheroid or bones/);
});

test('--overlap shares a blended band; --fit scales the skeleton too, and says so', async () => {
  const plain = await model([glbFile()]), shared = await model([glbFile(), '--overlap', '0.3']);
  assert.notDeepEqual(shared.objects.j1, plain.objects.j1, 'j1\'s piece takes in the band it weighs 0.4');
  const fitted = await model([glbFile(), '--parts', 'spheroid', '--fit', '4']);
  assert.ok(Math.abs(fitted.scale - 2) < 1e-6, `scale ${fitted.scale}: 2 tall (0.1 to 2.1) made 4`);
  assert.deepEqual(fitted.skeleton.bones[1].translation.map((v) => +v.toFixed(6)), [0, 2, 0], 'j1 two up now');
});

test('--no-skeleton: the geometry alone, at rest, as one model', async () => {
  const m = await model([glbFile(), '--no-skeleton', '--material', 'clay']);
  assert.equal(m.skeleton, undefined);
  assert.equal(m.material, 'clay');
  assert.ok(m.spheroid || m.sphere, 'one tree, wrapped');
});
