// Always-on frame profiling for physlab: frames per second, frame and CPU
// time, and GPU time per pass from timestamp queries, shown in a small
// panel with a frame-time sparkline.
//
// GPU timestamps can only be written at pass boundaries, so what is timed
// is whole passes, each by name ('render', 'physics'). A frame
// asks for a pass's timestampWrites, hands them to the pass, then
// resolves everything into its command encoder; the readback lands a frame
// or more later, and a frame arriving while one is pending isn't timed.
// Browsers may quantize timestamps (Chrome to 100 us by default), so read
// these as milliseconds, not microseconds.
//
// A pass that isn't running at all (a blit, say, when the renderer writes
// straight to the canvas) is declared idle, so that it reads "-" and
// counts for nothing in the total, rather than going on showing its last
// average. That is different from skipped(): a pass that didn't run this
// frame, as physics doesn't when a frame is too short for a substep.
//
// submit→done is latency, not work: onSubmittedWorkDone() waits for
// everything submitted so far, frames queued ahead of this one included.
// Frames in flight says how many are queued: counted at each end(),
// uncounted as each one's work completes, shown as the count now and the
// most since the last update. A GPU that can't keep up shows as several,
// until the browser stops handing out canvas images. (The browser delivers
// completions on its own schedule, which can add one.)

import { createTimestampQuery } from '../gpu-setup.js';

// Rolling means, so the readout doesn't flicker.
function rolling(n) {
  const buf = [];
  const avg = (x) => {
    if (x !== undefined) { buf.push(x); if (buf.length > n) buf.shift(); }
    return buf.length ? buf.reduce((a, b) => a + b, 0) / buf.length : NaN;
  };
  avg.clear = () => { buf.length = 0; };
  return avg;
}

const ms = (x) => (Number.isFinite(x) ? `${x.toFixed(2)} ms` : '-');

export class FrameProfiler {
  /**
   * @param {GPUDevice} device
   * @param {boolean} canTimestamp  whether the device has timestamp-query
   * @param {string[]} passes       names of the passes to time
   * @param {HTMLElement} panel     where to show it (filled in here)
   */
  constructor(device, canTimestamp, passes, panel) {
    this.device = device;
    this.passes = passes;
    this.ts = createTimestampQuery(device, canTimestamp, passes.length * 2);
    this.pending = false;
    this.inFlight = 0;            // frames submitted whose work hasn't completed
    this.peakInFlight = 0;        // the most since the last _show()
    this.timing = false;          // whether this frame's passes are timed
    this.written = new Set();     // passes that actually ran this frame
    this.avg = { frame: rolling(30), cpu: rolling(30), done: rolling(30) };
    for (const p of passes) this.avg[p] = rolling(30);
    this.idlePasses = new Set();  // passes not running at all (idle())
    this.history = new Array(120).fill(0);
    this.frames = 0;
    this.fps = 0;
    this.since = performance.now();
    this.extra = {};              // other figures to show, by label

    panel.innerHTML = [
      row('fps', 'fps'), row('frame', 'frame'), row('cpu', 'cpu'),
      ...passes.map((p) => row(p, `gpu ${p}`)), row('gpu', 'gpu total'), row('done', 'submit→done'),
      row('flight', 'frames in flight'),
      '<canvas class="spark" width="240" height="40"></canvas>',
      '<div class="extra"></div><div class="note"></div>',
    ].join('');
    this.panel = panel;
    this.cells = {};
    for (const b of panel.querySelectorAll('b[data-k]')) this.cells[b.dataset.k] = b;
    this.spark = panel.querySelector('.spark');
    if (!this.ts) panel.querySelector('.note').textContent = 'timestamp-query unavailable: no GPU times';
  }

  /** Start a frame: decide whether its passes are timed. */
  begin() {
    this.timing = !!this.ts && !this.pending;
    this.written.clear();
  }

  /** timestampWrites for pass `name` this frame, or undefined when not timing. */
  pass(name) {
    this.idlePasses.delete(name);
    if (!this.timing) return undefined;
    const i = this.passes.indexOf(name);
    this.written.add(name);
    return { querySet: this.ts.querySet, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 };
  }

  /** A pass that was asked for but didn't run this frame (so has no times). */
  skipped(name) { this.written.delete(name); }

  /**
   * A pass that isn't running at all now: it shows no time, and none in
   * the total, until it is asked for again with pass(). Times still on
   * their way back from before are dropped.
   */
  idle(name) {
    this.idlePasses.add(name);
    this.written.delete(name);
    this.avg[name].clear();
  }

  /** Resolve this frame's timestamps into `enc`, before it is finished. */
  resolve(enc) {
    if (!this.timing) return;
    enc.resolveQuerySet(this.ts.querySet, 0, this.ts.count, this.ts.resolveBuf, 0);
    enc.copyBufferToBuffer(this.ts.resolveBuf, 0, this.ts.readBuf, 0, this.ts.count * 8);
  }

  /**
   * After submitting: read the timestamps back (not waited for), time how
   * long the GPU takes to finish, and fold in this frame's frame and CPU
   * times.
   */
  end(frameMs, cpuMs) {
    const submitted = performance.now();
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    this.device.queue.onSubmittedWorkDone().then(() => this.avg.done(performance.now() - submitted))
      .finally(() => { this.inFlight--; });
    if (this.timing) {
      this.pending = true;
      const ran = [...this.written];
      this.ts.readBuf.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigInt64Array(this.ts.readBuf.getMappedRange().slice(0));
        this.ts.readBuf.unmap();
        for (const name of ran) {
          if (this.idlePasses.has(name)) continue;          // gone idle since
          const i = this.passes.indexOf(name);
          const ns = Number(t[2 * i + 1] - t[2 * i]);
          // Counters occasionally reset, showing as negative or wild gaps.
          if (ns >= 0 && ns < 1e9) this.avg[name](ns / 1e6);
        }
      }).catch(() => {}).finally(() => { this.pending = false; });
    }
    this.avg.frame(frameMs);
    this.avg.cpu(cpuMs);
    this.history.push(frameMs);
    this.history.shift();
    this.frames++;
    const now = performance.now();
    if (now - this.since >= 500) {
      this.fps = Math.round((this.frames * 1000) / (now - this.since));
      this.frames = 0;
      this.since = now;
      this._show();
    }
  }

  _show() {
    const c = this.cells;
    c.fps.textContent = String(this.fps);
    c.frame.textContent = ms(this.avg.frame());
    c.cpu.textContent = ms(this.avg.cpu());
    let gpu = 0, any = false;
    for (const p of this.passes) {
      const v = this.avg[p]();
      c[p].textContent = this.ts ? ms(v) : 'n/a';
      if (Number.isFinite(v)) { gpu += v; any = true; }
    }
    c.gpu.textContent = this.ts && any ? ms(gpu) : 'n/a';
    c.done.textContent = ms(this.avg.done());
    c.flight.textContent = `${this.inFlight} (peak ${this.peakInFlight})`;
    this.peakInFlight = this.inFlight;
    this.panel.querySelector('.extra').innerHTML =
      Object.entries(this.extra).map(([k, v]) => row(null, k, v)).join('');
    this._spark();
  }

  _spark() {
    const g = this.spark.getContext?.('2d');
    if (!g) return;
    const { width: w, height: h } = this.spark;
    g.clearRect(0, 0, w, h);
    const peak = Math.max(16.7, ...this.history);
    g.strokeStyle = '#2a3340';                      // the 60 fps line
    g.beginPath();
    const y60 = h - (16.7 / peak) * h;
    g.moveTo(0, y60); g.lineTo(w, y60); g.stroke();
    g.fillStyle = '#4b9fd8';
    const bw = w / this.history.length;
    this.history.forEach((v, i) => {
      const bh = Math.max(1, (v / peak) * h);
      g.fillRect(i * bw, h - bh, Math.max(1, bw - 1), bh);
    });
  }
}

function row(key, label, value = '-') {
  return `<div class="r"><span>${label}</span><b${key ? ` data-k="${key}"` : ''}>${value}</b></div>`;
}
