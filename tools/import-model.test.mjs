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
import { compileScene } from '../public/antisphere-scene.js';

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
const H = (prim, R) => {
  const along = dot(prim.axis, R);
  return prim.k_perp * dot(R, R) + (prim.k_par - prim.k_perp) * along * along + 2 * dot(prim.linear, R) + prim.constant;
};
const CLAY = [0.7, 0.5, 0.4], BRASS = [0.7, 0.6, 0.2], WEDGE = [0.2, 0.3, 0.9];

/**
 * What fills point R of a model, as a scene places it: inside a ball of
 * clay, which it is made of unless it names a material of its own - the
 * albedo there, or null where nothing solid is. By trace()'s rules, from
 * the model down: a ray reaches it through the empty space round it,
 * which forgets the ball's own claim.
 */
function albedoAt(got, R) {
  const built = compileScene({
    materials: { clay: { albedo: CLAY }, brass: { albedo: BRASS }, wedge: { albedo: WEDGE } },
    lights: [],
    root: { sphere: { center: [0, 0, 0], radius: 100 }, material: 'clay', inside: got },
  });
  let index = built.nodes[1].inside, found = 0;
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

// The tetrahedron as placed - centred over the origin, standing on z = 0 -
// spans x and y from -1 to 1 and z from 0 to 2: its centroid is here.
const INSIDE = [-0.5, -0.5, 0.5];

/**
 * The model alone - a subtree, no scene round it - and solid where the mesh
 * is: made of the material it names (an STL, wedge.stl here, names its
 * file's), or, naming none (a PLY), of the clay round it.
 */
function checkMesh(got, inside = INSIDE, albedo = got.material === 'wedge' ? WEDGE : CLAY) {
  assert.ok(got.spheroid, 'the mesh\'s bounding spheroid, at the top');
  for (const key of ['objects', 'materials', 'lights', 'camera', 'root']) assert.ok(!(key in got), `no ${key}`);
  assert.deepEqual(albedoAt(got, inside), albedo);
  assert.equal(albedoAt(got, [0.9, 0.9, 1.9]), null, 'outside the slanted face');
}

test('PLY and STL files become models: the mesh alone, as a subtree', async () => {
  const ply = await model([file('tet.ply', PLY)]);
  assert.ok(!('material' in ply), 'a PLY names no material');
  checkMesh(ply);
  const stl = await model([file('wedge.stl', STL)]);
  assert.equal(stl.material, 'wedge', 'an STL, only geometry, names one for its file');
  checkMesh(stl);
  assert.equal((await model([file('wedge.stl', STL), '--material', 'brass'])).material, 'brass', 'unless told');
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
