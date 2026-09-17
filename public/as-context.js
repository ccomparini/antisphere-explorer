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
  createTraceBuffers,
} from './gpu-setup.js';
import {
  compileScene, packNodes, packMaterials, packLights,
} from './antisphere-scene.js';

const MAX_TRACE_RAYS = 16;

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
    this._rayQuery = createTraceBuffers(device, MAX_TRACE_RAYS);
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
   * Cast rays on the GPU and read the hit distances back.
   *
   * Uses traceFrom(), a second entry point in the raycast shader that shares
   * trace() with the renderer, so a caller costs more rays in a batch rather
   * than new shader code. Resolves to a Float32Array of distances, negative
   * where the ray missed.
   *
   * The round trip is a frame or two, so this is for queries whose answer can
   * lag — ground height, collision probes — not for anything synchronous.
   */
  async traceRays(rays) {
    const { device, pipelines, _rayQuery: rq } = this.context;
    if (!pipelines || rays.length === 0) return new Float32Array(0);
    if (rays.length > rq.maxRays) {
      throw new Error(`traceRays: ${rays.length} rays, capacity is ${rq.maxRays}`);
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

    const bytes = rays.length * 4;
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipelines.traceFrom);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(rq.resultBuf, 0, rq.readBuf, 0, bytes);
    device.queue.submit([enc.finish()]);

    await rq.readBuf.mapAsync(GPUMapMode.READ, 0, bytes);
    const out = new Float32Array(rq.readBuf.getMappedRange(0, bytes).slice(0));
    rq.readBuf.unmap();
    return out;
  }

  /** One ray, for callers that want a scalar. Negative means no hit. */
  async traceRay(origin, direction, opts = {}) {
    const [t] = await this.traceRays([{ origin, direction, ...opts }]);
    return t ?? -1;
  }

  destroy() {
    for (const b of [this.nodeBuf, this.lightBuf, this.matBuf]) if (b) b.destroy();
    this.nodeBuf = this.lightBuf = this.matBuf = null;
  }
}
