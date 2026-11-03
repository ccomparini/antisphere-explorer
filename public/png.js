// PNG, read and written: one module for the page, the tools and the tests.
// Textures are read with it (decodePNG()), and the tools write their
// renders with it (encodePNG()). Compression is the platform's own
// (DecompressionStream and CompressionStream, "deflate" - zlib, as PNG
// has it), in the browser and in Node alike.
//
// Read: every colour type - greyscale, greyscale with alpha, RGB, RGBA and
// palette (with tRNS transparency) - at every bit depth (16 is taken to
// its high byte, 1, 2 and 4 unpacked), all five filters. Not interlaced
// (Adam7), which is an error that names the file: re-save it plain.
// Colours come back as they are in the file, 8 bits a channel, which for a
// PNG means sRGB; what reads them as light converts (the shader does).

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function through(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

// The Paeth predictor, PNG's filter 4.
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Channels per pixel, by colour type.
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * A PNG's pixels: { width, height, rgba } (Uint8Array, 4 bytes a pixel, rows
 * top to bottom). `name` says which file, in errors.
 */
export async function decodePNG(bytes, { name = 'PNG' } = {}) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error(`${name}: not a PNG`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width, height, depth, type, interlace, palette = null, alphas = null;
  const data = [];
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = view.getUint32(at), kind = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (kind === 'IHDR') {
      width = view.getUint32(at + 8); height = view.getUint32(at + 12);
      depth = body[8]; type = body[9]; interlace = body[12];
    } else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') alphas = body;
    else if (kind === 'IDAT') data.push(body);
    else if (kind === 'IEND') break;
    at += 12 + length;
  }
  if (!width || CHANNELS[type] === undefined) throw new Error(`${name}: no image header, or a colour type PNG hasn't`);
  if (interlace) throw new Error(`${name}: interlaced (Adam7), which isn't read: save it without interlacing`);
  if (type === 3 && !palette) throw new Error(`${name}: a palette image with no palette`);

  const raw = await through(data.length === 1 ? data[0] : new Uint8Array(await new Blob(data).arrayBuffer()),
                            new DecompressionStream('deflate'));
  const channels = CHANNELS[type];
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const step = Math.max(1, bitsPerPixel >> 3);      // bytes back to "the pixel to the left"
  if (raw.length < (stride + 1) * height) throw new Error(`${name}: its image data is short`);

  // Unfilter row by row, in place, into `rows`.
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    const up = y ? rows.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= step ? out[x - step] : 0, b = up ? up[x] : 0, c = up && x >= step ? up[x - step] : 0;
      const v = line[x];
      out[x] = filter === 0 ? v
        : filter === 1 ? v + a
        : filter === 2 ? v + b
        : filter === 3 ? v + ((a + b) >> 1)
        : filter === 4 ? v + paeth(a, b, c)
        : (() => { throw new Error(`${name}: unknown filter ${filter} in row ${y}`); })();
    }
  }

  // Each sample, 8 bits: 16 to its high byte, 1, 2 and 4 unpacked (and, for
  // greyscale, scaled up to 0-255; a palette index stays an index).
  const sample = (y, k) => {
    const row = rows.subarray(y * stride, (y + 1) * stride);
    if (depth === 8) return row[k];
    if (depth === 16) return row[2 * k];
    const per = 8 / depth, v = (row[Math.floor(k / per)] >> (8 - depth * (1 + (k % per)))) & ((1 << depth) - 1);
    return type === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, k = x * channels;
      if (type === 3) {
        const i = sample(y, k);
        rgba.set([palette[3 * i], palette[3 * i + 1], palette[3 * i + 2], alphas && i < alphas.length ? alphas[i] : 255], o);
      } else if (type === 0 || type === 4) {
        const g = sample(y, k);
        rgba.set([g, g, g, type === 4 ? sample(y, k + 1) : 255], o);
      } else {
        rgba.set([sample(y, k), sample(y, k + 1), sample(y, k + 2), type === 6 ? sample(y, k + 3) : 255], o);
      }
    }
  }
  return { width, height, rgba };
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * An 8-bit PNG of `rgba` pixels (4 bytes each, rows top to bottom): RGB, or
 * with `alpha`, RGBA. `filter(y)` picks each row's filter (0 to 4; 0, none,
 * by default) - the tests write every one.
 */
export async function encodePNG(rgba, width, height, { alpha = false, filter = () => 0 } = {}) {
  const channels = alpha ? 4 : 3, stride = width * channels;
  const rows = new Uint8Array(stride * height);
  for (let p = 0; p < width * height; p++) {
    for (let c = 0; c < channels; c++) rows[p * channels + c] = rgba[p * 4 + c];
  }
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const f = filter(y), line = rows.subarray(y * stride, (y + 1) * stride);
    const up = y ? rows.subarray((y - 1) * stride, y * stride) : null;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0, b = up ? up[x] : 0, c = up && x >= channels ? up[x - channels] : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      raw[y * (stride + 1) + 1 + x] = (line[x] - pred) & 0xff;
    }
  }
  const header = new Uint8Array(13), hv = new DataView(header.buffer);
  hv.setUint32(0, width); hv.setUint32(4, height);
  header[8] = 8; header[9] = alpha ? 6 : 2;
  const parts = [new Uint8Array(SIGNATURE), chunk('IHDR', header),
                 chunk('IDAT', await through(raw, new CompressionStream('deflate'))), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
