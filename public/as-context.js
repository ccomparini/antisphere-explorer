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
  compileScene, packNodes, packMaterials, packLights,
} from './antisphere-scene.js';

const MAX_TRACE_RAYS = 16;
const MAX_OVERLAP_PAIRS = 1024;

// One ray query's result, as traceFrom() writes it: the Seg that the
// shader's trace() returns.
//   u32 node   the node whose region the ray entered, or 0 for a miss
//   f32 t0     how far along the ray it entered
//   f32 t1     where the segment it was found in ends (not a thickness)
// node == 0 is the only miss test; t0 and t1 are meaningless for a miss.
// createTraceBuffers() sizes its result buffers with this, so the shader
// struct, the buffer size and the readback below all have to agree.
export const RAY_HIT_BYTES = 12;

export class ASContext {
  /**
   * Acquire a device and build pipelines from the given shader files.
   *
   * @param {object} [opts]
   * @param {string} [opts.computeUrl]  path to the raycast shader
   * @param {string} [opts.blitUrl]     path to the blit shader
   */
  static async create(opts = {}) {
    const computeUrl = opts.computeUrl ?? 'antisphere-raycast.wgsl';
    const blitUrl = opts.blitUrl ?? 'blit.wgsl';

    const { adapter, device, canTimestamp, canBgraStorage } = await requestGPU();
    const ctx = new ASContext(adapter, device, { canTimestamp, canBgraStorage });
    ctx._sources = { computeUrl, blitUrl };

    const [computeSrc, blitSrc] = await Promise.all([loadText(computeUrl), loadText(blitUrl)]);
    const err = await ctx._build(computeSrc, blitSrc);
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

    this._live = { compute: null, blit: null };
    this._rayQuery = createTraceBuffers(device, MAX_TRACE_RAYS, RAY_HIT_BYTES);
    this._overlapQuery = createOverlapBuffers(device, MAX_OVERLAP_PAIRS);
    // Ray queries share one set of buffers, so they take turns: a pick
    // arriving while walk mode's ground probe is still mapped would
    // otherwise fail with the read buffer already in use.
    this._rayQueue = Promise.resolve();
    this._raf = 0;
    this._lastFrame = performance.now();
    this._onFrame = new Set();
  }

  async _build(computeSrc, blitSrc) {
    const { error, pipelines } = await buildPipelines(
      this.device, this.format, computeSrc, blitSrc);
    if (error) return error;
    this.pipelines = pipelines;
    this._live = { compute: computeSrc, blit: blitSrc };
    this.generation++;
    return null;
  }

  /**
   * Refetch the shader files and rebuild. Returns null on success, or a
   * message. The previous pipelines keep rendering if the new ones fail, so a
   * bad edit shows an error rather than a black screen.
   */
  async reloadShaders({ force = false } = {}) {
    const [computeSrc, blitSrc] = await Promise.all([
      loadText(this._sources.computeUrl), loadText(this._sources.blitUrl),
    ]);
    if (!force && computeSrc === this._live.compute && blitSrc === this._live.blit) {
      return { changed: false, error: null };
    }
    const error = await this._build(computeSrc, blitSrc);
    return { changed: true, error };
  }

  /** Compile a scene spec into GPU buffers that any renderer here can use. */
  createScene(spec) {
    return new ASScene(this, spec);
  }

  /** Fetch and compile a scene file. */
  async loadScene(url) {
    return this.createScene(JSON.parse(await loadText(url)));
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
  constructor(context, spec) {
    this.context = context;
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
  update(spec) {
    const built = compileScene(spec);
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
   * parallel arrays with one entry per ray. node is 0 where a ray missed,
   * and t0 and t1 are then meaningless; see RAY_HIT_BYTES.
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

    const packed = new Float32Array(rays.length * 8);
    rays.forEach((r, i) => {
      const o = i * 8;
      packed.set(r.origin, o);
      packed[o + 3] = r.tMin ?? 1e-3;
      packed.set(r.direction, o + 4);
      packed[o + 7] = r.tMax ?? 1000;
    });
    device.queue.writeBuffer(rq.rayBuf, 0, packed);

    const bindGroup = device.createBindGroup({
      layout: pipelines.traceFrom.getBindGroupLayout(0),
      entries: [
        { binding: 1, resource: { buffer: this.nodeBuf } },
        { binding: 4, resource: { buffer: this.matBuf } },
        { binding: 5, resource: { buffer: rq.rayBuf } },
        { binding: 6, resource: { buffer: rq.resultBuf } },
      ],
    });

    const bytes = rays.length * RAY_HIT_BYTES;
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipelines.traceFrom);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(rq.resultBuf, 0, rq.readBuf, 0, bytes);
    device.queue.submit([enc.finish()]);

    await rq.readBuf.mapAsync(GPUMapMode.READ, 0, bytes);
    const raw = rq.readBuf.getMappedRange(0, bytes).slice(0);
    rq.readBuf.unmap();

    const words = new Uint32Array(raw), floats = new Float32Array(raw);
    const n = rays.length;
    const node = new Uint32Array(n), t0 = new Float32Array(n), t1 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      node[i] = words[i * 3];
      t0[i] = floats[i * 3 + 1];
      t1[i] = floats[i * 3 + 2];
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
   * inside, the default, -1 for its outside). Resolves to a Float32Array of
   * margins, one per pair: positive means proved apart, around zero means
   * touching, negative means they meet. overlap.js does the same thing on the
   * CPU and documents the certificate behind it.
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

    const packed = new ArrayBuffer(pairs.length * 16);
    const words = new Uint32Array(packed), floats = new Float32Array(packed);
    pairs.forEach((pair, i) => {
      words[i * 4 + 0] = pair.a;
      words[i * 4 + 1] = pair.b;
      floats[i * 4 + 2] = pair.signA ?? 1;
      floats[i * 4 + 3] = pair.signB ?? 1;
    });
    device.queue.writeBuffer(buffers.queryBuf, 0, packed);

    const bindGroup = device.createBindGroup({
      layout: pipelines.overlapFrom.getBindGroupLayout(0),
      entries: [
        { binding: 1, resource: { buffer: this.nodeBuf } },
        { binding: 7, resource: { buffer: buffers.queryBuf } },
        { binding: 8, resource: { buffer: buffers.resultBuf } },
      ],
    });

    const bytes = pairs.length * 8;
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipelines.overlapFrom);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(pairs.length / 64));
    pass.end();
    enc.copyBufferToBuffer(buffers.resultBuf, 0, buffers.readBuf, 0, bytes);
    device.queue.submit([enc.finish()]);

    await buffers.readBuf.mapAsync(GPUMapMode.READ, 0, bytes);
    const raw = buffers.readBuf.getMappedRange(0, bytes).slice(0);
    buffers.readBuf.unmap();

    const all = new Float32Array(raw);
    const margins = new Float32Array(pairs.length);
    for (let i = 0; i < pairs.length; i++) margins[i] = all[i * 2];
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
