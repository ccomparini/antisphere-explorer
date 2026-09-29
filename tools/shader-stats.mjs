// Compiler statistics for each compute entry point, from Mesa's Intel driver.
//
//   node tools/shader-stats.mjs [shader.wgsl] [entryPoint ...]
//
// Defaults to public/antisphere-raycast.wgsl and every @compute entry point
// in it. For each one this prints what the driver's compiler made of it:
//
//   simd     lanes per hardware thread; wider leaves fewer registers per lane
//   instr    instructions in the compiled shader
//   spills   instructions storing a register out to scratch memory, because
//            more values were live at once than there were registers
//   fills    instructions loading one of those back
//   scratch  bytes per invocation of arrays placed in scratch memory rather
//            than registers (runtime-indexed and too big, like trace()'s stack)
//   cycles   the compiler's own static estimate; for before/after, not timing
//
// Spills, fills and instructions are static counts - instructions in the
// code, not how often they run - so one inside trace()'s loop costs far more
// than one outside it. Compare before and after on the same machine and
// Mesa version; other drivers compile differently, and this is not a
// measure of what any other GPU does.
//
// How: Mesa's Intel compiler dumps every compute shader it builds when
// INTEL_DEBUG=cs is set, and skips building (and so dumping) anything its
// disk cache already holds, hence MESA_SHADER_CACHE_DISABLE. Each entry point
// is compiled in a child process of its own, since Dawn names every shader
// "dawn_entry_point" and the dump can't otherwise say which is which.

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PUBLIC = new URL('../public/', import.meta.url);
const self = fileURLToPath(import.meta.url);

// -- child: compile one entry point and exit ------------------------------------

if (process.argv[2] === '--compile') {
  const [, , , shaderPath, entryPoint] = process.argv;
  const webgpu = await import('webgpu');
  Object.assign(globalThis, webgpu.globals);
  // Held in a global: an unreferenced GPU object can be garbage collected
  // while the device still needs it, which takes Dawn down mid-run.
  globalThis.gpuInstance = webgpu.create([]);
  const adapter = await globalThis.gpuInstance.requestAdapter();
  if (!adapter) { console.log('NO_ADAPTER'); process.exit(1); }
  console.log(`ADAPTER ${adapter.info.vendor}|${adapter.info.description}`);
  const device = await adapter.requestDevice();
  const code = await readFile(shaderPath, 'utf8');
  device.pushErrorScope('validation');
  device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code }), entryPoint },
  });
  const err = await device.popErrorScope();
  if (err) { console.log(`PIPELINE_ERROR ${err.message}`); process.exit(1); }
  await device.queue.onSubmittedWorkDone();
  process.exit(0);
}

// -- parent: run a child per entry point and read its dump ------------------------

try {
  await import('webgpu');
} catch {
  console.error('This needs the webgpu package (Dawn for Node): run `npm install` in the repo root.');
  process.exit(1);
}

const args = process.argv.slice(2);
const shaderArg = args.find((a) => a.endsWith('.wgsl'));
const shaderPath = shaderArg ?? fileURLToPath(new URL('antisphere-raycast.wgsl', PUBLIC));
const source = await readFile(shaderPath, 'utf8');

const allEntries = [...source.matchAll(/@compute\b[^;{]*?\bfn\s+(\w+)/g)].map((m) => m[1]);
const wanted = args.filter((a) => !a.endsWith('.wgsl'));
const entries = wanted.length ? wanted : allEntries;
for (const e of wanted) {
  if (!allEntries.includes(e)) {
    console.error(`${e}: not a @compute entry point in ${shaderPath}`);
    process.exit(1);
  }
}

function compile(entryPoint) {
  const run = spawnSync(process.execPath, [self, '--compile', shaderPath, entryPoint], {
    env: { ...process.env, INTEL_DEBUG: 'cs', MESA_SHADER_CACHE_DISABLE: 'true' },
    encoding: 'utf8',
    maxBuffer: 1 << 30,
  });
  const out = run.stdout ?? '', dump = run.stderr ?? '';
  const adapter = out.match(/^ADAPTER (.*)$/m)?.[1];
  const failure = out.match(/^(NO_ADAPTER|PIPELINE_ERROR.*)$/m)?.[1];
  if (run.status !== 0 || failure) {
    return { entryPoint, adapter, error: failure ?? `child exited ${run.status}: ${dump.slice(-300)}` };
  }

  // One summary line per compiled shader. Mesa may keep more than one SIMD
  // width; each gets a line, and all are reported.
  const variants = [...dump.matchAll(
    /SIMD(\d+) shader: (\d+) instructions\. (\d+) loops\. (\d+) cycles\. (\d+):(\d+) spills:fills/g,
  )].map((m) => ({
    simd: +m[1], instructions: +m[2], loops: +m[3], cycles: +m[4], spills: +m[5], fills: +m[6],
  }));
  // The final-form NIR header gives the scratch size; earlier stages can
  // differ, so read the one after "NIR (final form)".
  const finalAt = dump.lastIndexOf('NIR (final form)');
  const scratch = finalAt < 0 ? null
    : +(dump.slice(finalAt).match(/^scratch: (\d+)$/m)?.[1] ?? 0);
  return { entryPoint, adapter, variants, scratch };
}

const results = entries.map(compile);

const adapter = results.find((r) => r.adapter)?.adapter ?? 'unknown adapter';
console.log(`${adapter.replace('|', ': ')}`);
console.log(`${shaderPath.replace(process.cwd() + '/', '')}\n`);

const rows = [['entry point', 'simd', 'instr', 'spills', 'fills', 'scratch', 'loops', 'cycles']];
let missing = false;
for (const r of results) {
  if (r.error) { rows.push([r.entryPoint, `error: ${r.error}`]); continue; }
  if (!r.variants.length) { missing = true; rows.push([r.entryPoint, '(no statistics)']); continue; }
  for (const v of r.variants) {
    rows.push([r.entryPoint, `${v.simd}`, `${v.instructions}`, `${v.spills}`, `${v.fills}`,
               `${r.scratch ?? '?'}`, `${v.loops}`, `${v.cycles}`]);
  }
}
const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => (row[i] ?? '').length)));
for (const row of rows) {
  console.log(row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : (cell ?? '').padStart(widths[i])))
    .join('  ').trimEnd());
}

if (missing) {
  console.log('\nNo statistics: these come from Mesa\'s Intel driver (INTEL_DEBUG=cs), so other ' +
              'GPUs and drivers print nothing here.');
}
process.exit(results.some((r) => r.error) ? 1 : 0);
