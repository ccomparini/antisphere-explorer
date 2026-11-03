// Tests for png.js: written and read back through every filter, and files of
// every colour type and bit depth built by hand. Run with:
//   node --test public/png.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodePNG, encodePNG } from './png.js';

// A test image: every pixel different, so a filter mistake shows.
function picture(width, height) {
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    rgba.set([(p * 37) & 255, (p * 91 + 13) & 255, (p * 151 + 101) & 255, (p * 19 + 200) & 255], p * 4);
  }
  return rgba;
}

test('written and read back, RGB and RGBA, through every filter', async () => {
  const W = 7, H = 10, rgba = picture(W, H);
  for (const alpha of [false, true]) {
    const png = await encodePNG(rgba, W, H, { alpha, filter: (y) => y % 5 });
    const got = await decodePNG(png);
    assert.deepEqual([got.width, got.height], [W, H]);
    const want = alpha ? rgba : rgba.map((v, i) => (i % 4 === 3 ? 255 : v));
    assert.deepEqual(got.rgba, want, alpha ? 'RGBA' : 'RGB, alpha 255');
  }
});

// A PNG built by hand from its header fields and raw (filter 0) rows.
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function handmade({ width, height, depth, type, rows, palette, trns, interlace = 0 }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = depth; header[9] = type; header[12] = interlace;
  const raw = Buffer.concat(rows.map((r) => Buffer.from([0, ...r])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
                        ...(palette ? [chunk('PLTE', palette)] : []), ...(trns ? [chunk('tRNS', trns)] : []),
                        chunk('IDAT', deflateSync(raw)), chunk('IEND', [])]);
}
const pixels = (got) => Array.from({ length: got.width * got.height }, (_, p) => [...got.rgba.subarray(p * 4, p * 4 + 4)]);

test('every colour type and bit depth: grey, grey+alpha, palette (with transparency), 1, 2, 4 and 16 bits', async () => {
  // Greyscale, 1 bit: 0 and 1 are black and white.
  assert.deepEqual(pixels(await decodePNG(handmade({ width: 3, height: 1, depth: 1, type: 0, rows: [[0b10100000]] }))),
                   [[255, 255, 255, 255], [0, 0, 0, 255], [255, 255, 255, 255]]);
  // Greyscale, 4 bits: 0x5 is 5/15 of white.
  assert.deepEqual(pixels(await decodePNG(handmade({ width: 2, height: 1, depth: 4, type: 0, rows: [[0x5f]] }))),
                   [[85, 85, 85, 255], [255, 255, 255, 255]]);
  // Greyscale with alpha, 8 bits.
  assert.deepEqual(pixels(await decodePNG(handmade({ width: 1, height: 1, depth: 8, type: 4, rows: [[100, 50]] }))),
                   [[100, 100, 100, 50]]);
  // RGB, 16 bits: the high byte of each.
  assert.deepEqual(pixels(await decodePNG(handmade({ width: 1, height: 1, depth: 16, type: 2, rows: [[1, 2, 3, 4, 5, 6]] }))),
                   [[1, 3, 5, 255]]);
  // Palette, 2 bits, the second entry half transparent.
  const palette = [255, 0, 0, 0, 255, 0, 0, 0, 255];
  assert.deepEqual(pixels(await decodePNG(handmade({ width: 3, height: 1, depth: 2, type: 3, palette, trns: [255, 128],
                                                     rows: [[0b00011000]] }))),
                   [[255, 0, 0, 255], [0, 255, 0, 128], [0, 0, 255, 255]]);
});

test('what isn\'t read says so, by name: interlaced, not a PNG', async () => {
  const interlaced = handmade({ width: 1, height: 1, depth: 8, type: 2, rows: [[1, 2, 3]], interlace: 1 });
  await assert.rejects(decodePNG(interlaced, { name: 'brick.png' }), /brick\.png: interlaced/);
  await assert.rejects(decodePNG(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), { name: 'x.png' }), /x\.png: not a PNG/);
});
