// Bindings: numbered by the build, so shaders and JS both use names.
//
// A resource - a module-scope var<uniform>, var<storage, ...>, texture or
// sampler - is written in a .wgsls file with no @group or @binding:
//
//   var<storage, read> nodes : array<Node>;
//
// and the build gives each, in declaration order, @group(0) @binding(k),
// numbered per output. #import is a plain include, so numbers written by
// hand had to agree across every file an output pulls in; names can't
// clash that way, and JS binds by name (public/bind-group.js), never by
// number. A hand-written @group or @binding is an error: one way to do it.
//
// Every pipeline uses layout: 'auto', whose bind group layout holds exactly
// the resources its entry points statically use, and a bind group must
// supply exactly those. WebGPU can't be asked which they are, so this works
// them out: from each entry point, every function it calls, transitively,
// and the resources their bodies name. WGSL has no function pointers, so
// that is exact, but for a local (or parameter) that shadows a resource's
// name, which over-reports; public/gpu.test.mjs checks every entry point's
// list against the compiler's.
//
// The attributes go on the declaration's own line, so lines keep their
// numbers and the source map still holds.

import { tokenize } from './layout.js';

/** A problem in the linked source, at an output line (map it to a file with public/shader-map.js). */
export class BindingError extends Error {
  constructor(line, message) {
    super(message);
    this.line = line;
  }
}

const STAGES = new Set(['compute', 'vertex', 'fragment']);

/** Texture and sampler types: resources with no address space. */
const isHandleType = (name) => name.startsWith('texture_') || name === 'sampler' || name === 'sampler_comparison';

/**
 * The module-scope declarations bindings depend on.
 * { resources: [{ name, at, line }], functions: Map<name, { stage, uses: Set<identifier> }> }
 * where `at` is the offset of the resource's `var`, and `uses` is every
 * identifier a function's body names, other than after a '.'.
 */
function scan(code) {
  const tokens = tokenize(code);
  const resources = [];
  const functions = new Map();
  let attrs = [];                               // attributes since the last declaration
  let i = 0;

  // Skip a balanced group, having just seen its opener.
  const skip = (open, close) => {
    for (let depth = 1; depth && i < tokens.length; i++) {
      if (tokens[i].t === open) depth++;
      else if (tokens[i].t === close) depth--;
    }
  };

  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.t === '@') {
      const name = tokens[i + 1]?.t;
      if (name === 'group' || name === 'binding') {
        throw new BindingError(tok.line, `@${name}: resources are written without @group or @binding; ` +
                                         'the shader build numbers them (see tools/shader-build/bindings.js)');
      }
      attrs.push(name);
      i += 2;
      if (tokens[i]?.t === '(') { i++; skip('(', ')'); }
      continue;
    }
    if (tok.t === 'var') {
      let j = i + 1, space = null;
      if (tokens[j]?.t === '<') {
        space = tokens[j + 1]?.t;
        while (j < tokens.length && tokens[j].t !== '>') j++;
        j++;
      }
      const name = tokens[j]?.t;
      const type = tokens[j + 2]?.t;           // past the ':'
      if (space === 'uniform' || space === 'storage' || (space === null && isHandleType(type ?? ''))) {
        resources.push({ name, at: tok.at, line: tok.line });
      }
      while (i < tokens.length && tokens[i].t !== ';') i++;
      i++;
      attrs = [];
      continue;
    }
    if (tok.t === 'fn') {
      const name = tokens[i + 1].t;
      const stage = attrs.find((a) => STAGES.has(a)) ?? null;
      while (i < tokens.length && tokens[i].t !== '{') i++;
      i++;
      const uses = new Set();
      for (let depth = 1; depth && i < tokens.length; i++) {
        const t = tokens[i].t;
        if (t === '{') depth++;
        else if (t === '}') depth--;
        else if (/^[A-Za-z_]/.test(t) && tokens[i - 1].t !== '.') uses.add(t);
      }
      functions.set(name, { stage, uses });
      attrs = [];
      continue;
    }
    if (tok.t === '{') { i++; skip('{', '}'); attrs = []; continue; }
    if (tok.t === ';') attrs = [];
    i++;
  }
  return { resources, functions };
}

/**
 * Number a linked source's resources.
 * @returns {{ code: string, slots: Record<string, number>, entries: Record<string, string[]> }}
 *   code with the attributes in; slots, each resource's binding; entries,
 *   for each entry point the resources it uses, in slot order.
 */
export function assignBindings(code) {
  const { resources, functions } = scan(code);
  const slots = {};
  resources.forEach((r, k) => {
    if (r.name in slots) throw new BindingError(r.line, `a second resource named ${r.name}`);
    slots[r.name] = k;
  });

  let out = code;
  for (let k = resources.length - 1; k >= 0; k--) {
    const { at } = resources[k];
    out = `${out.slice(0, at)}@group(0) @binding(${k}) ${out.slice(at)}`;
  }

  const reached = new Map();                    // function -> the resources it reaches
  const reach = (name, seen) => {
    if (reached.has(name)) return reached.get(name);
    const found = new Set();
    if (seen.has(name)) return found;           // WGSL forbids recursion; don't loop on it
    seen.add(name);
    for (const id of functions.get(name).uses) {
      if (id in slots) found.add(id);
      else if (functions.has(id) && id !== name) for (const r of reach(id, seen)) found.add(r);
    }
    reached.set(name, found);
    return found;
  };
  const entries = {};
  for (const [name, f] of functions) {
    if (f.stage) entries[name] = [...reach(name, new Set())].sort((a, b) => slots[a] - slots[b]);
  }
  return { code: out, slots, entries };
}
