// The ablation ladder: what each stage of a frame costs, by rendering the
// same view again and again with stages switched off, from the bottom up -
// dispatch alone, then traversal, then shading, then shadow rays - and
// differencing the rungs' times. Pass timestamps carry a systematic bias in
// how the driver stamps pass edges, but it cancels when the same
// measurement is differenced across configurations, so the gaps between
// rungs are trustworthy where the absolute numbers are not.
//
// It rides on a FrameProfiler (frame-profiler.js), which times the frames
// and hands back each one's times with its tag (onTimes()). Each frame:
//
//   profiler.begin(ladder.tag());
//   view.encode(enc, { camera: ladder.override(), computeTimestamps: profiler.pass('render') });
//   ...submit, profiler.end(...)
//   ladder.frame();
//
// A run profiles the configuration on screen. With shadows off the last
// rung would repeat the one before it, so it is dropped and the run is
// labelled so; `force` runs it all the same, for when the shadow cost is
// the question.

const LADDER = [
  { name: 'dispatch',    ablate: 0, shadows: 0, color: '#3d4757' },
  { name: 'traversal',   ablate: 1, shadows: 0, color: '#4b9fd8' },
  { name: 'shading',     ablate: 2, shadows: 0, color: '#5ec26a' },
  { name: 'shadow rays', ablate: 2, shadows: 1, color: '#e0b83c' },
];
const WARMUP = 8;       // frames discarded after switching rungs
const SAMPLES = 16;     // times collected per rung
const GIVE_UP = 300;    // frames on one rung before moving on regardless

const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : NaN;
};

export class AblationLadder {
  /**
   * @param {FrameProfiler} profiler  times the frames (its onTimes())
   * @param {HTMLElement} element     where to show it (filled in here)
   * @param {object} [options]
   * @param {string} [options.pass]   the profiler's pass the rungs time
   */
  constructor(profiler, element, { pass = 'render' } = {}) {
    this.element = element;
    this.run = null;
    element.innerHTML = '<div class="r"><span>ablation</span><b class="lad-status">A to run</b></div>'
                      + '<div class="lad-bar"></div><div class="lad-rows"></div>';
    this.status = element.querySelector('.lad-status');
    this.bar = element.querySelector('.lad-bar');
    this.rows = element.querySelector('.lad-rows');
    profiler.onTimes((rung, times) => {
      if (this.run && rung === this.run.i && times[pass] !== undefined) this.run.samples[rung].push(times[pass]);
    });
  }

  get running() { return !!this.run; }

  /**
   * Start a run of the view as it is: `shadows`, whether it casts them;
   * `force`, run the shadow-ray rung even so; `label`, what the result is
   * of (shown with it).
   */
  start({ shadows, force = false, label = '' } = {}) {
    const rungs = force || shadows ? LADDER : LADDER.slice(0, 3);
    this.run = {
      i: 0, frames: 0, rungs, samples: rungs.map(() => []),
      label: `${force || shadows ? 'shadows on' : 'shadows off'}${label ? ` · ${label}` : ''}`
           + (force && !shadows ? ' (forced)' : ''),
    };
    this.status.textContent = `running 1/${rungs.length}: ${rungs[0].name}`;
  }

  cancel() {
    if (!this.run) return;
    this.run = null;
    this.status.textContent = 'cancelled';
  }

  /** At a frame's start: its tag for the profiler - the rung it samples, or -1 while warming up. */
  tag() {
    if (!this.run) return -1;
    this.run.frames++;
    return this.run.frames > WARMUP ? this.run.i : -1;
  }

  /** The renderer's overrides for this frame (view.encode()'s camera), or none. */
  override() {
    const rung = this.run?.rungs[this.run.i];
    return rung ? { shadows: rung.shadows, ablate: rung.ablate, debugView: 0 } : undefined;
  }

  /** After a frame: move on to the next rung, or finish, when this one has its samples. */
  frame() {
    const run = this.run;
    if (!run) return;
    if (run.frames > WARMUP && (run.samples[run.i].length >= SAMPLES || run.frames > GIVE_UP)) {
      run.i++;
      run.frames = 0;
      if (run.i >= run.rungs.length) { this._finish(); return; }
    }
    this.status.textContent = `running ${run.i + 1}/${run.rungs.length}: ${run.rungs[run.i].name}`;
  }

  /** Each stage's time: the gap between consecutive rungs' medians (the first, its own). */
  static stages(samples) {
    const totals = samples.map(median);
    return totals.map((t, i) => (i === 0 ? t : t - totals[i - 1]));
  }

  _finish() {
    const { samples, rungs, label } = this.run;
    this.run = null;
    // Differences can go slightly negative on noise; report them rather
    // than hide them.
    const parts = AblationLadder.stages(samples);
    const total = parts.reduce((a, b) => a + b, 0);
    this.status.textContent = `${total.toFixed(2)} ms · ${label}`;
    this.bar.innerHTML = rungs.map((L, i) =>
      `<span style="width:${Math.max(0, parts[i]) / total * 100}%;background:${L.color}"></span>`).join('');
    this.rows.innerHTML = rungs.map((L, i) =>
      `<div class="r"><span><i style="background:${L.color}"></i>${L.name}</span>`
      + `<b>${parts[i].toFixed(2)} ms &middot; ${(parts[i] / total * 100).toFixed(0)}%</b></div>`).join('');
  }
}
