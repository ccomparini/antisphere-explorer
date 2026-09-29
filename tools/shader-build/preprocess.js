// The preprocessor: our few extensions to WGSL, resolved into plain WGSL.
//
// Directives are whole lines whose first non-blank character is '#'. WGSL
// has no '#' in its syntax, so no directive can be mistaken for WGSL or
// collide with a later version of it.
//
//   #import "path.wgsls"  another file, relative to this one. Included once
//                         however many files import it, and placed before
//                         the first file that does: WGSL has no forward
//                         declarations, so a definition must come first.
//   #if EXPR / #elif EXPR / #else / #endif
//                         conditional lines, nestable. EXPR is names,
//                         numbers, !, &&, || and parentheses; a name is true
//                         when the build's defines give it a truthy value,
//                         and false when they don't mention it.
//   #error "message"      fail the build, for combinations that shouldn't be.
//   #warning "message"    say something but carry on, for ones that are
//                         allowed but worth a second look. Goes to the
//                         build's warn callback, console.warn by default.
//
// Every directive line, and every line of a branch not taken, becomes an
// empty line rather than disappearing. So each file's lines keep their
// numbers, the file lands in the output as one contiguous block, and a
// compile error's line maps back to the source by one subtraction (see
// public/shader-map.js).
//
// One limit: a '#' at the start of a line inside a /* */ comment is still
// read as a directive. Write such comments with a leading '*' or '//'.

/** A problem at a known place: the message reads "path:line: what". */
export class ShaderSourceError extends Error {
  constructor(path, line, message) {
    super(`${path}:${line}: ${message}`);
    this.path = path;
    this.line = line;
  }
}

/** `path` resolved against the directory of `from`, both '/'-separated. */
export function resolvePath(from, path) {
  const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  const out = [];
  for (const part of (path.startsWith('/') ? path.slice(1) : base + path).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!out.length) throw new Error(`${path} climbs out of the tree it was imported from`);
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.join('/');
}

// -- #if expressions ------------------------------------------------------------

/** Evaluate a condition against the defines. Throws a plain Error on bad syntax. */
export function evaluate(expr, defines) {
  const tokens = expr.match(/\s*(\|\||&&|!|\(|\)|[A-Za-z_]\w*|\d+|\S)/g)?.map((t) => t.trim()) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  const primary = () => {
    const t = next();
    if (t === undefined) throw new Error('expression ends too soon');
    if (t === '!') return !primary();
    if (t === '(') {
      const v = or();
      if (next() !== ')') throw new Error('missing )');
      return v;
    }
    if (/^\d+$/.test(t)) return Number(t) !== 0;
    if (/^[A-Za-z_]\w*$/.test(t)) return !!defines[t];
    throw new Error(`unexpected "${t}"`);
  };
  const and = () => {
    let v = primary();
    while (peek() === '&&') { next(); v = primary() && v; }
    return v;
  };
  const or = () => {
    let v = and();
    while (peek() === '||') { next(); v = and() || v; }
    return v;
  };

  if (!tokens.length) throw new Error('empty condition');
  const v = or();
  if (i < tokens.length) throw new Error(`unexpected "${tokens[i]}"`);
  return v;
}

// -- one file -----------------------------------------------------------------------

/**
 * Apply one file's directives. Returns its lines, with directives and dead
 * branches blanked, and the imports its live lines ask for, in order.
 * `warn` gets each live #warning as "path:line: #warning message".
 */
export function processFile(path, text, defines, warn = console.warn) {
  const lines = text.split('\n');
  const imports = [];
  // One frame per open #if: whether its enclosing region is live, whether a
  // branch has been taken yet, whether the current branch is live, where it
  // opened, and whether #else has been seen.
  const stack = [];
  const live = () => stack.length === 0 || stack[stack.length - 1].active;

  for (let n = 0; n < lines.length; n++) {
    const lineNo = n + 1;
    const directive = lines[n].match(/^\s*#\s*(\w*)\s*(.*?)\s*$/);
    if (!directive) {
      if (!live()) lines[n] = '';
      continue;
    }
    lines[n] = '';
    const [, name, rest] = directive;
    const fail = (message) => { throw new ShaderSourceError(path, lineNo, message); };
    const condition = () => {
      try { return evaluate(rest, defines); } catch (e) { return fail(`#${name} ${rest}: ${e.message}`); }
    };
    const top = stack[stack.length - 1];

    switch (name) {
      case 'if': {
        const outer = live();
        const value = condition();              // evaluated even when dead, to catch typos
        stack.push({ outer, taken: outer && value, active: outer && value, line: lineNo, sawElse: false });
        break;
      }
      case 'elif': {
        if (!top) fail('#elif without #if');
        if (top.sawElse) fail('#elif after #else');
        const value = condition();
        top.active = top.outer && !top.taken && value;
        top.taken = top.taken || top.active;
        break;
      }
      case 'else':
        if (!top) fail('#else without #if');
        if (top.sawElse) fail('a second #else');
        if (rest) fail(`#else takes nothing, got "${rest}"`);
        top.sawElse = true;
        top.active = top.outer && !top.taken;
        top.taken = true;
        break;
      case 'endif':
        if (!top) fail('#endif without #if');
        if (rest) fail(`#endif takes nothing, got "${rest}"`);
        stack.pop();
        break;
      case 'import': {
        if (!live()) break;
        const quoted = rest.match(/^"([^"]+)"$/);
        if (!quoted) fail(`#import wants a quoted path, like #import "node.wgsls"; got ${rest || 'nothing'}`);
        imports.push({ path: resolvePath(path, quoted[1]), line: lineNo });
        break;
      }
      case 'error':
        if (live()) fail(`#error ${rest.replace(/^"(.*)"$/, '$1')}`);
        break;
      case 'warning':
        if (live()) warn(`${path}:${lineNo}: #warning ${rest.replace(/^"(.*)"$/, '$1')}`);
        break;
      default:
        // Only the conditionals matter in a dead branch; anything else there
        // is as ignored as the rest of it, as in C.
        if (live()) fail(`unknown directive #${name}`);
    }
  }
  if (stack.length) {
    throw new ShaderSourceError(path, stack[stack.length - 1].line, '#if without #endif');
  }
  return { lines, imports };
}

// -- linking ------------------------------------------------------------------------

/**
 * Link `entry` and everything it imports into one plain WGSL source.
 *
 * @param {string} entry  path of the root file, as `read` understands paths
 * @param {object} options
 * @param {Record<string, unknown>} [options.defines]  names #if can test
 * @param {(path: string) => string | Promise<string>} options.read
 * @param {(message: string) => void} [options.warn]  where #warning goes;
 *        console.warn by default
 * @returns {Promise<{ code: string, map: {path, offset, lines}[], files: string[] }>}
 *   code has one block per file, dependencies first; map says where each
 *   block starts (see public/shader-map.js); files lists them in order.
 */
export async function build(entry, { defines = {}, read, warn = console.warn }) {
  const state = new Map();                      // path -> 'pending' | 'done'
  const out = [];
  const map = [];
  const files = [];

  async function include(path, importedFrom) {
    if (state.get(path) === 'done') return;
    if (state.get(path) === 'pending') {
      throw new ShaderSourceError(importedFrom.path, importedFrom.line,
                                  `#import "${path}" makes a cycle`);
    }
    state.set(path, 'pending');

    let text;
    try {
      text = await read(path);
    } catch (e) {
      if (!importedFrom) throw new Error(`cannot read ${path}: ${e.message}`);
      throw new ShaderSourceError(importedFrom.path, importedFrom.line,
                                  `cannot read #import "${path}": ${e.message}`);
    }
    const { lines, imports } = processFile(path, text.replace(/\r\n/g, '\n'), defines, warn);
    for (const imp of imports) await include(imp.path, { path, line: imp.line });

    map.push({ path, offset: out.length, lines: lines.length });
    out.push(...lines);
    files.push(path);
    state.set(path, 'done');
  }

  await include(entry, null);
  return { code: out.join('\n'), map, files };
}
