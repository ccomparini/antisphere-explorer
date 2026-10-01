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
  loadText, requestGPU, chooseCanvasFormat, buildPipelines, uploadStorage,
  createTraceBuffers, createOverlapBuffers,
} from './gpu-setup.js';
import {
  compileScene, packNodes, packMaterials, packLights, loadImports,
} from './antisphere-scene.js';
import { BINDINGS, OverlapQuery, OverlapResult, RayQuery, Seg, viewsOf } from './gen/layouts.js';
import { bindGroup } from './bind-group.js';

const MAX_TRACE_RAYS = 16;
const MAX_OVERLAP_PAIRS = 1024;

export class ASContext {
  /**
   * Acquire a device and build pipelines from the given shader files.
   *
   * @param {object} [opts]
   * @param {string} [opts.computeUrl]  path to the raycast shader (generated
   *                                    from shaders/ by tools/build-shaders.mjs)
   * @param {string} [opts.blitUrl]     path to the blit shader (likewise)
   * @param {string} [opts.overlapUrl]  path to the overlap-query shader (likewise)
   * @param {(url: string) => Promise<string>} [opts.load]
   *   how to read a shader's text; fetch by default. Node passes readFile,
   *   which is how gpu.test.mjs runs the real shaders headless.
   */
  static async create(opts = {}) {
    const urls = {
      compute: opts.computeUrl ?? 'gen/antisphere-raycast.wgsl',
      blit: opts.blitUrl ?? 'gen/blit.wgsl',
      overlap: opts.overlapUrl ?? 'gen/overlap.wgsl',
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
    this._overlapQuery = createOverlapBuffers(device, MAX_OVERLAP_PAIRS);
    // Ray queries share one set of buffers, so they take turns: a pick
    // arriving while walk mode's ground probe is still mapped would
    // otherwise fail with the read buffer already in use.
    this._rayQueue = Promise.resolve();
    this._raf = 0;
    this._lastFrame = performance.now();
    this._onFrame = new Set();
  }

  /** Every shader's text: { compute, blit, overlap }. */
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
   * Fetch and compile a scene file, along with anything it imports.
   *
   * Imported files are fetched relative to the file that names them, so a
   * scene in scenes/ can say "import": ["parts/bolt.json"] and mean
   * scenes/parts/bolt.json.
   */
  async loadScene(url) {
    const spec = JSON.parse(await loadText(url));
    const imports = await loadImports(spec, async (path) => JSON.parse(await loadText(path)),
                                      { from: url });
    return this.createScene(spec, { imports, path: url });
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

  /** Run something every frame, before the renderers encode. dt is seconds. */
  onFrame(fn) { this._onFrame.add(fn); return () => this._onFrame.delete(fn); }

  /**
   * One requestAnimationFrame for every view, and one submit.
   *
   * Each renderer encodes into the same command encoder, so a four-pane editor
   * costs one submit per frame rather than four.
   */
  start() {
    if (this._raf) return;
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min(0.1, (now - this._lastFrame) / 1000);   // clamp after a stall
      this._lastFrame = now;

      for (const fn of this._onFrame) fn(dt);

      const active = [...this.renderers].filter((r) => r.ready);
      if (!active.length) return;

      const enc = this.device.createCommandEncoder();
      for (const r of active) r.encode(enc);
      this.device.queue.submit([enc.finish()]);
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
    // not the files it borrowed from.
    this.imports = options.imports ?? {};
    this.path = options.path ?? '';
    this.nodeBuf = this.lightBuf = this.matBuf = null;

    // Bumped on any change that invalidates a bind group, so renderers can
    // notice without being subscribed.
    this.generation = 0;

    this.update(spec);
  }

  /**
   * Recompile and replace every buffer. compileScene throws before anything
   * here is touched, so a bad spec leaves the previous scene intact.
   */
  update(spec, options = {}) {
    if (options.imports) this.imports = options.imports;
    const built = compileScene(spec, { imports: this.imports, path: this.path });
    const { device } = this.context;

    for (const b of [this.nodeBuf, this.lightBuf, this.matBuf]) if (b) b.destroy();

    this.spec = spec;
    this.nodes = built.nodes;
    // provenance[i] names the authored object and path node i came from, or
    // is null for nodes the compiler invented. See antisphere-scene.js.
    this.provenance = built.provenance;
    this.materials = built.materials;
    this.lights = built.lights;
    this.camera = built.camera ?? null;
    // Members of groups that may overlap (compileScene).
    this.overlaps = built.overlaps;

    const nodeData = packNodes(built.nodes);
    const lightData = packLights(built.lights);
    const matData = packMaterials(built.materials);
    this.nodeBuf = uploadStorage(device, nodeData);
    this.lightBuf = uploadStorage(device, lightData);
    this.matBuf = uploadStorage(device, matData);
    this.bytes = nodeData.byteLength + lightData.byteLength + matData.byteLength;
    this.generation++;
  }

  /**
   * Replace the lights without recompiling anything.
   *
   * The light buffer is allocated at capacity and the live count travels in
   * the camera uniform, so this is a buffer write rather than a reallocation,
   * and no bind group is invalidated. Cheap enough to do per frame.
   */
  setLights(lights) {
    this.lights = lights;
    this.context.device.queue.writeBuffer(this.lightBuf, 0, packLights(lights));
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
      o: r.origin, tMin: r.tMin ?? 1e-3, d: r.direction, tMax: r.tMax ?? 1000,
    }));
    device.queue.writeBuffer(rq.rayBuf, 0, queries.buffer);

    const group = bindGroup(
      device,
      pipelines.traceFrom,
      BINDINGS['antisphere-raycast'],
      'traceFrom', {
        nodes: this.nodeBuf,
        materials: this.matBuf,
        rayQueries: rq.rayBuf,
        rayResults:
        rq.resultBuf,
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
   * Do these pairs of regions share any interior?
   *
   * Each pair is { a, b } node indices, with optional signs (+1 for a node's
   * inside, the default, -1 for its outside) and an optional frame
   * ({ c, L }: where to measure, as for overlap.js's regionsDisjoint). Resolves to a Float32Array of
   * margins, one per pair: above OVERLAP_TAU (1e-5, in the shader) means
   * proved apart, below -OVERLAP_TAU means they meet, and between is
   * touching. The shader stops as soon as it is sure, so a margin settles the
   * question rather than measuring how far apart. overlap.js does the same
   * thing on the CPU and documents the certificate behind it.
   *
   * Takes its turn with the ray queries, since both map a readback buffer.
   */
  overlapPairs(pairs) {
    const context = this.context;
    const run = () => this._overlap(pairs);
    const result = context._rayQueue.then(run, run);
    context._rayQueue = result.then(() => {}, () => {});
    return result;
  }

  async _overlap(pairs) {
    const { device, pipelines, _overlapQuery: buffers } = this.context;
    if (!pipelines || pairs.length === 0 || !this.nodeBuf) return new Float32Array(0);
    if (pairs.length > buffers.maxPairs) {
      throw new Error(`overlapPairs: ${pairs.length} pairs, capacity is ${buffers.maxPairs}`);
    }

    const queries = OverlapQuery.allocate(pairs.length);
    pairs.forEach((pair, i) => OverlapQuery.write(queries, i, {
      node_a: pair.a, node_b: pair.b, sign_a: pair.signA ?? 1, sign_b: pair.signB ?? 1,
      frame_centre: pair.frame?.c ?? [0, 0, 0], frame_length: pair.frame?.L ?? 0,
    }));
    device.queue.writeBuffer(buffers.queryBuf, 0, queries.buffer);

    const group = bindGroup(
      device,
      pipelines.overlapFrom,
      BINDINGS['overlap'],
      'overlapFrom', {
        nodes: this.nodeBuf,
        overlapQueries: buffers.queryBuf,
        overlapResults: buffers.resultBuf,
      }
    );

    const bytes = pairs.length * OverlapResult.STRIDE;
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipelines.overlapFrom);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(pairs.length / 64));
    pass.end();
    enc.copyBufferToBuffer(buffers.resultBuf, 0, buffers.readBuf, 0, bytes);
    device.queue.submit([enc.finish()]);

    await buffers.readBuf.mapAsync(GPUMapMode.READ, 0, bytes);
    const raw = buffers.readBuf.getMappedRange(0, bytes).slice(0);
    buffers.readBuf.unmap();

    const results = viewsOf(raw);
    const margins = new Float32Array(pairs.length);
    for (let i = 0; i < pairs.length; i++) margins[i] = OverlapResult.read(results, i).margin;
    return margins;
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

  destroy() {
    for (const b of [this.nodeBuf, this.lightBuf, this.matBuf]) if (b) b.destroy();
    this.nodeBuf = this.lightBuf = this.matBuf = null;
  }
}
