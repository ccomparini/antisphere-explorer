// Tests for physlab's frame profiler, with real GPU timestamps. Run with:
//   node --test public/physlab/
//
// Skipped where there is no GPU, or no timestamp-query.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { FrameProfiler } from './profiler.js';

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
  assert.equal(panel.cells.gpu.textContent, panel.cells.render.textContent);

  // Back again: timed again.
  for (let f = 0; f < 3; f++) await frame(profiler, ['render', 'blit']);
  profiler._show();
  assert.match(panel.cells.blit.textContent, /ms$/);
});
