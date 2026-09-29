// Compiler statistics for each compute entry point, from Mesa's Intel driver.
//
//   node tools/shader-stats.mjs [shader.wgsl] [entryPoint ...] [--dump DIR]
//
// Defaults to public/gen/antisphere-raycast.wgsl, built from shaders/ by
// tools/build-shaders.mjs (plain WGSL, which is what this needs), and every
// @compute entry point in it. For each one this prints what the driver's
// compiler made of it:
//
//   simd     lanes per hardware thread; wider leaves fewer registers per lane.
//            Dawn asks for 16 on this GPU, so expect 16 throughout.
//   instr    instructions in the compiled shader
//   spills   register spills: stores of a live value out to scratch memory,
//            because more values were live at once than there were registers
//   fills    loads of a spilled value back into a register
//   arr st   stores to arrays kept in scratch memory (see `scratch`), such as
//            trace()'s stack, including WGSL's zero-fill of a new array
//   arr ld   loads from those arrays
//   scratch  bytes per invocation of those arrays
//   loops    loops in the compiled code
//   cycles   the compiler's own static estimate; for before/after, not timing
//
// Each count reads "total (in loops)": the number inside any loop is what
// runs over and over, and so what matters most. All of them are static
// counts - instructions in the code, not how often they execute.
//
// Mesa's own summary line lumps array traffic in with spills ("444:96
// spills:fills" for main, of which 396:12 is trace()'s stack). They are told
// apart here by message type: this Mesa writes spills and fills as OWORD
// block messages and array accesses as DWORD scattered ones, both to binding
// table slot 253. The split is checked against the compiler's totals; if a
// future Mesa or GPU does it differently, the split is left out, with a note,
// rather than guessed.
//
// --dump DIR keeps each entry point's full compiler output as DIR/<entry>.txt:
// the NIR (the compiler's intermediate form) at each stage, then the final
// assembly under "Native code". Blocks are marked START/END Bn with their
// edges; an END going back to an earlier block closes a loop.
//
// Compare before and after on the same machine and Mesa version; other
// drivers compile differently, and this is not a measure of any other GPU.
//
// How: Mesa's Intel compiler dumps every compute shader it builds when
// INTEL_DEBUG=cs is set, and skips building (and so dumping) anything its
// disk cache already holds, hence MESA_SHADER_CACHE_DISABLE. Each entry point
// is compiled in a child process of its own, since Dawn names every shader
// "dawn_entry_point" and the dump can't otherwise say which is which.

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

// -- parent: arguments ----------------------------------------------------------------

try {
  await import('webgpu');
} catch {
  console.error('This needs the webgpu package (Dawn for Node): run `npm install` in the repo root.');
  process.exit(1);
}

const args = process.argv.slice(2);
let dumpDir = null;
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dump') {
    dumpDir = args[++i];
    if (!dumpDir) { console.error('--dump needs a directory'); process.exit(1); }
  } else {
    rest.push(args[i]);
  }
}
const shaderArg = rest.find((a) => a.endsWith('.wgsl'));
const shaderPath = shaderArg ?? fileURLToPath(new URL('gen/antisphere-raycast.wgsl', PUBLIC));
const source = await readFile(shaderPath, 'utf8');

const allEntries = [...source.matchAll(/@compute\b[^;{]*?\bfn\s+(\w+)/g)].map((m) => m[1]);
const wanted = rest.filter((a) => !a.endsWith('.wgsl'));
const entries = wanted.length ? wanted : allEntries;
for (const e of wanted) {
  if (!allEntries.includes(e)) {
    console.error(`${e}: not a @compute entry point in ${shaderPath}`);
    process.exit(1);
  }
}

// -- reading the assembly -------------------------------------------------------------

/**
 * Scratch messages in the final assembly, by kind and by whether they sit in
 * a loop. Blocks come in layout order, and the compiler lays a loop out as a
 * contiguous run from its header to the block that jumps back to it, so a
 * back edge END Bx -> By (By no later than Bx) marks every block between
 * them as in that loop.
 */
function scratchTraffic(assembly) {
  const lines = assembly.split('\n');
  const order = new Map();                   // block name -> layout position
  const backEdges = [];                      // [header position, latch position]
  const messages = [];                       // { kind, block position }
  let block = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = line.match(/^\s*START (B\d+)/);
    if (start) { block = order.size; order.set(start[1], block); continue; }
    const end = line.match(/^\s*END (B\d+)(.*)$/);
    if (end) {
      for (const [, target] of end[2].matchAll(/->(B\d+)/g)) {
        if (order.has(target) && order.get(target) <= order.get(end[1])) {
          backEdges.push([order.get(target), order.get(end[1])]);
        }
      }
      continue;
    }
    // A send's decoded description is on the line after it.
    if (/^send/.test(line)) {
      const desc = lines[i + 1] ?? '';
      if (!/bti 253\b/.test(desc)) continue;
      const kind = /OWORD block write/.test(desc) ? 'spill'
        : /OWORD block read/.test(desc) ? 'fill'
        : /DWORD scatter\w* write/.test(desc) ? 'arrayStore'
        : /DWORD scatter\w* read/.test(desc) ? 'arrayLoad'
        : 'other';
      messages.push({ kind, block });
    }
  }
  const inLoop = (b) => backEdges.some(([head, latch]) => head <= b && b <= latch);
  const counts = {};
  for (const kind of ['spill', 'fill', 'arrayStore', 'arrayLoad', 'other']) {
    const of = messages.filter((m) => m.kind === kind);
    counts[kind] = { total: of.length, inLoops: of.filter((m) => inLoop(m.block)).length };
  }
  return counts;
}

// -- parent: run a child per entry point and read its dump ------------------------

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
    return { entryPoint, adapter, dump,
             error: failure ?? `child exited ${run.status}: ${dump.slice(-300)}` };
  }

  // One summary line per compiled shader; Dawn's fixed subgroup size means
  // one SIMD width, but more would each be reported.
  const variants = [...dump.matchAll(
    /SIMD(\d+) shader: (\d+) instructions\. (\d+) loops\. (\d+) cycles\. (\d+):(\d+) spills:fills/g,
  )].map((m) => ({
    simd: +m[1], instructions: +m[2], loops: +m[3], cycles: +m[4],
    reportedSpills: +m[5], reportedFills: +m[6],
  }));
  // The final-form NIR header gives the arrays' scratch size.
  const finalAt = dump.lastIndexOf('NIR (final form)');
  const scratch = finalAt < 0 ? null
    : +(dump.slice(finalAt).match(/^scratch: (\d+)$/m)?.[1] ?? 0);
  // Only split the counts when there is exactly one shader to attribute
  // them to and the split adds up to what the compiler reported.
  const nativeAt = dump.indexOf('Native code');
  let traffic = null;
  if (variants.length === 1 && nativeAt >= 0) {
    const t = scratchTraffic(dump.slice(nativeAt));
    const v = variants[0];
    if (t.other.total === 0 &&
        t.spill.total + t.arrayStore.total === v.reportedSpills &&
        t.fill.total + t.arrayLoad.total === v.reportedFills) {
      traffic = t;
    }
  }
  return { entryPoint, adapter, dump, variants, scratch, traffic };
}

const results = entries.map(compile);

if (dumpDir) {
  await mkdir(dumpDir, { recursive: true });
  for (const r of results) await writeFile(join(dumpDir, `${r.entryPoint}.txt`), r.dump);
}

const adapter = results.find((r) => r.adapter)?.adapter ?? 'unknown adapter';
console.log(`${adapter.replace('|', ': ')}`);
console.log(`${shaderPath.replace(process.cwd() + '/', '')}\n`);

const both = ({ total, inLoops }) => `${total} (${inLoops})`;
const rows = [['entry point', 'simd', 'instr', 'spills', 'fills', 'arr st', 'arr ld',
               'scratch', 'loops', 'cycles']];
let missing = false, unsplit = false;
for (const r of results) {
  if (r.error) { rows.push([r.entryPoint, `error: ${r.error}`]); continue; }
  if (!r.variants.length) { missing = true; rows.push([r.entryPoint, '(no statistics)']); continue; }
  for (const v of r.variants) {
    const t = r.traffic;
    if (!t) unsplit = true;
    rows.push([
      r.entryPoint, `${v.simd}`, `${v.instructions}`,
      t ? both(t.spill) : `${v.reportedSpills}*`,
      t ? both(t.fill) : `${v.reportedFills}*`,
      t ? both(t.arrayStore) : '-', t ? both(t.arrayLoad) : '-',
      `${r.scratch ?? '?'}`, `${v.loops}`, `${v.cycles}`,
    ]);
  }
}
const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => (row[i] ?? '').length)));
for (const row of rows) {
  console.log(row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : (cell ?? '').padStart(widths[i])))
    .join('  ').trimEnd());
}
console.log('\ncounts are "total (in loops)"; see the comment at the top of this file for each column');

if (unsplit) {
  console.log('* Mesa\'s own spills:fills, which includes array traffic: the assembly did not ' +
              'split cleanly into the two here, so it is shown unsplit. Use --dump to look.');
}
if (missing) {
  console.log('No statistics: these come from Mesa\'s Intel driver (INTEL_DEBUG=cs), so other ' +
              'GPUs and drivers print nothing here.');
}
if (dumpDir) console.log(`full compiler output: ${join(dumpDir, '<entry point>.txt')}`);
process.exit(results.some((r) => r.error) ? 1 : 0);
