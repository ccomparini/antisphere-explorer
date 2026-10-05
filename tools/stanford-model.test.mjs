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
import { gzipSync, gunzipSync } from 'node:zlib';
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
  assert.equal(part.materials, undefined, 'a scan has no materials');

  // As a scene would have it: imported, and used.
  const built = compileScene({
    import: ['parts/bunny.json'],
    materials: { clay: {} },
    lights: [],
    root: { sphere: { center: [0, 0, 0], radius: 50 }, inside: { use: 'bunny:bunny', material: 'clay' } },
  }, { imports: { 'parts/bunny.json': part } });
  // The scene's sphere, the tetrahedron's spheroid, and its four faces.
  assert.equal(built.nodes.length - 1, 6);
});

test('numbers are float32, in as few digits as give it back; .gz output is gzipped', () => {
  const archive = join(scratch, 'bunny2.tar.gz');
  writeFileSync(archive, gzipSync(tar({ 'bunny/reconstruction/bun_zipper.ply': tetrahedronPLY })));
  const runTo = (out, ...more) => execFileSync('node', [script, 'bunny', '--archive', archive, '-o', out, ...more],
                                               { stdio: ['ignore', 'pipe', 'pipe'] });
  const floatOut = join(scratch, 'f.json.gz'), doubleOut = join(scratch, 'd.json');
  runTo(floatOut);
  runTo(doubleOut, '--precision', 'double');
  const numbers = (text) => text.match(/-?\d+\.\d+(e-?\d+)?/g).map(Number);
  const asFloat = numbers(gunzipSync(readFileSync(floatOut)).toString());
  const asDouble = numbers(readFileSync(doubleOut, 'utf8'));
  assert.equal(asFloat.length, asDouble.length);
  asFloat.forEach((x, i) => {
    assert.equal(Math.fround(x), Math.fround(asDouble[i]), `${x} is ${asDouble[i]} as float32`);
    assert.ok(String(x).replace(/^-?0?\.?|e.*$/g, '').replace('.', '').length <= 9, `${x}: at most 9 digits`);
  });
  assert.ok(asDouble.some((x) => String(x).length > 12), 'the doubles were longer');
});

test('an unknown model says which there are', () => {
  const run = spawnSync('node', [script, 'teapot'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /models: bunny, dragon/);
});
