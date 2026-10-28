// Tests for tools/render.mjs: a small scene, written beside a material
// library it references, rendered to PNGs and read back. Needs a GPU; without
// one (or without `npm install`), skips, as public/gpu.test.mjs does.
// Run with:
//   node --test tools/render.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync, gzipSync } from 'node:zlib';
import { writeSTL } from '../public/stl.js';

const script = fileURLToPath(new URL('./render.mjs', import.meta.url));

/** A PNG's size and its RGB pixels (filter type 0 rows, as render.mjs writes them). */
function readPNG(file) {
  const bytes = readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a PNG');
  let width, height;
  const idat = [];
  for (let at = 8; at < bytes.length;) {
    const n = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
    if (type === 'IHDR') { width = bytes.readUInt32BE(at + 8); height = bytes.readUInt32BE(at + 12); }
    if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + n));
    at += 12 + n;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const pixel = (x, y) => [...raw.subarray(y * (width * 3 + 1) + 1 + x * 3, y * (width * 3 + 1) + 4 + x * 3)];
  return { width, height, pixel };
}

test('a scene to a PNG: the scene\'s camera, or moved; a size whose rows need padding; a debug view', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'));
  try {
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'lib/paint.json'), JSON.stringify({ red: { albedo: [0.9, 0.1, 0.1] }, sky: { kind: 'unlit', albedo: [0.1, 0.2, 0.9] } }));
    writeFileSync(join(dir, 'ball.json'), JSON.stringify({
      materials: '@lib/paint.json',
      lights: [{ pos: [3, -4, 5], color: [60, 60, 60] }],
      camera: { position: [0, -5, 0], direction: [0, 1, 0], distance: 5 },
      root: { sphere: { center: [0, 0, 0], radius: 40 }, material: null, inside: { group: [
        { sphere: { center: [0, 0, 0], radius: 1 }, material: 'red' },
        { sphere: { center: [0, 0, 0], radius: 39 }, complement: true, material: 'sky' },
      ] } },
    }));
    const run = (...args) => spawnSync('node', [script, ...args], { cwd: dir, encoding: 'utf8' });
    const first = run('ball.json', '--size', '33x17');
    if (/no usable GPU|needs the webgpu package/.test(first.stderr)) return t.skip(first.stderr.trim());
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /ball\.json: \d+ nodes, 1 lights, 33x17 -> ball\.png/);

    const png = readPNG(join(dir, 'ball.png'));
    assert.deepEqual([png.width, png.height], [33, 17]);
    const [r, g, b] = png.pixel(16, 8), [r2, g2, b2] = png.pixel(0, 0);
    assert.ok(r > g && r > b, `the middle is the red ball: ${[r, g, b]}`);
    assert.ok(b2 > r2 && b2 > g2, `a corner is the blue sky: ${[r2, g2, b2]}`);
    // Each row lines up: every row's middle pixel is red, the ball being round and centred.
    assert.ok(png.pixel(16, 6)[0] > png.pixel(16, 6)[2] && png.pixel(16, 10)[0] > png.pixel(16, 10)[2], 'rows aren\'t skewed');

    // Looked at from elsewhere: the camera turned away from the ball sees sky alone.
    const away = run('ball.json', '--size', '33x17', '--eye', '0,-5,0', '--target', '0,-10,0', '-o', 'away.png');
    assert.equal(away.status, 0, away.stderr);
    const [ar, , ab] = readPNG(join(dir, 'away.png')).pixel(16, 8);
    assert.ok(ab > ar, 'facing away, the middle is sky');

    const normals = run(join(dir, 'ball.json'), '--size', '33x17', '--view', 'normals', '--no-shadows', '-o', 'normals.png');
    assert.equal(normals.status, 0, normals.stderr);
    assert.match(normals.stderr, /normals, no shadows/);
    assert.notDeepEqual(readPNG(join(dir, 'normals.png')).pixel(16, 8), png.pixel(16, 8), 'a different view');

    // Read as the page reads a scene: gzipped, and an STL on its own, in a
    // scene made round it (a floor, a sky, lights, a camera on it).
    writeFileSync(join(dir, 'ball.json.gz'), gzipSync(readFileSync(join(dir, 'ball.json'))));
    const gz = run('ball.json.gz', '--size', '33x17');
    assert.equal(gz.status, 0, gz.stderr);
    assert.deepEqual(readPNG(join(dir, 'ball.png')).pixel(16, 8), png.pixel(16, 8), 'the same ball, written as ball.png');
    const T = [[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2]];
    writeFileSync(join(dir, 'tet.stl'), Buffer.from(writeSTL([[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]].map((f) => f.map((i) => T[i])))));
    const stl = run('tet.stl', '--size', '33x17');
    assert.equal(stl.status, 0, stl.stderr);
    assert.match(stl.stderr, /tet\.stl: \d+ nodes, 3 lights, 33x17 -> tet\.png/);

    assert.match(run('none.json').stderr, /render: no scene none\.json/);
    assert.match(run('ball.json', '--eye', '1,2').stderr, /--eye 1,2: x,y,z/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
