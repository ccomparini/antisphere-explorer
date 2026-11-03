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
// A scene is a URL, a file, or failing that a name under public/scenes
// (scene-url.mjs), read as the page reads one (readScene()): what it
// references is found relative to it, a .gz is unzipped, and an STL on its
// own is shown in a scene made round it. The view is the scene's camera,
// unless --eye or --target moves it (the other kept as the scene has it).

import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOptions } from './args.mjs';
import { sceneURL } from './scene-url.mjs';
import { encodePNG } from '../public/png.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

const USAGE = `
render - a scene to a PNG, headless

  node tools/render.mjs <scene> [options]

  <scene>               a scene (.json) or an STL, maybe .gz: a URL, a
                        file, or a name under public/scenes
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
  const { readScene } = await import(path.join(PUBLIC, 'antisphere-scene.js'));
  const view_ = DEBUG_VIEWS.indexOf(options.view);
  if (view_ < 0) throw new Error(`--view ${options.view}: one of ${DEBUG_VIEWS.map((v) => `"${v}"`).join(', ')}`);

  if (!(await navigator.gpu.requestAdapter())) throw new Error('no usable GPU: no adapter');
  const gpu = await ASContext.create({ load: (name) => readFile(path.join(PUBLIC, name), 'utf8') });
  const { device } = gpu;
  try {
    const { spec, files, path: from } = await readScene(sceneURL(options.scene));
    const scene = gpu.createScene(spec, { files, path: from });

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
  const out = options.out ?? `${path.basename(options.scene.split(/[?#]/)[0]).replace(/\.(json|stl)(\.gz)?$/i, '')}.png`;
  const started = performance.now();
  const { rgba, nodes, lights } = await render(options);
  await writeFile(out, await encodePNG(rgba, options.width, options.height));
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
