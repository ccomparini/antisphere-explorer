// WebGPU plumbing.
//
// Everything between "the page loaded" and "there are pipelines and buffers
// to render with". Kept out of the renderer so that the main file is about
// frames rather than about device initialisation.
//
// Functions here throw on failure with a message fit to show the user; the
// caller decides what to do about it. Nothing here touches renderer state.

import { readSourceMap, mapLine } from './shader-map.js';
import { Camera, Ray, Seg } from './gen/layouts.js';

/** Fetch a file's text, bypassing the cache so hot reload sees edits. */
export async function loadText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.text();
}

/**
 * Adapter, device, and the optional features this renderer can use.
 *
 * `timestamp-query` drives the profiler; `bgra8unorm-storage` decides whether
 * the compute shader can write the swap chain directly on platforms that
 * prefer BGRA. Both are requested when available and simply absent otherwise.
 */
export async function requestGPU() {
  if (!navigator.gpu) {
    throw new Error('This page needs WebGPU. Try Chrome or Edge 113+, or Safari 18+.');
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No suitable GPU adapter found.');

  const canTimestamp = adapter.features.has('timestamp-query');
  const canBgraStorage = adapter.features.has('bgra8unorm-storage');
  const device = await adapter.requestDevice({
    requiredFeatures: [
      ...(canTimestamp ? ['timestamp-query'] : []),
      ...(canBgraStorage ? ['bgra8unorm-storage'] : []),
    ],
  });
  device.addEventListener('uncapturederror', (e) => console.error(e.error));

  return { adapter, device, canTimestamp, canBgraStorage };
}

/**
 * Configure the canvas context, preferring a format the compute shader can
 * write to directly.
 *
 * bgra8unorm is preferred on Windows and macOS but only supports storage
 * behind an optional feature, so fall back to rgba8unorm, which always does.
 * If storage usage is refused outright, `canDirect` comes back false and the
 * caller is limited to the blit path.
 */
export function chooseCanvasFormat(canBgraStorage) {
  const preferred = navigator.gpu.getPreferredCanvasFormat();
  return (preferred === 'bgra8unorm' && !canBgraStorage) ? 'rgba8unorm' : preferred;
}

export function configureCanvas(canvas, device, canBgraStorage,
                                format = chooseCanvasFormat(canBgraStorage)) {
  const ctx = canvas.getContext('webgpu');
  try {
    ctx.configure({
      device, format, alphaMode: 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING,
    });
    return { ctx, format, canDirect: true };
  } catch (e) {
    console.warn('canvas storage binding unavailable, blit only:', e.message);
    ctx.configure({ device, format, alphaMode: 'opaque' });
    return { ctx, format, canDirect: false };
  }
}

/**
 * Report a shader module's compilation messages.
 *
 * A shader that fails to compile leaves the pipeline invalid, and an invalid
 * pipeline makes the whole submit fail: black frames, no exception. Returns
 * false on error so the caller can keep the previous pipelines rendering.
 *
 * `code` is the module's source: a shader built from shaders/ carries a
 * source map (see shader-map.js), and then messages name the file and line
 * under shaders/ rather than the generated one.
 */
export async function checkShader(mod, label, code = '') {
  const info = await mod.getCompilationInfo();
  const map = readSourceMap(code);
  let failed = false;
  for (const msg of info.messages) {
    const at = mapLine(map, msg.lineNum);
    const where = at
      ? `${label} ${at.path}:${at.line}:${msg.linePos}`
      : `${label} line ${msg.lineNum}:${msg.linePos}`;
    if (msg.type === 'error') { failed = true; console.error(where, msg.message); }
    else console.warn(where, msg.message);
  }
  return !failed;
}

/**
 * Build every pipeline from source: `sources` is { compute, blit },
 * each a shader's text.
 *
 * Returns `{ error }` with a message, or `{ pipelines }` with all of them.
 * The caller only swaps them in on success, so a bad edit leaves the
 * previous frame rendering rather than blacking the screen.
 */
export async function buildPipelines(device, format, sources) {
  const { compute: computeSrc, blit: blitSrc } = sources;
  // The storage format is a literal in the WGSL type, so the direct-to-canvas
  // variant needs its own module when the canvas is not rgba8unorm.
  const directSrc = computeSrc.replace('texture_storage_2d<rgba8unorm',
                                       `texture_storage_2d<${format}`);
  const sameSrc = directSrc === computeSrc;

  const computeMod = device.createShaderModule({ code: computeSrc });
  const directMod = sameSrc ? computeMod : device.createShaderModule({ code: directSrc });
  const blitMod = device.createShaderModule({ code: blitSrc });

  // The direct variant only swaps a format name within one line, so the
  // compute shader's source map fits it too.
  const ok = await Promise.all([
    checkShader(computeMod, 'compute shader', computeSrc),
    sameSrc ? true : checkShader(directMod, 'compute shader (direct)', directSrc),
    checkShader(blitMod, 'blit shader', blitSrc),
  ]);
  if (!ok.every(Boolean)) return { error: 'shader failed to compile' };

  device.pushErrorScope('validation');
  const compute = device.createComputePipeline({
    layout: 'auto',
    compute: { module: computeMod, entryPoint: 'main' },
  });
  const computeDirect = sameSrc ? compute : device.createComputePipeline({
    layout: 'auto',
    compute: { module: directMod, entryPoint: 'main' },
  });
  const blit = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: blitMod, entryPoint: 'vs' },
    fragment: { module: blitMod, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  // Same module as the compute pipeline: traceFrom() is just another entry
  // point in antisphere-raycast.wgsls, sharing trace() with main().
  const traceFrom = device.createComputePipeline({
    layout: 'auto',
    compute: { module: computeMod, entryPoint: 'traceFrom' },
  });
  const err = await device.popErrorScope();
  if (err) {
    console.error(err.message);
    return { error: 'pipeline validation failed' };
  }

  return { pipelines: { compute, computeDirect, blit, traceFrom } };
}

/** A STORAGE | COPY_DST buffer holding `data`. */
export function uploadStorage(device, data) {
  const buf = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buf, 0, data);
  return buf;
}

/**
 * Query set plus the two buffers a timestamp readback needs: one to resolve
 * into, one that can be mapped. Returns null when the feature is absent, so
 * the caller can treat "no profiler" as one condition.
 */
export function createTimestampQuery(device, canTimestamp, count) {
  if (!canTimestamp) return null;
  return {
    count,
    querySet: device.createQuerySet({ type: 'timestamp', count }),
    resolveBuf: device.createBuffer({
      size: count * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    }),
    readBuf: device.createBuffer({
      size: count * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }),
  };
}

/**
 * Buffers for traceFrom(), the compute shader's batch ray-query entry point.
 *
 * Sized for a handful of rays; today only walk mode's single ground probe
 * uses it, but the point of doing this on the GPU rather than in JS is that a
 * second caller (collision probes, say) costs no new shader code, just more
 * rays in the batch.
 */
export function createTraceBuffers(device, maxRays) {
  return {
    maxRays,
    rayBuf: device.createBuffer({
      size: maxRays * Ray.STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }),
    resultBuf: device.createBuffer({
      size: maxRays * Seg.STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    }),
    readBuf: device.createBuffer({
      size: maxRays * Seg.STRIDE,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }),
  };
}

/**
 * The camera uniform, plus host-side views to fill it through the generated
 * Camera class (see Camera in shaders/antisphere-raycast.wgsls). The class
 * writes each field through the view of its own type, so a u32 mode
 * selector can't go through the float view by mistake.
 */
export function createCameraUniform(device) {
  return {
    buffer: device.createBuffer({
      size: Camera.SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
    views: Camera.allocate(1),
  };
}
