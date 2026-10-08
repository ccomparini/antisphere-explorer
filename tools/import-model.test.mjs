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
const scene = async (args) => {
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

/** Its one object: the mesh's tree, centred and standing on the floor. */
function checkMesh(got, name, material = 'clay') {
  assert.ok(got.objects[name], `objects.${name}`);
  assert.ok(got.materials[material], `the material ${material}`);
  assert.ok(got.camera && got.lights.length, 'a scene to look at it in');
  const built = compileScene(structuredClone(got));
  assert.ok(built.nodes.length > 4);
}

test('PLY and STL files become scenes, named for the file', async () => {
  checkMesh(await scene([file('tet.ply', PLY)]), 'tet');
  checkMesh(await scene([file('wedge.stl', STL)]), 'wedge');
});

test('--fit, --material and --name, as stl-to-scene takes them', async () => {
  const got = await scene([file('tet.ply', PLY), '--fit', '5', '--material', 'brass', '--name', 'pyramid']);
  checkMesh(got, 'pyramid', 'brass');
  // Placed inside a ball of brass round it: 5 across, so the ball's
  // radius is half its bounds' diagonal, about 4.3 (a side of 5 alone
  // would be 2.5).
  const ball = JSON.stringify(got.root).match(/"sphere":\{"center":\[[^\]]*\],"radius":([0-9.]+)\},"material":"brass"/);
  assert.ok(ball && Math.abs(Number(ball[1]) - 1.01 * Math.sqrt(75) / 2) < 1e-9, `the ball: ${ball?.[0]}`);
});

test('--up turns the axis named onto the scene\'s up', async () => {
  // A box 1 by 4 by 1, tall along y: as written it lies 1 high; with --up y
  // (or -y) it stands 4 high. The ball of material round it says which:
  // centred half its height up.
  const v = [[0, 0, 0], [1, 0, 0], [1, 4, 0], [0, 4, 0], [0, 0, 1], [1, 0, 1], [1, 4, 1], [0, 4, 1]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const box = file('post.stl', Buffer.from(writeSTL(quads.flatMap(([a, b, c, d]) => [[v[a], v[b], v[c]], [v[a], v[c], v[d]]]))));
  const height = (got) => 2 * JSON.parse(JSON.stringify(got.root).match(/"sphere":(\{"center":\[[^\]]*\],"radius":[0-9.e-]+\}),"material":"clay"/)[1]).center[2];
  assert.equal(height(await scene([box])), 1);
  for (const up of ['y', '-y']) {
    const got = await scene([box, '--up', up]);
    assert.ok(Math.abs(height(got) - 4) < 1e-12, `--up ${up}: ${height(got)}`);
    checkMesh(got, 'post');
  }
  assert.ok(Math.abs(height(await scene([box, '--up', 'x'])) - 1) < 1e-12, '--up x: 1 wide, so 1 high');
  assert.match((await run([box, '--up', 'w'])).stderr, /--up w: x, y, z, -x, -y or -z/);
});

test('gzipped, and out of archives: by name after a #, or the one mesh there', async () => {
  checkMesh(await scene([file('tet.ply.gz', gzipSync(PLY))]), 'tet');
  checkMesh(await scene([file('wedge.stl.gz', gzipSync(STL))]), 'wedge');
  const archive = file('models.tar.gz', gzipSync(tar({ 'models/readme.txt': 'hello', 'models/scan/tet.ply': PLY, 'models/wedge.stl.gz': gzipSync(STL) })));
  checkMesh(await scene([`${archive}#models/scan/tet.ply`]), 'tet');
  checkMesh(await scene([`${archive}#models/wedge.stl.gz`]), 'wedge');
  const one = file('one.tgz', gzipSync(tar({ 'readme.txt': 'hi', 'only/tet.ply': PLY })));
  checkMesh(await scene([one]), 'tet');
  checkMesh(await scene([file('plain.tar', tar({ 'tet.ply': PLY }))]), 'tet');
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
    checkMesh(await scene([`${base}/m/tet.ply.gz`]), 'tet');
    checkMesh(await scene([`${base}/m/a.tar.gz#x/wedge.stl`]), 'wedge');
    const missing = await run([`${base}/m/nope.ply`]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /nope.ply: 404/);
  } finally {
    server.close();
  }
  checkMesh(await scene([pathToFileURL(file('tet.ply', PLY)).href]), 'tet');
});

test('-o writes there, gzipped if its name ends .gz; --float32 rounds every number to a float32', async () => {
  const source = file('tet.ply', PLY);
  const plain = join(scratch, 'out/tet.json');
  assert.equal((await run([source, '--fit', '3', '-o', plain])).status, 0);
  const full = JSON.parse(readFileSync(plain, 'utf8'));
  checkMesh(full, 'tet');
  const zipped = join(scratch, 'out/tet32.json.gz');
  assert.equal((await run([source, '--fit', '3', '--float32', '-o', zipped])).status, 0);
  const text = gunzipSync(readFileSync(zipped)).toString();
  const short = JSON.parse(text);
  checkMesh(short, 'tet');
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
