#!/usr/bin/env node
// How long a scene takes to load, stage by stage, as the page loads one:
//
//   node tools/bench-load.mjs [-n runs] scene ...
//
//   read      readScene(): the file and everything it references, as read
//             (images decoded: "images" says how many, and how big, and
//             how many of them the compiled scene uses)
//   compile   compileScene(): the spec into nodes, materials, lights, ...
//   pack      packNodes(), packSurfaces(), packLights(), packMaterials(),
//             packTextures(): the compiled scene as the GPU takes it
//   upload    ASScene.load() less its packing: the buffers made and
//             written, waited for until the GPU has them
//
// Each run is a process of its own, as a page load is, cold; the table
// gives each stage's median. Precompiling a scene is meant to take the
// compile out: this is the before, and the after.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseOptions } from './args.mjs';
import { sceneURL } from './scene-url.mjs';

const self = fileURLToPath(import.meta.url);
const PUBLIC = new URL('../public/', import.meta.url);

// -- one run, in a process of its own ------------------------------------------------

async function measureOne(scene) {
  const webgpu = await import('webgpu');
  Object.assign(globalThis, webgpu.globals);
  globalThis.navigator ??= {};
  Object.defineProperty(globalThis.navigator, 'gpu', { value: webgpu.create([]), configurable: true });
  globalThis.window ??= { devicePixelRatio: 1 };
  const { ASContext } = await import(new URL('as-context.js', PUBLIC));
  const { readScene, compileScene, packNodes, packSurfaces, packLights, packMaterials, packTextures } =
    await import(new URL('antisphere-scene.js', PUBLIC));
  const { readFile } = await import('node:fs/promises');
  const gpu = await ASContext.create({ load: (name) => readFile(new URL(name, PUBLIC), 'utf8') });

  const clock = () => performance.now();
  let t = clock();
  const { spec, files, path } = await readScene(sceneURL(scene));
  const read = clock() - t;

  t = clock();
  const built = compileScene(spec, { files, path, warn: () => {} });
  const compile = clock() - t;

  t = clock();
  packNodes(built.nodes, built.materials);
  packSurfaces(built.nodes);
  packLights(built.lights);
  packMaterials(built.materials);
  packTextures(built.textures ?? []);
  const pack = clock() - t;

  // An ASScene to load into: made from a spec of one ball, so it
  // costs nothing to compile, then given the built scene as a precompiled
  // one would be.
  const sc = gpu.createScene({ lights: [{ pos: [0, 0, 1], color: [1, 1, 1] }], root: { sphere: { center: [0, 0, 0], radius: 1 } } });
  t = clock();
  sc.load(built, spec);
  await gpu.device.queue.onSubmittedWorkDone();
  const loaded = clock() - t;

  // The images read, decoded - whether the scene uses them or not: a
  // material library's textures come with it.
  const images = Object.values(files ?? {}).filter((f) => f?.rgba);
  const texelBytes = images.reduce((sum, f) => sum + f.rgba.byteLength, 0);
  console.log(JSON.stringify({ read, compile, pack, upload: Math.max(0, loaded - pack),
                               nodes: built.nodes.length, gpuBytes: sc.bytes,
                               images: images.length, texelBytes, used: usedTextures(built) }));
  sc.destroy();
}

// The textures some node's material shows: the rest were read, decoded and
// uploaded for nothing.
function usedTextures(built) {
  const used = new Set();
  for (const nd of built.nodes) {
    const texture = built.materials[nd.material]?.texture;
    if (texture) used.add(texture);
  }
  return used.size;
}

// -- the table -----------------------------------------------------------------------

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const ms = (x) => (x >= 10000 ? `${(x / 1000).toFixed(1)} s` : `${x.toFixed(x >= 100 ? 0 : 1)} ms`);
const mb = (b) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`);

const { values, positionals } = parseOptions(process.argv.slice(2), {
  runs: { type: 'string', short: 'n', default: '3' },
  one: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
}, { positionals: true });
if (values.help || (!values.one && !positionals.length)) {
  console.log(readFileSync(self, 'utf8').split('\n\n')[0].replace(/^#!.*\n/, '').replace(/^\/\/ ?/gm, ''));
  process.exit(values.help ? 0 : 1);
}
if (values.one) {
  await measureOne(values.one);
  process.exit(0);
}

const runs = Math.max(1, +values.runs || 3);
const rows = [['scene', 'nodes', 'images (used)', 'GPU', 'read', 'compile', 'pack', 'upload', 'total']];
for (const scene of positionals) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    process.stderr.write(`\r${scene}: run ${i + 1} of ${runs}   `);
    const run = spawnSync(process.execPath, [self, '--one', scene], { encoding: 'utf8', maxBuffer: 1 << 26 });
    const line = (run.stdout ?? '').trim().split('\n').pop();
    if (run.status !== 0 || !line?.startsWith('{')) {
      process.stderr.write(`\n${scene}: failed\n${(run.stderr ?? '').split('\n').filter((l) => !/^Warning/.test(l)).slice(-5).join('\n')}\n`);
      samples.length = 0;
      break;
    }
    samples.push(JSON.parse(line));
  }
  if (!samples.length) { rows.push([scene, 'failed']); continue; }
  const m = (k) => median(samples.map((s) => s[k]));
  const total = median(samples.map((s) => s.read + s.compile + s.pack + s.upload));
  const s0 = samples[0];
  rows.push([scene, String(s0.nodes), `${s0.images}, ${mb(s0.texelBytes)} (${s0.used})`, mb(s0.gpuBytes),
             ms(m('read')), ms(m('compile')), ms(m('pack')), ms(m('upload')), ms(total)]);
}
process.stderr.write('\r\x1b[K');
const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)));
console.log(`median of ${runs} run${runs > 1 ? 's' : ''}, each a process of its own`);
for (const r of rows) console.log(r.map((v, c) => (c ? (v ?? '').padStart(widths[c]) : (v ?? '').padEnd(widths[c]))).join('  '));
