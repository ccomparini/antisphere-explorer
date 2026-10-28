// Tests for the frame profiler, with real GPU timestamps. Run with:
//   node --test public/frame-profiler.test.mjs
//
// Skipped where there is no GPU, or no timestamp-query.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { FrameProfiler } from './frame-profiler.js';

async function openDevice() {
  let webgpu;
  try { webgpu = await import('webgpu'); } catch { return { skip: 'no webgpu package; run npm install' }; }
  Object.assign(globalThis, webgpu.globals);
  globalThis.gpuInstance ??= webgpu.create([]);        // held: see CLAUDE.md
  const adapter = await globalThis.gpuInstance.requestAdapter();
  if (!adapter) return { skip: 'no GPU adapter' };
  if (!adapter.features.has('timestamp-query')) return { skip: 'no timestamp-query' };
  return { device: await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] }) };
}
const { device, skip } = await openDevice();
after(() => device?.destroy());

// Just enough of the panel for the profiler: its cells by data-k.
function fakePanel() {
  const cells = {};
  return {
    cells,
    set innerHTML(html) {
      for (const [, k] of html.matchAll(/data-k="([^"]+)"/g)) cells[k] = { dataset: { k }, textContent: '' };
    },
    querySelectorAll: () => Object.values(cells),
    querySelector: () => ({ textContent: '', innerHTML: '' }),
  };
}

// One frame, timing the named passes (empty compute passes stand in for
// them); `wait` for its times to come back.
async function frame(profiler, passes, wait = true) {
  profiler.begin();
  const enc = device.createCommandEncoder();
  for (const name of passes) {
    const timestampWrites = profiler.pass(name);
    enc.beginComputePass(timestampWrites ? { timestampWrites } : {}).end();
  }
  profiler.resolve(enc);
  device.queue.submit([enc.finish()]);
  profiler.end(16, 1);
  if (wait) await settled(profiler);
}
async function settled(profiler) {
  await device.queue.onSubmittedWorkDone();
  while (profiler.pending) await new Promise((r) => setTimeout(r, 1));
}

test('an idle pass shows no time and leaves the total, at once', { skip }, async () => {
  const panel = fakePanel();
  const profiler = new FrameProfiler(device, true, ['render', 'blit', 'physics'], panel);
  for (let f = 0; f < 5; f++) await frame(profiler, ['render', 'blit']);
  profiler._show();
  assert.match(panel.cells.render.textContent, /ms$/);
  assert.match(panel.cells.blit.textContent, /ms$/);
  assert.equal(panel.cells.physics.textContent, '-', 'never ran');

  // The blit stops (the renderer writes straight to the canvas) while a
  // frame that had one is still being read back: that frame's blit time
  // must not come back as the only sample, left showing for good.
  await frame(profiler, ['render', 'blit'], false);
  profiler.idle('blit');
  await settled(profiler);
  for (let f = 0; f < 3; f++) await frame(profiler, ['render']);     // idle once is enough
  profiler._show();
  assert.equal(panel.cells.blit.textContent, '-');
  assert.match(panel.cells.gpu.textContent, /ms$/, 'a total still (exactly: the scripted test below)');

  // Back again: timed again.
  for (let f = 0; f < 3; f++) await frame(profiler, ['render', 'blit']);
  profiler._show();
  assert.match(panel.cells.blit.textContent, /ms$/);
});

test('frames in flight: counted at submit, uncounted as each completes', { skip }, async () => {
  const panel = fakePanel();
  const profiler = new FrameProfiler(device, true, ['render'], panel);
  // Three frames submitted back to back, none waited for: all three are
  // in flight until the GPU has done them.
  for (let f = 0; f < 3; f++) await frame(profiler, ['render'], false);
  assert.equal(profiler.inFlight, 3);
  await settled(profiler);
  await new Promise((r) => setTimeout(r, 10));        // the completions' callbacks
  assert.equal(profiler.inFlight, 0);
  profiler._show();
  assert.equal(panel.cells.flight.textContent, '0 (peak 3)');
  profiler._show();                                    // the peak starts again from now
  assert.equal(panel.cells.flight.textContent, '0 (peak 0)');
});

// -- times as chosen: a stand-in for the timestamps, no GPU ------------------

/**
 * A profiler whose timestamps read back as `stamps` (ns, two per pass in
 * the passes' order), set before each frame; no GPU needed.
 */
function scripted(passes, options) {
  const panel = fakePanel();
  const notes = { textContent: '' };
  panel.querySelector = (sel) => (sel === '.note' ? notes : { textContent: '', innerHTML: '' });
  const fakeDevice = { queue: { onSubmittedWorkDone: async () => {} } };
  const profiler = new FrameProfiler(fakeDevice, false, passes, panel, options);
  let stamps = [];
  profiler.ts = {
    querySet: {}, count: passes.length * 2, resolveBuf: {},
    readBuf: { mapAsync: async () => {}, getMappedRange: () => BigInt64Array.from(stamps.map(BigInt)).buffer, unmap() {} },
  };
  const run = async (times, ran = passes, tag) => {
    stamps = times;
    profiler.begin(tag);
    for (const name of ran) profiler.pass(name);
    profiler.end(16, 1);
    while (profiler.pending) await new Promise((r) => setTimeout(r, 0));
  };
  return { profiler, panel, notes, run };
}

test('two passes: gpu total is the first start to the last end, the gap the time between', async () => {
  const { profiler, panel, run } = scripted(['render', 'blit']);
  await run([0, 2e6, 3e6, 4e6]);              // render 0-2 ms, blit 3-4 ms
  profiler._show();
  assert.equal(panel.cells.render.textContent, '2.00 ms');
  assert.equal(panel.cells.blit.textContent, '1.00 ms');
  assert.equal(panel.cells.gap.textContent, '1.00 ms');
  assert.equal(panel.cells.gpu.textContent, '4.00 ms', 'the span: the passes and the gap');
  await run([5e6, 6e6, 1e6, 3e6]);              // blit first, render after: a gap all the same
  profiler._show();
  assert.equal(panel.cells.gap.textContent, '1.50 ms', 'the mean of 1 and 2');
  assert.equal(panel.cells.gpu.textContent, '4.50 ms', 'the mean of the spans, 4 and 5');
});

test('overlapping passes: the total is the span, not the passes summed; the gap says overlap', async () => {
  // As Apple's GPUs stamp them: the blit's start stamped as the compute
  // pass starts, then waiting on it - each pass 25 ms, the frame 25.1.
  const { profiler, panel, run } = scripted(['compute', 'blit']);
  await run([0, 25e6, 0.05e6, 25.1e6]);
  profiler._show();
  assert.equal(panel.cells.gpu.textContent, '25.10 ms', 'not 50.05');
  assert.equal(panel.cells.gap.textContent, '(overlap) -24.95 ms');
});

test('a pass gone idle leaves the total at once: the span from then is the remaining passes\'', async () => {
  const { profiler, panel, run } = scripted(['render', 'blit']);
  for (let f = 0; f < 3; f++) await run([0, 2e6, 3e6, 10e6]);    // a 10 ms frame, with its blit
  profiler.idle('blit');
  await run([0, 2e6], ['render']);
  profiler._show();
  assert.equal(panel.cells.gpu.textContent, '2.00 ms', 'no 10 ms frames left in it');
  assert.equal(panel.cells.blit.textContent, '-');
});

test('one pass: its own total, and no gap row', async () => {
  const { profiler, panel, run } = scripted(['render']);
  await run([0, 3e6]);
  profiler._show();
  assert.equal(panel.cells.gap, undefined);
  assert.equal(panel.cells.gpu.textContent, '3.00 ms');
});

test('a bad time is counted and dropped, not averaged; quantized times are said so', async () => {
  const { profiler, panel, notes, run } = scripted(['render', 'blit']);
  await run([1234, 2e6 + 1234, 3e6 + 7, 4e6 + 9]);
  await run([5e6, 1e6, 6e6, 7e6]);             // render ends before it starts: a counter reset
  profiler._show();
  assert.equal(profiler.dropped, 1);
  assert.match(notes.textContent, /1 bad samples dropped/);
  assert.doesNotMatch(notes.textContent, /quantized/);
  assert.equal(panel.cells.render.textContent, '2.00 ms', 'the good frame alone');
  await run([0, 2e6, 3e6, 4e6]);                // every one a whole 100 us
  profiler._show();
  assert.match(notes.textContent, /quantized/);
});

test('enabled false times nothing; onTimes hears each timed frame, with its tag', async () => {
  let on = false;
  const heard = [];
  const { profiler, run } = scripted(['render'], { enabled: () => on });
  profiler.onTimes((tag, times) => heard.push([tag, times.render]));
  await run([0, 1e6], ['render'], 'off');
  assert.equal(profiler.pass('render'), undefined, 'not timing');
  on = true;
  await run([0, 2e6], ['render'], 'rung 1');
  assert.deepEqual(heard, [['rung 1', 2]]);
});
