// Side-by-side render benchmark: scenes x revisions, one table.
//
//   node tools/bench-compare.mjs [options] scene ...
//
//   -r, --rev <rev>    a git revision to measure (repeatable); "." is the
//                      working tree. Default: "." alone. The first is the
//                      baseline the others are compared with.
//   -n, --runs <n>     runs of each measurement, in a process of its own
//                      each, reported as their median (default 3)
//   -s, --size <WxH>   render size (default 1920x1080)
//   -t, --time-limit <seconds>
//                      the longest one run may take (default 60): one that
//                      takes longer is stopped, and its scene and revision
//                      reported as taking more, with no further runs
//
// A scene is a file - every revision renders that same file - or a name
// under public/scenes, read from each revision's own tree (so a scene a
// revision changes is compared as each has it). Imports resolve in each
// revision's tree.
//
// Each revision other than the working tree is checked out, detached, in a
// temporary git worktree (removed afterwards), and every measurement is
// made by this file's own code against that tree's public/ - its compiler,
// shaders and renderer - so revisions are measured alike. Per scene and
// revision it reports:
//
//   - nodes and lights, as compiled
//   - the GPU compute pass (median of many frames, by timestamps), and the
//     ablation ladder's steps: traversal, shading, shadow rays - what each
//     adds, as bench-render.mjs reports them
//   - wall-clock frame time, pipelined
//   - work per pixel, from the shader's own counters (DEBUG_COUNTS): node
//     visits (primary and shadow rays together), shadow rays traced, and
//     peak stack depth, mean and most. These don't vary from run to run or
//     machine to machine, as times do. A revision whose shader has no
//     DEBUG_COUNTS shows "-".
//
// Change one thing at a time: the same scene on two revisions measures the
// code; the same revision on two scenes measures the scene.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO = resolve(SELF, '../..');

if (process.argv[2] === '--probe') {
  await probe(JSON.parse(process.argv[3]));
} else {
  await compare(process.argv.slice(2));
}

// -- one measurement, in a process of its own ---------------------------------

async function probe({ tree, scene, size: [width, height] }) {
  const { readFile } = await import('node:fs/promises');
  const webgpu = await import(pathToFileURL(join(REPO, 'node_modules/webgpu/index.js')).href);
  const PUBLIC = pathToFileURL(join(tree, 'public/'));
  Object.assign(globalThis, webgpu.globals);
  globalThis.navigator ??= {};
  Object.defineProperty(globalThis.navigator, 'gpu', { value: webgpu.create([]), configurable: true });
  globalThis.window ??= { devicePixelRatio: 1 };

  const { ASContext } = await import(new URL('as-context.js', PUBLIC));
  const renderer = await import(new URL('as-renderer.js', PUBLIC));
  const { ASCamera } = await import(new URL('as-camera.js', PUBLIC));
  const { loadImports } = await import(new URL('antisphere-scene.js', PUBLIC));
  const load = (name) => readFile(new URL(name, PUBLIC), 'utf8');
  const gpu = await ASContext.create({ load });
  const { device } = gpu;

  const readJson = async (path) => JSON.parse(await load(path));
  const from = `scenes/${basename(scene.file)}`;
  const spec = JSON.parse(readFileSync(scene.file, 'utf8'));
  const built = gpu.createScene(spec, {
    imports: await loadImports(spec, readJson, { from, readBytes: (p) => readFile(new URL(p, PUBLIC)) }),
    path: from,
  });

  // A canvas as far as ASRenderer can tell (see bench-render.mjs).
  let config = null, swap = null;
  const canvas = {
    clientWidth: width, clientHeight: height, width, height,
    getContext: () => ({
      configure(c) { config = c; swap?.destroy(); swap = null; },
      unconfigure() { swap?.destroy(); swap = null; },
      getCurrentTexture() {
        swap ??= device.createTexture({ size: [width, height], format: config.format, usage: config.usage });
        return swap;
      },
    }),
  };
  const view = gpu.createRenderer(canvas, { scene: built, camera: new ASCamera() });
  view.useSceneCamera();

  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
  const out = { nodes: built.nodes.length - 1, lights: built.lights.length };

  if (gpu.canTimestamp) {
    const querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
    const resolved = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const frame = async (camera) => {
      const enc = device.createCommandEncoder();
      view.encode(enc, { camera, computeTimestamps: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } });
      enc.resolveQuerySet(querySet, 0, 2, resolved, 0);
      enc.copyBufferToBuffer(resolved, 0, read, 0, 16);
      device.queue.submit([enc.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const t = new BigInt64Array(read.getMappedRange().slice(0));
      read.unmap();
      return Number(t[1] - t[0]) / 1e6;
    };
    // Within a time budget, so a slow scene - a second a frame - takes
    // seconds, not the minutes a fixed count of frames would: up to `most`
    // frames, or as many as fit in `seconds`, but at least 5, after a
    // warm-up of up to 8 frames or a second.
    const compute = async (camera, most = 40, seconds = 3) => {
      let start = performance.now();
      for (let i = 0; i < 8 && performance.now() - start < 1000; i++) await frame(camera);
      start = performance.now();
      const times = [];
      while (times.length < most && (times.length < 5 || performance.now() - start < seconds * 1000)) {
        const t = await frame(camera);
        if (t >= 0 && t < 1e4) times.push(t);
      }
      return median(times);
    };
    out.compute = await compute(undefined, 60, 5);
    // The ablation ladder (bench-render.mjs): each rung adds a stage.
    const rung = (ablate, shadows) => compute({ shadows, ablate, debugView: 0 });
    const [dispatch, traversal, shading, shadowed] = [await rung(0, 0), await rung(1, 0), await rung(2, 0), await rung(2, 1)];
    out.traversal = traversal - dispatch;
    out.shading = shading - traversal;
    out.shadows = shadowed - shading;
  }

  const once = () => {
    const enc = device.createCommandEncoder();
    view.encode(enc);
    device.queue.submit([enc.finish()]);
  };
  // Pipelined: as many frames in flight as make about 3 seconds, 5 to 60.
  let start = performance.now();
  for (let i = 0; i < 3; i++) { once(); await device.queue.onSubmittedWorkDone(); }
  const frames = Math.max(5, Math.min(60, Math.round(3000 / ((performance.now() - start) / 3))));
  start = performance.now();
  for (let i = 0; i < frames; i++) once();
  await device.queue.onSubmittedWorkDone();
  out.pipelined = (performance.now() - start) / frames;

  // Work per pixel, from the counts view, where this revision has one.
  if (renderer.DEBUG_COUNTS !== undefined && view.tex) {
    const enc = device.createCommandEncoder();
    view.encode(enc, { camera: { debugView: renderer.DEBUG_COUNTS } });
    const w = view.tex.width, h = view.tex.height;
    const stride = Math.ceil((w * 4) / 256) * 256;
    const buf = device.createBuffer({ size: stride * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyTextureToBuffer({ texture: view.tex }, { buffer: buf, bytesPerRow: stride }, [w, h]);
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const px = new Uint8Array(buf.getMappedRange());
    let visits = 0, shadowRays = 0, depth = 0, deepest = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * stride + x * 4;
        visits += px[i] + 256 * px[i + 1];
        shadowRays += px[i + 2];
        depth += px[i + 3];
        deepest = Math.max(deepest, px[i + 3]);
      }
    }
    const n = w * h;
    Object.assign(out, { visits: visits / n, shadowRays: shadowRays / n, depth: depth / n, deepest });
  }

  console.log(JSON.stringify(out));
  device.destroy();
  process.exit(0);
}

// -- the comparison -----------------------------------------------------------

async function compare(argv) {
  const revs = [], scenes = [];
  let runs = 3, size = [1920, 1080], limit = 60;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-r' || arg === '--rev') revs.push(argv[++i]);
    else if (arg === '-n' || arg === '--runs') runs = Number(argv[++i]);
    else if (arg === '-s' || arg === '--size') size = argv[++i].split('x').map(Number);
    else if (arg === '-t' || arg === '--time-limit') limit = Number(argv[++i]);
    else if (arg === '-h' || arg === '--help') {
      console.log(readFileSync(SELF, 'utf8').split('\n\n')[0].replace(/^\/\/ ?/gm, ''));
      return;
    } else scenes.push(arg);
  }
  if (!revs.length) revs.push('.');
  if (!scenes.length) throw new Error('name a scene or two to measure (see --help)');
  if (!(runs >= 1) || !(limit > 0) || size.length !== 2 || !size.every((v) => v > 0)) {
    throw new Error('bad --runs, --size or --time-limit');
  }

  const git = (...args) => {
    const run = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.trim()}`);
    return run.stdout.trim();
  };
  const scratch = mkdtempSync(join(tmpdir(), 'bench-compare-'));
  const trees = new Map();
  const results = [];
  try {
    for (const rev of revs) {
      if (rev === '.') { trees.set(rev, { dir: REPO, label: 'working tree' }); continue; }
      const commit = git('rev-parse', '--short', `${rev}^{commit}`);
      const dir = join(scratch, commit);
      if (!existsSync(dir)) git('worktree', 'add', '--detach', dir, commit);
      trees.set(rev, { dir, label: `${rev} (${commit})` });
    }
    for (const scene of scenes) {
      for (const rev of revs) {
        const { dir, label } = trees.get(rev);
        const file = existsSync(scene) ? resolve(scene) : join(dir, 'public/scenes', scene);
        if (!existsSync(file)) throw new Error(`${label} has no scene ${scene}`);
        const measured = [];
        let timedOut = false;
        for (let k = 0; k < runs && !timedOut; k++) {
          process.stderr.write(`\r${scene} on ${label}: run ${k + 1} of ${runs}   `);
          const run = spawnSync(process.execPath, [SELF, '--probe', JSON.stringify({ tree: dir, scene: { file }, size })],
                                { encoding: 'utf8', maxBuffer: 1 << 24, timeout: limit * 1000, killSignal: 'SIGKILL' });
          if (run.error?.code === 'ETIMEDOUT') { timedOut = true; break; }
          const line = run.stdout.trim().split('\n').pop();
          if (run.status !== 0 || !line?.startsWith('{')) {
            throw new Error(`measuring ${scene} on ${label} failed:\n${run.stderr.split('\n').filter((l) => !/^Warning/.test(l)).join('\n')}`);
          }
          measured.push(JSON.parse(line));
        }
        if (timedOut) { results.push({ scene: basename(scene), label, timedOut: true }); continue; }
        const keys = Object.keys(measured[0]);
        const median = (key) => {
          const s = measured.map((m) => m[key]).sort((a, b) => a - b);
          return s[s.length >> 1];
        };
        results.push({ scene: basename(scene), label, ...Object.fromEntries(keys.map((key) => [key, median(key)])) });
      }
    }
  } finally {
    process.stderr.write('\r\x1b[K');
    for (const { dir } of trees.values()) {
      if (dir !== REPO) spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: REPO });
    }
    rmSync(scratch, { recursive: true, force: true });
  }
  report(results, revs.length, size, runs, limit);
}

function report(results, revCount, [width, height], runs, limit) {
  const fixed = (digits) => (v) => (v === undefined ? '-' : v.toFixed(digits));
  const COLUMNS = [
    { head: 'nodes', get: (r) => String(r.nodes) },
    { head: 'lights', get: (r) => String(r.lights) },
    { head: 'compute ms', get: (r) => fixed(2)(r.compute), delta: 'compute' },
    { head: 'traversal', get: (r) => fixed(2)(r.traversal) },
    { head: 'shading', get: (r) => fixed(2)(r.shading) },
    { head: 'shadows', get: (r) => fixed(2)(r.shadows) },
    { head: 'frame ms', get: (r) => fixed(2)(r.pipelined), delta: 'pipelined' },
    { head: 'visits/px', get: (r) => fixed(1)(r.visits), delta: 'visits' },
    { head: 'shadow rays/px', get: (r) => fixed(2)(r.shadowRays) },
    { head: 'depth mean/max', get: (r) => (r.depth === undefined ? '-' : `${r.depth.toFixed(1)}/${r.deepest}`) },
  ];
  console.log(`${width}x${height}, median of ${runs} run${runs === 1 ? '' : 's'}; ` +
              'traversal, shading, shadows: what each stage adds (ms); frame: pipelined; ' +
              'visits: nodes, primary and shadow rays');
  const rows = [['scene', 'revision', ...COLUMNS.map((c) => c.head)]];
  let base = null;
  results.forEach((r, i) => {
    if (i % revCount === 0) base = r;
    if (r.timedOut) {
      const over = limit % 60 === 0 ? `> ${limit / 60} min` : `> ${limit} s`;
      rows.push([i % revCount === 0 ? r.scene : '', r.label, over, ...COLUMNS.slice(1).map(() => '')]);
      return;
    }
    rows.push([i % revCount === 0 ? r.scene : '', r.label, ...COLUMNS.map((c) => {
      const text = c.get(r);
      if (!c.delta || r === base || base.timedOut || r[c.delta] === undefined || !base[c.delta]) return text;
      const change = (100 * (r[c.delta] - base[c.delta])) / base[c.delta];
      return `${text} (${change >= 0 ? '+' : ''}${change.toFixed(1)}%)`;
    })]);
  });
  const widths = rows[0].map((_, j) => Math.max(...rows.map((row) => row[j].length)));
  for (const row of rows) console.log(row.map((cell, j) => (j < 2 ? cell.padEnd(widths[j]) : cell.padStart(widths[j]))).join('  '));
}
