// One view.
//
// An ASRenderer owns a canvas, its render target, and a camera. Everything
// else it borrows: the device and pipelines from its ASContext, the geometry
// from an ASScene. Several renderers can share one scene, which is what an
// editor with multiple panes needs.
//
// It does not own a frame loop. ASContext.start() drives every renderer from
// one requestAnimationFrame and one submit.

import { configureCanvas, createCameraUniform } from './gpu-setup.js';
import { ASContext } from './as-context.js';
import { ASCamera } from './as-camera.js';

export const DEBUG_VIEWS = ['shaded', 'node visits', 'shadow rays', 'stack depth',
                            'material id', 'normals'];

export class ASRenderer {
  /**
   * @param {ASContext} context
   * @param {HTMLCanvasElement} canvas
   * @param {object} [opts]
   * @param {ASScene} [opts.scene]
   * @param {ASCamera} [opts.camera]       defaults to a fresh orbit camera
   * @param {number}  [opts.renderScale]   1 renders at canvas resolution
   * @param {boolean} [opts.shadows]
   * @param {number}  [opts.maxPixelRatio] caps devicePixelRatio
   */
  constructor(context, canvas, opts = {}) {
    this.context = context;
    this.canvas = canvas;
    this.camera = opts.camera ?? new ASCamera();
    this.scene = opts.scene ?? null;

    this.shadows = opts.shadows ?? true;
    this.debugView = 0;
    this.directOut = false;
    this.maxPixelRatio = opts.maxPixelRatio ?? 2;

    const { ctx, canDirect } = configureCanvas(
      canvas, context.device, context.canBgraStorage, context.format);
    this.ctx = ctx;
    this.canDirect = canDirect;

    this.cam = createCameraUniform(context.device);

    // Linear filtering lets the render target differ in size from the canvas;
    // the blit shader samples it scaled to fit.
    this.sampler = context.device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
    });

    this.tex = null;
    this.computeBG = null;
    this.blitBG = null;

    // Canvas size in device pixels, and the render target size, which is the
    // canvas scaled by renderScale.
    this.width = 0; this.height = 0;
    this.renderWidth = 0; this.renderHeight = 0;
    this._renderScale = opts.renderScale ?? 1;

    // Bind groups are stale whenever the pipelines, the scene, or the target
    // texture change. Tracking the two generations avoids rebuilding blindly.
    this._pipeGen = -1;
    this._sceneGen = -1;

    this.resize();
  }

  /** True once there is something to draw with. */
  get ready() {
    return !!(this.scene && this.context.pipelines && this.tex);
  }

  get renderScale() { return this._renderScale; }

  /**
   * Clamped to 1: the blit is a single bilinear tap rather than a box filter,
   * so rendering above canvas resolution buys no quality, just cost. Rounded
   * to a step boundary so repeated adjustments land on clean values instead of
   * drifting with float error.
   */
  setRenderScale(v) {
    this._renderScale = Math.max(0.1, Math.min(1, Math.round(v * 100) / 100));
    this._updateTarget();
    return this._renderScale;
  }

  setScene(scene) {
    this.scene = scene;
    this._sceneGen = -1;      // force a bind group rebuild
    return this;
  }

  /** Adopt the scene's declared viewpoint, if it has one. */
  useSceneCamera() {
    if (this.scene?.camera) this.camera.setFromSpec(this.scene.camera);
    return this;
  }

  setDebugView(i) {
    this.debugView = ((i % DEBUG_VIEWS.length) + DEBUG_VIEWS.length) % DEBUG_VIEWS.length;
    return DEBUG_VIEWS[this.debugView];
  }

  cycleDebugView() { return this.setDebugView(this.debugView + 1); }

  /** Write straight to the swap chain, skipping the blit. Ignores renderScale. */
  setDirectOut(on) {
    this.directOut = on && this.canDirect;
    return this.directOut;
  }

  /** Match the backing store to the canvas's CSS size, then the render target. */
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (w !== this.width || h !== this.height) {
      this.width = w; this.height = h;
      this.canvas.width = w; this.canvas.height = h;
    }
    this._updateTarget();
  }

  _updateTarget() {
    const w = Math.max(1, Math.round(this.width * this._renderScale));
    const h = Math.max(1, Math.round(this.height * this._renderScale));
    if (w === this.renderWidth && h === this.renderHeight) return;
    this.renderWidth = w; this.renderHeight = h;
    if (this.tex) this.tex.destroy();
    this.tex = this.context.device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._pipeGen = -1;       // the texture changed, so the bind groups did too
  }

  _refreshBindGroups() {
    const { device, pipelines } = this.context;
    if (!pipelines || !this.tex || !this.scene) return;
    if (this._pipeGen === this.context.generation &&
        this._sceneGen === this.scene.generation) return;

    this.computeBG = device.createBindGroup({
      layout: pipelines.compute.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cam.buffer } },
        { binding: 1, resource: { buffer: this.scene.nodeBuf } },
        { binding: 2, resource: this.tex.createView() },
        { binding: 3, resource: { buffer: this.scene.lightBuf } },
        { binding: 4, resource: { buffer: this.scene.matBuf } },
      ],
    });
    this.blitBG = device.createBindGroup({
      layout: pipelines.blit.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.tex.createView() },
        { binding: 1, resource: this.sampler },
      ],
    });
    this._pipeGen = this.context.generation;
    this._sceneGen = this.scene.generation;
  }

  // The swap chain hands back a different texture every frame, so the direct
  // path cannot cache its bind group.
  _directBindGroup(view) {
    return this.context.device.createBindGroup({
      layout: this.context.pipelines.computeDirect.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cam.buffer } },
        { binding: 1, resource: { buffer: this.scene.nodeBuf } },
        { binding: 2, resource: view },
        { binding: 3, resource: { buffer: this.scene.lightBuf } },
        { binding: 4, resource: { buffer: this.scene.matBuf } },
      ],
    });
  }

  /**
   * Pack the camera uniform.
   *
   * `overrides` lets a profiler drive the shadow flag and ablation level
   * without the renderer knowing what an ablation ladder is.
   */
  writeCamera(overrides = {}) {
    const { eye, forward, right, up } = this.camera.basis();
    const { floats, enums, buffer, host } = this.cam;
    const aspect = this.directOut
      ? this.width / this.height
      : this.renderWidth / this.renderHeight;

    floats.set(eye, 0);       floats[3] = Math.tan(0.5 * this.camera.fovY);
    floats.set(right, 4);     floats[7] = aspect;
    floats.set(up, 8);        enums[11] = (overrides.shadows ?? (this.shadows ? 1 : 0));
    floats.set(forward, 12);  enums[15] = overrides.debugView ?? this.debugView;
    enums[16] = overrides.ablate ?? 2;                      // 2 = full shading path
    enums[17] = this.scene ? this.scene.lights.length : 0;
    this.context.device.queue.writeBuffer(buffer, 0, host);
  }

  /**
   * Encode this view's passes into a shared command encoder.
   *
   * `timestampWrites` is optional and passed straight through, so a profiler
   * can measure one chosen view without this class owning a query set.
   */
  encode(enc, opts = {}) {
    this.resize();
    this._refreshBindGroups();
    if (!this.ready || !this.computeBG) return false;
    this.writeCamera(opts.camera);

    const { pipelines } = this.context;
    const computeTiming = opts.computeTimestamps ?? undefined;

    if (this.directOut) {
      const view = this.ctx.getCurrentTexture().createView();
      const pass = enc.beginComputePass(
        computeTiming ? { timestampWrites: computeTiming } : {});
      pass.setPipeline(pipelines.computeDirect);
      pass.setBindGroup(0, this._directBindGroup(view));
      pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
      pass.end();
      return true;
    }

    const pass = enc.beginComputePass(
      computeTiming ? { timestampWrites: computeTiming } : {});
    pass.setPipeline(pipelines.compute);
    pass.setBindGroup(0, this.computeBG);
    pass.dispatchWorkgroups(Math.ceil(this.renderWidth / 8),
                            Math.ceil(this.renderHeight / 8));
    pass.end();

    const rpass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.ctx.getCurrentTexture().createView(),
        loadOp: 'clear', storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
      ...(opts.blitTimestamps ? { timestampWrites: opts.blitTimestamps } : {}),
    });
    rpass.setPipeline(pipelines.blit);
    rpass.setBindGroup(0, this.blitBG);
    rpass.draw(3);
    rpass.end();
    return true;
  }

  /** Rays actually cast this frame, for a profiler readout. */
  get pixelCount() {
    return this.directOut
      ? this.width * this.height
      : this.renderWidth * this.renderHeight;
  }

  destroy() {
    this.context._forget(this);
    if (this.tex) this.tex.destroy();
    this.tex = null;
    this.cam.buffer.destroy();
    this.ctx.unconfigure();
  }
}

// Let ASContext.createRenderer() reach this class without an import cycle.
ASContext._rendererModule = { ASRenderer };
