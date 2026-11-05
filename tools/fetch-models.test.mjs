// Tests for fetch-models.mjs, offline: a local HTTP server, and a scratch
// directory standing for the repository. Run with:
//   node --test tools/fetch-models.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSTL } from '../public/stl.js';
import { ensureModels, isFetched, MODELS } from './fetch-models.mjs';

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

test('fetched where it goes, checked; there already, not fetched again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fetch-models-'));
  assert.equal(await ensureModels(['note'], { models, root }), null);
  assert.equal(readFileSync(join(root, 'models/note.txt'), 'utf8'), 'a model\n');
  asked.length = 0;
  assert.equal(await ensureModels(['note'], { models, root }), null);
  assert.deepEqual(asked, [], 'not asked for again');
  assert.equal(await ensureModels(['note'], { models, root, force: true }), null);
  assert.deepEqual(asked, ['/note.txt'], '--force: again');
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
