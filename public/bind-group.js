// Bind groups by name.
//
// The shader build numbers each shader's resources, and works out which of
// them each entry point uses (tools/shader-build/bindings.js); BINDINGS in
// gen/layouts.js says so. Every pipeline here is made with layout: 'auto',
// whose layout holds exactly what its entry points use, and a bind group
// must supply exactly that: so this takes those names, and only those, from
// whatever table of resources the caller has.

/**
 * A bind group for group 0 of `pipeline`.
 *
 * @param {GPUDevice} device
 * @param {GPUPipelineBase} pipeline  made with layout: 'auto'
 * @param {object} shader  its shader's entry in BINDINGS, e.g. BINDINGS['physics-2pt']
 * @param {string | string[]} entryPoints  the pipeline's: one for compute,
 *        both stages' for a render pipeline (its layout is their union)
 * @param {Record<string, GPUBuffer | GPUBindingResource>} resources  by
 *        name; a buffer is bound whole. Names the entry points don't use
 *        are left out.
 * @param {string} [label]
 */
export function bindGroup(device, pipeline, shader, entryPoints, resources, label) {
  const names = new Set();
  for (const entry of [entryPoints].flat()) {
    const uses = shader.entries[entry];
    if (!uses) throw new Error(`bindGroup: no entry point ${entry}`);
    for (const name of uses) names.add(name);
  }
  const missing = [...names].filter((name) => resources[name] === undefined);
  if (missing.length) {
    throw new Error(`bindGroup: ${[entryPoints].flat().join(' + ')} needs ${missing.join(', ')}`);
  }
  return device.createBindGroup({
    label,
    layout: pipeline.getBindGroupLayout(0),
    entries: [...names].map((name) => {
      const r = resources[name];
      // A GPUBuffer is the one resource that has to be wrapped.
      return { binding: shader.slots[name], resource: typeof r.mapAsync === 'function' ? { buffer: r } : r };
    }),
  });
}
