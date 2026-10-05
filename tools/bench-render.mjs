// Headless render benchmark: times antisphere-raycast.html's default view.
//
//   node tools/bench-render.mjs [scene.json] [WxH ...]
//
// Drives the real ASContext/ASRenderer - same camera packing, same compute
// dispatch, same blit - through Dawn (the `webgpu` package), with a stand-in
// canvas whose "swap chain" is an ordinary texture. Reports, per size:
//
//   - compute and blit pass times from GPU timestamps, placed exactly as the
//     page's profiler places them (median of many frames)
//   - the page's ablation ladder: dispatch / traversal / shading / shadows
//   - wall-clock frame time, back-to-back submits waited on one at a time,
//     and pipelined throughput with many frames in flight
//
// There is no display and no compositor here, so these are the GPU's numbers
// for the work itself; a browser adds its own presentation cost on top.

import { readFile } from 'node:fs/promises';
import * as webgpu from 'webgpu';

const PUBLIC = new URL('../public/', import.meta.url);

Object.assign(globalThis, webgpu.globals);
globalThis.navigator ??= {};
Object.defineProperty(globalThis.navigator, 'gpu', { value: webgpu.create([]), configurable: true });
globalThis.window ??= { devicePixelRatio: 1 };

const { ASContext } = await import(new URL('as-context.js', PUBLIC));
await import(new URL('as-renderer.js', PUBLIC));      // registers ASRenderer
const { ASCamera } = await import(new URL('as-camera.js', PUBLIC));
const { loadImports } = await import(new URL('antisphere-scene.js', PUBLIC));

const args = process.argv.slice(2);
const sceneFile = args.find((a) => a.endsWith('.json')) ?? 'scene.json';
const sizes = args.filter((a) => /^\d+x\d+$/.test(a)).map((s) => s.split('x').map(Number));
if (!sizes.length) sizes.push([1920, 1080], [1280, 720], [3840, 2160]);

const load = (name) => readFile(new URL(name, PUBLIC), 'utf8');
const gpu = await ASContext.create({ load });
// As ASContext.loadScene does it, imports and all, but from disk.
const scenePath = `scenes/${sceneFile}`;
const readJson = async (path) => JSON.parse(await load(path));
const readBytes = (path) => readFile(new URL(path, PUBLIC));
const spec = await readJson(scenePath);
const scene = gpu.createScene(spec, {
  imports: await loadImports(spec, readJson, {
    from: scenePath,
    readBytes,
  }),
  path: scenePath,
});
const { device } = gpu;

/** A canvas as far as ASRenderer can tell: its current texture is just a texture. */
function fakeCanvas(width, height) {
  let config = null, tex = null;
  const ctx = {
    configure(c) { config = c; tex?.destroy(); tex = null; },
    unconfigure() { tex?.destroy(); tex = null; },
    getCurrentTexture() {
      if (!tex || tex.width !== canvas.width || tex.height !== canvas.height) {
        tex?.destroy();
        tex = device.createTexture({
          size: [canvas.width, canvas.height], format: config.format, usage: config.usage,
        });
      }
      return tex;
    },
  };
  const canvas = { clientWidth: width, clientHeight: height, width, height,
                   getContext: () => ctx };
  return canvas;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };

const ts = gpu.canTimestamp ? {
  querySet: device.createQuerySet({ type: 'timestamp', count: 4 }),
  resolve: device.createBuffer({ size: 32, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
  read: device.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
} : null;

/** One frame with pass timestamps: { compute, blit } in ms. */
async function timedFrame(view, camera) {
  const enc = device.createCommandEncoder();
  view.encode(enc, {
    camera,
    computeTimestamps: { querySet: ts.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
    blitTimestamps: { querySet: ts.querySet, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 },
  });
  enc.resolveQuerySet(ts.querySet, 0, 4, ts.resolve, 0);
  enc.copyBufferToBuffer(ts.resolve, 0, ts.read, 0, 32);
  device.queue.submit([enc.finish()]);
  await ts.read.mapAsync(GPUMapMode.READ);
  const t = new BigInt64Array(ts.read.getMappedRange().slice(0));
  ts.read.unmap();
  return { compute: Number(t[1] - t[0]) / 1e6, blit: Number(t[3] - t[2]) / 1e6 };
}

async function passTimes(view, camera, warmup = 10, samples = 60) {
  for (let i = 0; i < warmup; i++) await timedFrame(view, camera);
  const c = [], b = [];
  for (let i = 0; i < samples; i++) {
    const { compute, blit } = await timedFrame(view, camera);
    if (compute >= 0 && compute < 1e3) { c.push(compute); b.push(blit); }
  }
  return { compute: median(c), blit: median(b) };
}

async function wallClock(view, frames = 60) {
  const one = async () => {
    const enc = device.createCommandEncoder();
    view.encode(enc);
    device.queue.submit([enc.finish()]);
  };
  for (let i = 0; i < 10; i++) { await one(); await device.queue.onSubmittedWorkDone(); }
  let start = performance.now();
  for (let i = 0; i < frames; i++) { await one(); await device.queue.onSubmittedWorkDone(); }
  const serial = (performance.now() - start) / frames;
  start = performance.now();
  for (let i = 0; i < frames; i++) await one();
  await device.queue.onSubmittedWorkDone();
  const pipelined = (performance.now() - start) / frames;
  return { serial, pipelined };
}

// The page's ablation ladder, in its order.
const LADDER = [
  { name: 'dispatch',    ablate: 0, shadows: 0 },
  { name: 'traversal',   ablate: 1, shadows: 0 },
  { name: 'shading',     ablate: 2, shadows: 0 },
  { name: 'shadow rays', ablate: 2, shadows: 1 },
];

const info = gpu.adapter.info;
console.log(`adapter: ${info.vendor} ${info.architecture} (${info.description})`);
console.log(`scene: ${sceneFile}, ${scene.nodes.length - 1} nodes, ` +
            `${scene.lights.length} lights; scene camera, shadows on, blit path, render scale 1`);
if (!ts) console.log('(no timestamp-query on this adapter: wall clock only)');

for (const [w, h] of sizes) {
  const camera = new ASCamera();
  const view = gpu.createRenderer(fakeCanvas(w, h), { scene, camera });
  view.useSceneCamera();

  console.log(`\n${w}x${h} (${(w * h / 1e6).toFixed(2)} Mpx)`);
  if (ts) {
    const full = await passTimes(view);
    console.log(`  GPU compute pass  ${full.compute.toFixed(2)} ms   ` +
                `(${(w * h / full.compute / 1e3).toFixed(0)} Mrays/s primary)`);
    console.log(`  GPU blit pass     ${full.blit.toFixed(2)} ms`);
    const rungs = [];
    for (const r of LADDER) {
      rungs.push((await passTimes(view, { shadows: r.shadows, ablate: r.ablate, debugView: 0 },
                                  8, 30)).compute);
    }
    console.log('  ladder (compute)  ' + LADDER.map((r, i) =>
      `${r.name} ${rungs[i].toFixed(2)}` + (i ? ` (+${(rungs[i] - rungs[i - 1]).toFixed(2)})` : ''))
      .join(' | '));
  }
  const wall = await wallClock(view);
  console.log(`  wall clock        ${wall.serial.toFixed(2)} ms/frame waited, ` +
              `${wall.pipelined.toFixed(2)} ms/frame pipelined ` +
              `(${(1000 / wall.pipelined).toFixed(0)} fps)`);
  view.destroy();
}

device.destroy();
process.exit(0);
