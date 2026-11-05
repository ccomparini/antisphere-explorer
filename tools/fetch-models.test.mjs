// Tests for fetch-models.mjs, offline: a local HTTP server, and a scratch
// directory standing for the repository. Run with:
//   node --test tools/fetch-models.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSTL } from '../public/stl.js';
import { gunzipSync } from 'node:zlib';
import { archiveModels, cleanModels, ensureModels, isFetched, MODELS } from './fetch-models.mjs';
import { tar, untar } from './sources.mjs';

// A tetrahedron, as an STL, and a file of text.
const TET = new Uint8Array(writeSTL([[[0, 0, 0], [0, 1, 0], [1, 0, 0]], [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
                      [[0, 0, 0], [0, 0, 1], [0, 1, 0]], [[1, 0, 0], [0, 1, 0], [0, 0, 1]]]));
const files = { '/tet.stl': TET, '/note.txt': new TextEncoder().encode('a model\n') };
const asked = [];
const server = createServer((req, res) => {
  asked.push(req.url);
  if (files[req.url]) { res.writeHead(200); res.end(files[req.url]); } else { res.writeHead(404); res.end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;
const sum = (bytes) => createHash('sha256').update(bytes).digest('hex');

const models = [
  { name: 'note', about: 'a file', files: [{ url: `${base}/note.txt`, to: 'models/note.txt', sha256: sum(files['/note.txt']) }] },
  { name: 'changed', about: 'a file whose sum is not as recorded',
    files: [{ url: `${base}/note.txt`, to: 'models/changed.txt', sha256: '0'.repeat(64) }] },
  { name: 'gone', about: 'not there', files: [{ url: `${base}/gone.stl`, to: 'models/gone.stl', sha256: '0'.repeat(64) }] },
  { name: 'tet', about: 'a mesh, converted', files: [{ url: `${base}/tet.stl`, to: 'sources/tet.stl', sha256: sum(TET) }],
    import: ['sources/tet.stl', '--fit', '2', '-o', 'parts/tet.json'], outputs: ['parts/tet.json'] },
];

test('fetched where it goes, checked; there already, not fetched again; cleaned, fetched afresh', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fetch-models-'));
  assert.equal(await ensureModels(['note'], { models, root }), null);
  assert.equal(readFileSync(join(root, 'models/note.txt'), 'utf8'), 'a model\n');
  asked.length = 0;
  assert.equal(await ensureModels(['note'], { models, root }), null);
  assert.deepEqual(asked, [], 'not asked for again');
  assert.deepEqual(cleanModels(['note'], { models, root }), ['models/note.txt']);
  assert.ok(!existsSync(join(root, 'models/note.txt')));
  assert.equal(await ensureModels(['note'], { models, root }), null);
  assert.deepEqual(asked, ['/note.txt'], 'cleaned: fetched afresh');
  assert.throws(() => cleanModels(['nothing'], { models, root }), /no model "nothing"/);
});

test('cleaned, every one: their files, what they made, downloads kept as .unverified, and all of parts/fetched/', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fetch-models-'));
  for (const name of ['note', 'changed', 'tet']) await ensureModels([name], { models, root });     // changed fails, as it should
  const stray = join(root, 'public/scenes/parts/fetched/old-atlas.png');
  mkdirSync(join(root, 'public/scenes/parts/fetched'), { recursive: true });
  writeFileSync(stray, 'stale');
  const deleted = cleanModels([], { models, root });
  assert.deepEqual(deleted.sort(), ['models/changed.txt.unverified', 'models/note.txt', 'parts/tet.json',
                                    'public/scenes/parts/fetched', 'sources/tet.stl'].sort());
  assert.ok(!existsSync(stray) && !existsSync(join(root, 'parts/tet.json')));
});

test('an archive: the models\' downloads and what they were converted to, named from the root, as tar reads them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fetch-models-'));
  for (const name of ['note', 'tet']) assert.equal(await ensureModels([name], { models, root }), null);
  const file = join(root, 'out', 'models.tar.gz');
  const paths = archiveModels(['note', 'tet'], file, { models, root });
  assert.deepEqual(paths, ['models/note.txt', 'sources/tet.stl', 'parts/tet.json']);
  const read = untar(new Uint8Array(gunzipSync(readFileSync(file))));
  assert.deepEqual([...read.keys()], paths);
  for (const p of paths) assert.deepEqual([...read.get(p)], [...readFileSync(join(root, p))], p);
  // GNU tar reads it too: unpacked elsewhere, the same files.
  const there = mkdtempSync(join(tmpdir(), 'fetch-models-'));
  const unpacked = spawnSync('tar', ['xzf', file, '-C', there]);
  if (unpacked.error?.code !== 'ENOENT') {
    assert.equal(unpacked.status, 0, String(unpacked.stderr));
    for (const p of paths) assert.deepEqual([...readFileSync(join(there, p))], [...readFileSync(join(root, p))], `tar: ${p}`);
    assert.ok(isFetched(models[3], there), 'fetched, there, as far as the script can tell');
  }
  assert.throws(() => archiveModels(['changed'], file, { models, root }), /not fetched, so not archived: changed/);
});

test('tar(): a name past 100 characters goes in ustar\'s prefix', () => {
  const name = `public/scenes/parts/fetched/${'deep/'.repeat(20)}model.json`;
  const bytes = new TextEncoder().encode('{}');
  const read = untar(tar([{ name, bytes }]));
  assert.deepEqual([...read.keys()], [name]);
  const where = mkdtempSync(join(tmpdir(), 'fetch-models-'));
  writeFileSync(join(where, 'long.tar'), tar([{ name, bytes }]));
  const listed = spawnSync('tar', ['tf', join(where, 'long.tar')], { encoding: 'utf8' });
  if (listed.error?.code !== 'ENOENT') assert.equal(listed.stdout.trim(), name);
});

test('the command line: --list fetches nothing; what it doesn\'t know, it says', () => {
  const script = fileURLToPath(new URL('./fetch-models.mjs', import.meta.url));
  const list = spawnSync(process.execPath, [script, '--list'], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout.trim().split('\n').length, MODELS.length);
  assert.match(list.stdout, /^ {2}(fetched|missing) {2}box /m);
  const bad = spawnSync(process.execPath, [script, '--all'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--all\? \(--help\)/);
  const zip = spawnSync(process.execPath, [script, '--archive=models.zip'], { encoding: 'utf8' });
  assert.match(zip.stderr, /--archive models\.zip: a \.tar\.gz/);
  const spaced = spawnSync(process.execPath, [script, '--archive', 'models.zip', 'box'], { encoding: 'utf8' });
  assert.match(spaced.stderr, /--archive models\.zip: a \.tar\.gz/, 'or with a space');
  const nobody = spawnSync(process.execPath, [script, 'nothing'], { encoding: 'utf8' });
  assert.match(nobody.stderr, /no model "nothing"/);
});

test('a sum not as recorded: an error naming both, the file kept as .unverified to look at', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fetch-models-'));
  const why = await ensureModels(['changed'], { models, root });
  assert.match(why, /changed not fetched: .*note\.txt: its SHA-256 is [0-9a-f]{64}, not 0{64}.*kept as models\/changed\.txt\.unverified.*node tools\/fetch-models\.mjs changed/);
  assert.ok(!existsSync(join(root, 'models/changed.txt')), 'not where it would be taken as good');
  assert.equal(readFileSync(join(root, 'models/changed.txt.unverified'), 'utf8'), 'a model\n');
  assert.match(await ensureModels(['gone'], { models, root }), /gone not fetched: .*gone\.stl: 404/);
  assert.match(await ensureModels(['nothing'], { models, root }), /no model "nothing"/);
});

test('a scene model: fetched, then converted by import-model, as a person would', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fetch-models-'));
  assert.ok(!isFetched(models[3], root));
  assert.equal(await ensureModels(['tet'], { models, root }), null);
  assert.ok(isFetched(models[3], root));
  const model = JSON.parse(readFileSync(join(root, 'parts/tet.json'), 'utf8'));
  assert.deepEqual(model._meta.dimensions, [2, 2, 2], '--fit 2');
});

test('the manifest: every file pinned and summed; every scene model\'s outputs under parts/fetched', () => {
  for (const m of MODELS) {
    for (const f of m.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/, `${m.name}: ${f.to}`);
      assert.ok(!/\/main\//.test(f.url), `${m.name}: pinned, not main: ${f.url}`);
    }
    if (m.import) assert.ok(m.outputs.every((o) => o.startsWith('public/scenes/parts/fetched/')), m.name);
  }
});
