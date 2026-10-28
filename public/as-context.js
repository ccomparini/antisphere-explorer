// The device layer.
//
// GPU resources belong to a device, so anything shared between views has to
// live above the views. ASContext owns the device, the shader sources and the
// pipelines; ASScene owns the buffers a scene compiles to. Renderers hold a
// canvas and a camera and borrow both.
//
// That split is what makes multiple views into one scene possible: several
// ASRenderers on one ASContext can point at the same ASScene, each with its
// own camera, and the context encodes all of them into a single command
// buffer per frame.

import {
  requestGPU, chooseCanvasFormat, buildPipelines, uploadStorage, createTraceBuffers,
} from './gpu-setup.js';
import { loadText } from './load.js';
import {
  compileScene, compileLight, packNodes, packSurfaces, packMaterials, packLights, readScene,
} from './antisphere-scene.js';
import { BINDINGS, Node, RayQuery, Seg, viewsOf } from './gen/layouts.js';
import { bindGroup } from './bind-group.js';

const MAX_TRACE_RAYS = 16;

export class ASContext {
  /**
   * Acquire a device and build pipelines from the given shader files.
   *
   * @param {object} [opts]
   * @param {string} [opts.computeUrl]  path to the raycast shader (generated
   *                                    from shaders/ by tools/build-shaders.mjs)
   * @param {string} [opts.blitUrl]     path to the blit shader (likewise)
   * @param {(url: string) => Promise<string>} [opts.load]
   *   how to read a shader's text; fetch by default. Node passes readFile,
   *   which is how gpu.test.mjs runs the real shaders headless.
   */
  static async create(opts = {}) {
    const urls = {
      compute: opts.computeUrl ?? 'gen/antisphere-raycast.wgsl',
      blit: opts.blitUrl ?? 'gen/blit.wgsl',
    };

    const { adapter, device, canTimestamp, canBgraStorage } = await requestGPU();
    const ctx = new ASContext(adapter, device, { canTimestamp, canBgraStorage });
    ctx._sources = { urls, load: opts.load ?? loadText };

    const err = await ctx._build(await ctx._loadSources());
    if (err) throw new Error(`${err}. See the console for details.`);
    return ctx;
  }

  constructor(adapter, device, caps) {
    this.adapter = adapter;
    this.device = device;
    this.canTimestamp = caps.canTimestamp;
    this.canBgraStorage = caps.canBgraStorage;

    // One format for every canvas, decided once, because the pipelines are
    // shared and a render pipeline is tied to its target format.
    this.format = chooseCanvasFormat(caps.canBgraStorage);

    this.pipelines = null;
    this.renderers = new Set();

    // Bumped whenever the pipelines change, so renderers know their bind
    // groups are stale without needing to be told individually.
    this.generation = 0;

    this._live = null;          // the sources the current pipelines were built from
    this._rayQuery = createTraceBuffers(device, MAX_TRACE_RAYS);
    // Ray queries share one set of buffers, so they take turns: a pick
    // arriving while walk mode's ground probe is still mapped would
    // otherwise fail with the read buffer already in use.
    this._rayQueue = Promise.resolve();
    this._raf = 0;
    this._lastFrame = performance.now();
    this._onFrame = new Set();
    this._afterFrame = new Set();
  }

  /** Every shader's text: { compute, blit }. */
  async _loadSources() {
    const { urls, load } = this._sources;
    const names = Object.keys(urls);
    const texts = await Promise.all(names.map((n) => load(urls[n])));
    return Object.fromEntries(names.map((n, i) => [n, texts[i]]));
  }

  async _build(sources) {
    const { error, pipelines } = await buildPipelines(this.device, this.format, sources);
    if (error) return error;
    this.pipelines = pipelines;
    this._live = sources;
    this.generation++;
    return null;
  }

  /**
   * Refetch the shader files and rebuild. Returns null on success, or a
   * message. The previous pipelines keep rendering if the new ones fail, so a
   * bad edit shows an error rather than a black screen.
   */
  async reloadShaders({ force = false } = {}) {
    const sources = await this._loadSources();
    if (!force && Object.keys(sources).every((n) => sources[n] === this._live?.[n])) {
      return { changed: false, error: null };
    }
    const error = await this._build(sources);
    return { changed: true, error };
  }

  /** Compile a scene spec into GPU buffers that any renderer here can use. */
  createScene(spec, options = {}) {
    return new ASScene(this, spec, options);
  }

  /**
   * Read and compile a scene file, along with everything it references
   * (readScene() in antisphere-scene.js, which needs no GPU: this is that,
   * then a GPU scene of it).
   */
  async loadScene(url) {
    const { spec, files, path } = await readScene(url);
    return this.createScene(spec, { files, path });
  }

  createRenderer(canvas, opts) {
    // Imported lazily so as-renderer.js can import this module without a cycle.
    const { ASRenderer } = ASContext._rendererModule;
    const r = new ASRenderer(this, canvas, opts);
    this.renderers.add(r);
    return r;
  }

  /** Called by ASRenderer.destroy(). */
  _forget(renderer) { this.renderers.delete(renderer); }

  /**
   * Run something every frame, before the renderers encode: fn(dt, frame),
   * dt in seconds (clamped after a stall), `frame` as start() says.
   */
  onFrame(fn) { this._onFrame.add(fn); return () => this._onFrame.delete(fn); }

  /** Run something every frame, after its submit: fn(frame). */
  afterFrame(fn) { this._afterFrame.add(fn); return () => this._afterFrame.delete(fn); }

  /**
   * The frame loop every page runs: one requestAnimationFrame for every
   * view, and one submit. Each frame:
   *
   *   1. the profiler, if any, begins the frame (begin(), with tag()'s tag);
   *   2. onFrame hooks: fn(dt, frame) - time moves on, things move, the
   *      page's own GPU work runs, timed by frame.pass(name);
   *   3. every ready renderer encodes into one encoder, with options(r)
   *      merged into its encode options (a ladder's camera override). The
   *      first is timed: its compute pass as 'compute', its blit as 'blit',
   *      or the blit idle while it writes the canvas directly;
   *   4. the profiler's timestamps resolved, the submit, the profiler's
   *      end() with the frame's time and the CPU time spent on it;
   *   5. afterFrame hooks: fn(frame) - what reads the frame just sent (a
   *      ladder moving on, a probe, a stat line).
   *
   * `frame` is { dt, frameMs, pass(name), skipped(name) }: pass() is the
   * profiler's timestampWrites for a pass of that name (undefined without
   * a profiler, or not timing), skipped() says a pass asked for didn't run.
   * Each renderer encodes into the same command encoder, so a four-pane
   * editor costs one submit per frame rather than four.
   *
   * @param {object} [opts]
   * @param {FrameProfiler} [opts.profiler]   times the frames (frame-profiler.js)
   * @param {() => any} [opts.tag]            each frame's tag for the profiler
   * @param {(renderer) => object} [opts.options]  extra encode options per renderer
   */
  start({ profiler = null, tag = null, options = null } = {}) {
    if (this._raf) return;
    this._lastFrame = performance.now();
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      const now = performance.now();
      const frameMs = now - this._lastFrame;
      const dt = Math.min(0.1, frameMs / 1000);                     // clamp after a stall
      this._lastFrame = now;
      const cpuStart = performance.now();
      profiler?.begin(tag?.());
      const frame = {
        dt, frameMs,
        pass: (name) => profiler?.pass(name),
        skipped: (name) => profiler?.skipped(name),
      };

      for (const fn of this._onFrame) fn(dt, frame);

      const active = [...this.renderers].filter((r) => r.ready);
      const enc = this.device.createCommandEncoder();
      active.forEach((r, i) => {
        const timed = i === 0 && profiler;
        if (timed && r.directOut) profiler.idle('blit');
        const drew = r.encode(enc, {
          ...(options?.(r) ?? {}),
          ...(timed ? { computeTimestamps: frame.pass('compute'),
                        blitTimestamps: r.directOut ? undefined : frame.pass('blit') } : {}),
        });
        if (timed && !drew) { frame.skipped('compute'); frame.skipped('blit'); }
      });
      profiler?.resolve(enc);
      this.device.queue.submit([enc.finish()]);
      profiler?.end(frameMs, performance.now() - cpuStart);

      for (const fn of this._afterFrame) fn(frame);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }
}

// Set by as-renderer.js on import, so the two modules can refer to each other
// without an import cycle.
ASContext._rendererModule = null;

// ---------------------------------------------------------------------------

export class ASScene {
  constructor(context, spec, options = {}) {
    this.context = context;
    // Kept so update() can recompile: the editor hands back an edited spec,
    // not the files it references.
    this.files = options.files ?? {};
    this.path = options.path ?? '';
    this.nodeBuf = this.lightBuf = this.matBuf = null;

    // Bumped on any change that invalidates a bind group, so renderers can
    // notice without being subscribed.
    this.generation = 0;

    this.update(spec, { warn: options.warn });
  }

  /**
   * Recompile and replace every buffer. compileScene throws before anything
   * here is touched, so a bad spec leaves the previous scene intact. Its
   * warnings go to options.warn(path, msg), if given, or the console.
   */
  update(spec, options = {}) {
    if (options.files) this.files = options.files;
    if (options.path !== undefined) this.path = options.path;
    const built = compileScene(spec, { files: this.files, path: this.path,
                                       ...(options.warn ? { warn: options.warn } : {}) });
    this.load(built, spec);
  }

  /**
   * Take a compiled scene (compileScene()'s result, perhaps worked on since -
   * a mover grafted in, movers.js) and replace every buffer with it.
   */
  load(built, spec = this.spec) {
    const { device } = this.context;

    this.destroyBuffers();

    this.spec = spec;
    this.nodes = built.nodes;
    // provenance[i] names the authored object and path node i came from, or
    // is null for nodes the compiler invented. See antisphere-scene.js.
    this.provenance = built.provenance;
    this.materials = built.materials;
    this.lights = built.lights;
    this.topLights = built.topLights;   // the first this many are the scene's own (env 0)
    this.camera = built.camera ?? null;
    // Members of groups that may overlap (compileScene).
    this.overlaps = built.overlaps;

    const nodeData = packNodes(built.nodes, built.materials);
    // Which nodes are the same surface (packSurfaces), for rays that start
    // on one.
    this.surfaces = packSurfaces(built.nodes);
    const lightData = packLights(built.lights);
    const matData = packMaterials(built.materials);
    this.nodeBuf = uploadStorage(device, nodeData);
    this.surfaceBuf = uploadStorage(device, this.surfaces);
    this.lightBuf = uploadStorage(device, lightData);
    this.matBuf = uploadStorage(device, matData);
    this.bytes = nodeData.byteLength + this.surfaces.byteLength + lightData.byteLength + matData.byteLength;
    this.generation++;
  }

  /**
   * Move nodes without recompiling: give some nodes new quadrics (`entries`,
   * [index, prim] pairs), the tree otherwise as it was - their children,
   * materials and envs. The nodes from the first to the last moved are
   * repacked and written into the node buffer in place, one write, so no
   * bind group changes: cheap enough to do every frame.
   *
   * Whether the tree is still right with them moved is the caller's to
   * know: a chain of self-contained parts, each in the others' outsides, is
   * right in any pose; a group's dividers and grafts are not. Surfaces
   * (packSurfaces()) stay as compiled - which ids are the same surface is
   * unchanged by moving distinct ones.
   */
  setNodePrims(entries) {
    if (!entries.length) return;
    let lo = Infinity, hi = -Infinity;
    for (const [index, prim] of entries) {
      this.nodes[index] = { ...this.nodes[index], prim };
      lo = Math.min(lo, index);
      hi = Math.max(hi, index);
    }
    const data = packNodes(this.nodes.slice(lo, hi + 1), this.materials, lo);
    this.context.device.queue.writeBuffer(this.nodeBuf, lo * Node.STRIDE, data);
  }

  /**
   * Replace the scene's own lights - its top-level "lights", env 0's -
   * without recompiling anything, keeping those its nodes carry. Give as
   * many as it had; a different number needs a recompile.
   *
   * The light buffer is allocated at capacity and the live count travels in
   * the camera uniform, so this is a buffer write rather than a reallocation,
   * and no bind group is invalidated. Cheap enough to do per frame.
   */
  setLights(lights) {
    this.lights = [...lights.map((lt) => ({ ...compileLight(lt), env: 0 })), ...this.lights.slice(this.topLights)];
    this.topLights = lights.length;
    this.context.device.queue.writeBuffer(this.lightBuf, 0, packLights(this.lights));
  }

  /**
   * Cast rays on the GPU and read back what each one hit: { node, t0, t1 },
   * parallel arrays with one entry per ray - the Seg that the shader's
   * trace() returns for each:
   *   node   the node whose region the ray entered, or 0 for a miss
   *   t0     how far along the ray it entered
   *   t1     where the segment it was found in ends (not a thickness)
   * node == 0 is the only miss test; t0 and t1 are meaningless for a miss.
   *
   * A ray is { origin, direction, tMin?, tMax?, fromNode? }: tMin defaults
   * to 1e-3 and tMax to 1000. fromNode is a node whose surface the ray
   * starts on - a hit's node, for a ray leaving where another hit - which
   * trace() then never takes the ray to hit at its start, though it may
   * meet that surface again further on: give it with tMin 0, and no offset
   * is needed.
   *
   * Uses traceFrom(), a second entry point in the raycast shader that shares
   * trace() with the renderer, so a caller costs more rays in a batch rather
   * than new shader code. Queries take turns on the context's shared
   * buffers.
   *
   * The round trip is a frame or two, so this is for queries whose answer can
   * lag — ground height, collision probes, picking — not for anything
   * synchronous.
   */
  castRays(rays) {
    const context = this.context;
    const run = () => this._cast(rays);
    const result = context._rayQueue.then(run, run);
    context._rayQueue = result.then(() => {}, () => {});
    return result;
  }

  async _cast(rays) {
    const { device, pipelines, _rayQuery: rq } = this.context;
    if (!pipelines || rays.length === 0 || !this.nodeBuf) {
      return { node: new Uint32Array(0), t0: new Float32Array(0), t1: new Float32Array(0) };
    }
    if (rays.length > rq.maxRays) {
      throw new Error(`castRays: ${rays.length} rays, capacity is ${rq.maxRays}`);
    }

    const queries = RayQuery.allocate(rays.length);
    rays.forEach((r, i) => RayQuery.write(queries, i, {
      origin: r.origin,
      tMin: r.tMin ?? 1e-3,
      direction: r.direction,
      tMax: r.tMax ?? 1000,
      fromNode: r.fromNode ?? 0,
    }));
    device.queue.writeBuffer(rq.rayBuf, 0, queries.buffer);

    const group = bindGroup(
      device,
      pipelines.traceFrom,
      BINDINGS['antisphere-raycast'],
      'traceFrom', {
        nodes: this.nodeBuf,
        surfaces: this.surfaceBuf,
        materials: this.matBuf,
        rayQueries: rq.rayBuf,
        rayResults: rq.resultBuf,
      }
    );

    const bytes = rays.length * Seg.STRIDE;
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipelines.traceFrom);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(rq.resultBuf, 0, rq.readBuf, 0, bytes);
    device.queue.submit([enc.finish()]);

    await rq.readBuf.mapAsync(GPUMapMode.READ, 0, bytes);
    const raw = rq.readBuf.getMappedRange(0, bytes).slice(0);
    rq.readBuf.unmap();

    const hits = viewsOf(raw);
    const n = rays.length;
    const node = new Uint32Array(n), t0 = new Float32Array(n), t1 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const hit = Seg.read(hits, i);
      node[i] = hit.node;
      t0[i] = hit.t0;
      t1[i] = hit.t1;
    }
    return { node, t0, t1 };
  }

  /**
   * Hit distances only, -1 where the ray missed. The node decides a miss,
   * since the shader leaves t0 stale then.
   */
  async traceRays(rays) {
    const { node, t0 } = await this.castRays(rays);
    return t0.map((t, i) => (node[i] ? t : -1));
  }

  /** One ray, for callers that want a scalar. Negative means no hit. */
  async traceRay(origin, direction, opts = {}) {
    const [t] = await this.traceRays([{ origin, direction, ...opts }]);
    return t ?? -1;
  }

  /**
   * What one ray hits first: { node, t0, t1 }, or null for a miss. The node
   * indexes this scene's nodes, and provenance[node] says which authored
   * object it came from; the hit point is origin + t0 * direction.
   */
  async pick(origin, direction, opts = {}) {
    const { node, t0, t1 } = await this.castRays([{ origin, direction, ...opts }]);
    return node[0] ? { node: node[0], t0: t0[0], t1: t1[0] } : null;
  }

  destroyBuffers() {
    const buffers = [
      'surfaceBuf',
      'nodeBuf',
      'lightBuf',
      'matBuf'
    ]
    for (const bname of buffers) {
      const b = this[bname];
      if (b) {
        b.destroy();
        this[bname] = null;
      }
    }
  }

  destroy() {
    this.destroyBuffers();
  }
}
