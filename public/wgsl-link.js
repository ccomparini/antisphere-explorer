// Minimal WESL-syntax resolver for WGSL.
//
// WGSL has no import mechanism, so composition is string concatenation. The
// only genuinely hard part is keeping compile errors legible: the driver
// reports line numbers in the concatenated result, and without a map back to
// the original file those numbers are worse than useless.
//
// The import syntax here is WESL's (wesl-lang.dev), so that moving to a real
// WESL linker later is a change of toolchain rather than a change of source:
//
//   import package::mat::lambert::*;      rooted at the package
//   import super::prelude::*;             relative to the parent module
//   import package::mat::{lambert::*, glossy::*};
//
// A module path maps to a file by joining segments with '/' and appending
// '.wgsl', so package::mat::lambert is mat/lambert.wgsl. Generated code needs
// no special directive: hand `load` a virtual path and it is just a module.
//
// WHERE THIS DIFFERS FROM REAL WESL, and it matters:
//
//   Real WESL imports are namespaced. `import package::mat::lambert;` binds a
//   module, and you then call lambert::shadeLambert(). This resolver instead
//   concatenates whole files into one flat global namespace, which is what
//   `::*` means in WESL. So write the wildcard form: call sites then look the
//   same under either implementation. A trailing `::*` is accepted and
//   ignored here, because inclusion is always wildcard.
//
//   Consequently an import path must name a module (a file), never an
//   individual item. `import package::prelude::Surf;` would be read as the
//   module prelude/Surf and fail to load.
//
// Also not done: symbol mangling, dead code elimination, conditional
// compilation, aliases, or library packages. Two modules defining the same
// name collide silently. WESL handles all of it and is a strict superset.

const MODULE_EXT = '.wgsl';

const dirSegments = (path) => {
  const segs = path.replace(/\.wgsl$/, '').split('/');
  segs.pop();
  return segs;
};

// Split on commas that are not inside braces.
function splitTop(s) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Turn one module path into a file path, relative to the importing file. */
export function modulePath(spec, from) {
  const segs = spec.split('::').map((x) => x.trim()).filter(Boolean);
  if (segs[segs.length - 1] === '*') segs.pop();      // inclusion is always wildcard
  if (!segs.length) throw new Error(`${from}: empty import path`);

  let base;
  if (segs[0] === 'package') {
    segs.shift();
    base = [];
  } else if (segs[0] === 'super') {
    // The first `super` names the parent module, which is this file's
    // directory. Each further `super` climbs one more level.
    base = dirSegments(from);
    segs.shift();
    while (segs[0] === 'super') { segs.shift(); base.pop(); }
  } else {
    base = dirSegments(from);                          // sibling module
  }
  if (!segs.length) throw new Error(`${from}: import path names no module`);
  return [...base, ...segs].join('/') + MODULE_EXT;
}

// Expand one import statement into the module files it pulls in.
function expandImport(stmt, from) {
  const s = stmt.replace(/^import\s+/, '').replace(/;\s*$/, '').trim();
  if (/\bas\b/.test(s)) throw new Error(`${from}: import aliases are not supported`);
  return expandPath(s, from);
}

function expandPath(s, from) {
  const brace = s.indexOf('{');
  if (brace < 0) return [modulePath(s, from)];
  const prefix = s.slice(0, brace).replace(/::\s*$/, '').trim();
  const inner = s.slice(brace + 1, s.lastIndexOf('}'));
  return splitTop(inner).flatMap((part) =>
    expandPath(prefix ? `${prefix}::${part}` : part, from));
}

// Imports sit at the top of a WESL file. Statements may span lines, so read
// until each semicolon. Consumed lines are blanked rather than removed, which
// keeps every other line at its original number.
function readImports(text, path) {
  const lines = text.split('\n');
  const modules = [];
  let buf = '', i = 0;
  while (i < lines.length) {
    const stripped = lines[i].replace(/\/\/.*$/, '').trim();
    if (buf === '') {
      if (stripped === '') { i++; continue; }
      if (!/^import\b/.test(stripped)) break;
    }
    buf += ' ' + stripped;
    lines[i] = '';
    i++;
    if (buf.includes(';')) {
      modules.push(...expandImport(buf.trim(), path));
      buf = '';
    }
  }
  if (buf !== '') throw new Error(`${path}: unterminated import statement`);
  return { modules, body: lines };
}

/**
 * Link a module and everything it imports.
 *
 * @param {string} entry  file path of the root module
 * @param {(path:string)=>Promise<string>} load  fetches a module's source.
 *        Generated code is supplied by returning it for a virtual path.
 * @returns {Promise<{code:string, map:Array, files:string[]}>}
 */
export async function link(entry, load) {
  const state = new Map();      // path -> 'pending' | 'done'
  const lines = [];
  const map = [];               // { path, offset, lines }, in emission order
  const files = [];

  async function include(path, importedBy) {
    if (state.get(path) === 'done') return;
    if (state.get(path) === 'pending') {
      throw new Error(`import cycle at ${path}` +
                      (importedBy ? `, imported by ${importedBy}` : ''));
    }
    state.set(path, 'pending');

    let text;
    try {
      text = await load(path);
    } catch (e) {
      throw new Error(`cannot load ${path}` +
                      (importedBy ? ` (imported by ${importedBy})` : '') +
                      `: ${e.message}`);
    }

    const { modules, body } = readImports(text, path);

    // Dependencies first: WGSL has no forward declaration, so every
    // declaration must precede its use.
    for (const m of modules) await include(m, path);

    map.push({ path, offset: lines.length, lines: body.length });
    lines.push(...body);

    state.set(path, 'done');
    files.push(path);
  }

  await include(entry, null);
  return { code: lines.join('\n'), map, files };
}

/** Translate a line in the linked output back to its source module. */
export function mapLine(map, line) {
  for (const b of map) {
    if (line > b.offset && line <= b.offset + b.lines) {
      return { path: b.path, line: line - b.offset };
    }
  }
  return { path: '<linked output>', line };
}

/**
 * Format GPUCompilationInfo messages against a source map.
 * @returns {{errors:number, text:string}}
 */
export function formatDiagnostics(info, map) {
  let errors = 0;
  const out = [];
  for (const msg of info.messages) {
    if (msg.type === 'error') errors++;
    const at = mapLine(map, msg.lineNum);
    out.push(`${msg.type}: ${at.path}:${at.line}:${msg.linePos}: ${msg.message}`);
  }
  return { errors, text: out.join('\n') };
}
