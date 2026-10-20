#!/usr/bin/env node
// Render a scene to a PNG, headless: the page's renderer (ASContext and
// ASRenderer) through Dawn, as tools/bench-render.mjs drives it, with a
// stand-in canvas whose "screen" is an ordinary texture, read back.
//
//   node tools/render.mjs glass-hall.json                      glass-hall.png, here
//   node tools/render.mjs public/scenes/maze.json -o maze.png --size 1920x1080
//   node tools/render.mjs tangents.json --eye 0,-9,3 --target 0,0,1
//   node tools/render.mjs scene.json --view normals --no-shadows
//
// A scene is a file, or failing that a name under public/scenes; what it
// references is found relative to it. The view is the scene's camera,
// unless --eye or --target moves it (the other kept as the scene has it).

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { parseOptions } from './args.mjs';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

const USAGE = `
render - a scene to a PNG, headless

  node tools/render.mjs <scene.json> [options]

  <scene.json>          a file, or a name under public/scenes
  -o, --out <file>      the PNG (default: the scene's name, .png, here)
      --size <WxH>      in pixels (default 1280x720)
      --eye <x,y,z>     where the camera is (default: the scene's camera)
      --target <x,y,z>  what it looks at (default: the scene's camera's)
      --no-shadows      without shadow rays
      --view <name>     a debug view: shaded (default), "node visits",
                        "shadow rays", "stack depth", "material id", normals
`.trim();

function parseArguments(argv) {
  const { values, positionals } = parseOptions(argv, {
    out: { type: 'string', short: 'o' },
    size: { type: 'string', default: '1280x720' },
    eye: { type: 'string' },
    target: { type: 'string' },
    'no-shadows': { type: 'boolean' },
    view: { type: 'string', default: 'shaded' },
    help: { type: 'boolean', short: 'h' },
  }, { positionals: true });
  if (positionals.length > 1) throw new Error(`one scene at a time, not ${positionals.length}`);
  const size = /^(\d+)x(\d+)$/.exec(values.size);
  if (!size || !(+size[1] > 0 && +size[2] > 0)) throw new Error(`--size ${values.size}: width x height, as 1280x720`);
  const point = (name) => {
    if (values[name] === undefined) return undefined;
    const p = values[name].split(',').map(Number);
    if (p.length !== 3 || !p.every(Number.isFinite)) throw new Error(`--${name} ${values[name]}: x,y,z`);
    return p;
  };
  return {
    scene: positionals[0], out: values.out, width: +size[1], height: +size[2],
    eye: point('eye'), target: point('target'), shadows: !values['no-shadows'], view: values.view, help: values.help,
  };
}

// -- PNG ------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An 8-bit RGB PNG from rows of RGBA pixels (alpha dropped). */
export function encodePNG(rgba, width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = rgba[i]; raw[o + 1] = rgba[i + 1]; raw[o + 2] = rgba[i + 2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;                         // 8 bits, RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
                        chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// -- rendering ------------------------------------------------------------------

async function render(options) {
  let webgpu;
  try { webgpu = await import('webgpu'); }
  catch { throw new Error('this needs the webgpu package (Dawn for Node): run `npm install` in the repo root'); }
  Object.assign(globalThis, webgpu.globals);
  globalThis.navigator ??= {};
  // Kept referenced on navigator: if Dawn's instance is collected mid-run, it crashes.
  Object.defineProperty(globalThis.navigator, 'gpu', { value: webgpu.create([]), configurable: true });
  globalThis.window ??= { devicePixelRatio: 1 };

  const { ASContext } = await import(path.join(PUBLIC, 'as-context.js'));
  const { DEBUG_VIEWS } = await import(path.join(PUBLIC, 'as-renderer.js'));   // registers ASRenderer
  const { ASCamera } = await import(path.join(PUBLIC, 'as-camera.js'));
  const { loadReferences } = await import(path.join(PUBLIC, 'antisphere-scene.js'));
  const view_ = DEBUG_VIEWS.indexOf(options.view);
  if (view_ < 0) throw new Error(`--view ${options.view}: one of ${DEBUG_VIEWS.map((v) => `"${v}"`).join(', ')}`);

  if (!(await navigator.gpu.requestAdapter())) throw new Error('no usable GPU: no adapter');
  const gpu = await ASContext.create({ load: (name) => readFile(path.join(PUBLIC, name), 'utf8') });
  const { device } = gpu;
  try {
    const file = existsSync(options.scene) ? path.resolve(options.scene) : path.join(PUBLIC, 'scenes', options.scene);
    if (!existsSync(file)) throw new Error(`no scene ${options.scene}, as a file or in public/scenes`);
    const spec = JSON.parse(await readFile(file, 'utf8'));
    const files = await loadReferences(spec, {
      from: file, readText: (p) => readFile(p, 'utf8'), readBytes: (p) => readFile(p),
    });
    const scene = gpu.createScene(spec, { files, path: file });

    const { width, height } = options;
    let format = null, texture = null;
    const ctx = {
      configure(c) { format = c.format; texture = device.createTexture({ size: [width, height], format, usage: c.usage | GPUTextureUsage.COPY_SRC }); },
      unconfigure() {},
      getCurrentTexture() { return texture; },
    };
    const canvas = { clientWidth: width, clientHeight: height, width, height, getContext: () => ctx };
    const camera = new ASCamera();
    const view = gpu.createRenderer(canvas, { scene, camera, shadows: options.shadows });
    view.useSceneCamera();
    if (options.eye || options.target) {
      const eye = options.eye ?? camera.basis().eye, target = options.target ?? camera.focus();
      const d = target.map((t, i) => t - eye[i]), distance = Math.hypot(...d);
      if (!(distance > 0)) throw new Error('--eye and --target are the same point');
      camera.aim({ focus: target, direction: d, distance });
    }
    view.setDebugView(view_);

    // Rows read back must be whole multiples of 256 bytes.
    const row = Math.ceil(width * 4 / 256) * 256;
    const buffer = device.createBuffer({ size: row * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    if (!view.encode(enc)) throw new Error('the renderer drew nothing');
    enc.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [width, height]);
    device.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(buffer.getMappedRange());
    const rgba = new Uint8Array(width * height * 4);
    const bgra = format.startsWith('bgra');
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * row + x * 4, o = (y * width + x) * 4;
        rgba[o] = padded[i + (bgra ? 2 : 0)]; rgba[o + 1] = padded[i + 1]; rgba[o + 2] = padded[i + (bgra ? 0 : 2)]; rgba[o + 3] = 255;
      }
    }
    buffer.unmap();
    return { rgba, nodes: scene.nodes.length - 1, lights: scene.lights.length };
  } finally {
    device.destroy();
  }
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help || !options.scene) {
    console.log(USAGE);
    process.exit(options.help ? 0 : 1);
  }
  const out = options.out ?? `${path.basename(options.scene).replace(/\.json(\.gz)?$/i, '')}.png`;
  const started = performance.now();
  const { rgba, nodes, lights } = await render(options);
  await writeFile(out, encodePNG(rgba, options.width, options.height));
  console.error(`${options.scene}: ${nodes} nodes, ${lights} lights, ${options.width}x${options.height}` +
                `${options.view !== 'shaded' ? `, ${options.view}` : ''}${options.shadows ? '' : ', no shadows'}` +
                ` -> ${out} (${((performance.now() - started) / 1000).toFixed(1)}s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(() => process.exit(0), (error) => {
    console.error(`render: ${error.message}`);
    process.exit(1);
  });
}
