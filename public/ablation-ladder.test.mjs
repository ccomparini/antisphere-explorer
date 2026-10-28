// Tests for the ablation ladder, on a stand-in profiler that hands back
// times as chosen: no GPU. Run with:
//   node --test public/ablation-ladder.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AblationLadder } from './ablation-ladder.js';

// Just enough of an element: its parts by class, their text and HTML.
function fakeElement() {
  const parts = {};
  return {
    parts,
    set innerHTML(html) { for (const [, c] of html.matchAll(/class="([^"]+)"/g)) parts[c] = { textContent: '', innerHTML: '' }; },
    querySelector: (sel) => parts[sel.slice(1)],
  };
}

// A ladder on a profiler whose frames take `msOf(rung)` (a rung's index,
// or -1 warming up), and a way to run frames through it.
function rig(msOf) {
  let listener = null;
  const profiler = { onTimes: (fn) => { listener = fn; } };
  const element = fakeElement();
  const ladder = new AblationLadder(profiler, element);
  const frames = (n) => {
    for (let f = 0; f < n && ladder.running; f++) {
      const tag = ladder.tag();
      const rung = ladder.run.i;
      listener(tag, { render: msOf(rung) });
      ladder.frame();
    }
  };
  return { ladder, element, frames };
}

test('rungs advance after warmup and their samples; each stage is the gap between rungs', () => {
  // Dispatch 1 ms, traversal 3, shading 3.5, shadow rays 6: stages 1, 2, 0.5, 2.5.
  const { ladder, element, frames } = rig((rung) => [1, 3, 3.5, 6][rung]);
  ladder.start({ shadows: true, label: 'blit' });
  assert.deepEqual(ladder.override(), { shadows: 0, ablate: 0, debugView: 0 }, 'dispatch first');
  frames(8);
  assert.equal(ladder.run.i, 0, 'still warming up');
  frames(16);
  assert.equal(ladder.run.i, 1, 'its 16 samples, then the next rung');
  assert.deepEqual(ladder.override(), { shadows: 0, ablate: 1, debugView: 0 });
  frames(1000);
  assert.equal(ladder.running, false);
  assert.equal(ladder.override(), undefined);
  assert.equal(element.parts['lad-status'].textContent, '6.00 ms · shadows on · blit');
  assert.match(element.parts['lad-rows'].innerHTML, /traversal<\/span><b>2\.00 ms &middot; 33%/);
  assert.match(element.parts['lad-rows'].innerHTML, /shadow rays<\/span><b>2\.50 ms/);
  assert.deepEqual(AblationLadder.stages([[1, 1, 9], [3, 4, 3]]), [1, 2], 'medians, differenced');
});

test('with shadows off, the shadow-ray rung is left out, unless forced', () => {
  const { ladder, frames } = rig(() => 1);
  ladder.start({ shadows: false });
  assert.equal(ladder.run.rungs.length, 3);
  assert.equal(ladder.run.label, 'shadows off');
  ladder.cancel();
  ladder.start({ shadows: false, force: true });
  assert.equal(ladder.run.rungs.length, 4);
  assert.equal(ladder.run.label, 'shadows on (forced)');
  frames(1000);
  assert.equal(ladder.running, false);
});

test('a rung with no times gives up after 300 frames; cancel stops a run', () => {
  const { ladder, element, frames } = rig((rung) => (rung === 1 ? undefined : 2));
  ladder.start({ shadows: false });
  frames(24);
  assert.equal(ladder.run.i, 1);
  frames(300);
  assert.equal(ladder.run.i, 1, 'still waiting');
  frames(2);
  assert.equal(ladder.run.i, 2, 'given up on');
  ladder.cancel();
  assert.equal(ladder.running, false);
  assert.equal(element.parts['lad-status'].textContent, 'cancelled');
});
