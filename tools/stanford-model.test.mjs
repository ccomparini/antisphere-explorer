// Tests for the Stanford model fetcher, offline: an archive of our own,
// shaped like the repository's, given with --archive. Run with:
//   node --test tools/stanford-model.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { compileScene } from '../public/antisphere-scene.js';

const script = fileURLToPath(new URL('./stanford-model.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'stanford-'));

/** A ustar archive of { name: text } files. */
function tar(files) {
  const blocks = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0' + '00', 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// A tetrahedron, outward, as the repository writes its reconstructions.
const tetrahedronPLY = `ply
format ascii 1.0
comment zipper output
element vertex 4
property float x
property float y
property float z
element face 4
property list uchar int vertex_indices
end_header
0 0 0
1 0 0
0 1 0
0 0 1
3 0 2 1
3 0 1 3
3 0 3 2
3 1 2 3
`;

test('a model is converted from its archive into a parts file that compiles', () => {
  const archive = join(scratch, 'bunny.tar.gz');
  writeFileSync(archive, gzipSync(tar({
    'bunny/README': 'not this one',
    'bunny/reconstruction/bun_zipper.ply': tetrahedronPLY,
  })));
  const out = join(scratch, 'bunny.json');
  const said = execFileSync('node', [script, 'bunny', '--archive', archive, '-o', out],
                            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(said, '', 'it reports on stderr, not stdout');

  const part = JSON.parse(readFileSync(out, 'utf8'));
  assert.match(part._comment, /Stanford 3D Scanning Repository/);
  assert.deepEqual(Object.keys(part.objects), ['bunny']);
  assert.ok('bunny' in part.materials);

  // As a scene would have it: imported, and used.
  const built = compileScene({
    import: ['parts/bunny.json'],
    materials: {},
    lights: [],
    root: { sphere: { center: [0, 0, 0], radius: 50 }, inside: { use: 'bunny:bunny' } },
  }, { imports: { 'parts/bunny.json': part } });
  // The scene's sphere, the tetrahedron's spheroid, and its four faces.
  assert.equal(built.nodes.length - 1, 6);
});

test('an unknown model says which there are', () => {
  const run = spawnSync('node', [script, 'teapot'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /models: bunny, dragon/);
});
