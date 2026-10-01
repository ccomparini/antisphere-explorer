// Struct layouts from WGSL source, by WGSL's own rules.
//
// Reads just enough WGSL to know how the structs shared with JS sit in
// memory: top-level `struct`, `alias` and integer `const` declarations, and
// `var<uniform>` / `var<storage>` declarations, which are what the host
// actually shares. Everything else (functions, other declarations) is
// skipped by brace matching, never parsed. The grammar for the parts that
// are read is the WGSL spec's (gpuweb/wgsl/syntax.bnf: struct_decl,
// struct_member, type_alias_decl, global_variable_decl, template_list).
//
// Sizes and alignments follow the spec's Memory Layout section:
//
//   f32 i32 u32 (and atomics of them)   size 4, align 4
//   vec2<T>                             size 8, align 8
//   vec3<T>                             size 12, align 16
//   vec4<T>                             size 16, align 16
//   matCxR<f32>                         C columns of vecR, each at the
//                                       vecR alignment
//   array<E, N>                         stride roundUp(align(E), size(E)),
//                                       size N * stride, align(E)
//   struct                              members in order, each at the next
//                                       multiple of its alignment
//                                       (@align overrides it, @size its
//                                       size); aligned to its largest member,
//                                       size rounded up to that
//
// Only types that can cross to the host are accepted in shared structs: no
// bool, no f16 yet (JS would need Float16Array), no pointers or textures.

/** A problem in the linked source, at an output line (map it to a file with public/shader-map.js). */
export class LayoutError extends Error {
  constructor(line, message) {
    super(message);
    this.line = line;
  }
}

const roundUp = (align, n) => Math.ceil(n / align) * align;

// -- tokens ---------------------------------------------------------------------------

/** WGSL's tokens, comments dropped: { t, line, at } with `at` the offset in code. */
export function tokenize(code) {
  const tokens = [];
  let line = 1;
  const re = /\s+|\/\/[^\n]*|\/\*|0[xX][0-9a-fA-F]+[iu]?|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[iufh]?|[A-Za-z_]\w*|./gy;
  let m;
  while ((m = re.exec(code))) {
    const t = m[0];
    if (t === '/*') {
      // Block comments nest in WGSL.
      let depth = 1, i = re.lastIndex;
      while (depth && i < code.length) {
        if (code.startsWith('/*', i)) { depth++; i += 2; }
        else if (code.startsWith('*/', i)) { depth--; i += 2; }
        else { if (code[i] === '\n') line++; i++; }
      }
      re.lastIndex = i;
      continue;
    }
    if (/^\s/.test(t) || t.startsWith('//')) {
      for (const c of t) if (c === '\n') line++;
      continue;
    }
    tokens.push({ t, line, at: m.index });
  }
  return tokens;
}

// -- declarations ---------------------------------------------------------------------

/**
 * The declarations layouts depend on:
 * { structs: Map<name, {name, line, members: [{name, type, align?, size?, line}]}>,
 *   aliases: Map<name, type>, consts: Map<name, integer>,
 *   vars: [{name, space, type, line}] }
 * where a type is { name, args: (type | {value})[], line }.
 */
export function parseDeclarations(code) {
  const tokens = tokenize(code);
  let i = 0;
  const at = () => tokens[i] ?? { t: '', line: tokens.at(-1)?.line ?? 1 };
  const next = () => tokens[i++] ?? at();
  const expect = (t) => {
    const tok = next();
    if (tok.t !== t) throw new LayoutError(tok.line, `expected "${t}", found "${tok.t || 'end of file'}"`);
    return tok;
  };
  const ident = () => {
    const tok = next();
    if (!/^[A-Za-z_]\w*$/.test(tok.t)) throw new LayoutError(tok.line, `expected a name, found "${tok.t}"`);
    return tok;
  };

  // A type, or inside a template list an expression, which for layout
  // purposes means an integer literal or a const's name.
  const typeOrValue = () => {
    const tok = at();
    if (/^(0[xX]|\d)/.test(tok.t)) { next(); return { value: parseInt(tok.t, /^0[xX]/.test(tok.t) ? 16 : 10), line: tok.line }; }
    return type();
  };
  const type = () => {
    const tok = ident();
    const node = { name: tok.t, args: [], line: tok.line };
    if (at().t === '<') {
      next();
      while (at().t !== '>') {
        node.args.push(typeOrValue());
        if (at().t === ',') next();
        else if (at().t !== '>') throw new LayoutError(at().line, `expected "," or ">" in ${tok.t}<...>, found "${at().t}"`);
      }
      next();
    }
    return node;
  };
  // Skip a balanced (...) group, having just seen "(".
  const skipParens = () => {
    let depth = 1;
    while (depth && i < tokens.length) {
      const t = next().t;
      if (t === '(') depth++;
      else if (t === ')') depth--;
    }
  };
  const attributes = () => {
    const attrs = {};
    while (at().t === '@') {
      next();
      const name = ident().t;
      if (at().t === '(') {
        next();
        const start = i;
        skipParens();
        attrs[name] = tokens.slice(start, i - 1).filter((x) => x.t !== ',').map((x) => x.t);
      } else {
        attrs[name] = [];
      }
    }
    return attrs;
  };

  const structs = new Map(), aliases = new Map(), consts = new Map(), vars = [];
  let depth = 0;
  while (i < tokens.length) {
    const tok = at();
    if (tok.t === '{') { depth++; next(); continue; }
    if (tok.t === '}') { depth--; next(); continue; }
    if (depth > 0) { next(); continue; }

    if (tok.t === 'struct') {
      next();
      const name = ident();
      expect('{');
      const members = [];
      while (at().t !== '}') {
        const attrs = attributes();
        const member = ident();
        expect(':');
        const m = { name: member.t, type: type(), line: member.line };
        if (attrs.align) m.align = attrs.align;
        if (attrs.size) m.size = attrs.size;
        members.push(m);
        if (at().t === ',') next();
        else if (at().t !== '}') throw new LayoutError(at().line, `expected "," or "}" in struct ${name.t}, found "${at().t}"`);
      }
      next();
      structs.set(name.t, { name: name.t, line: name.line, members });
    } else if (tok.t === 'alias') {
      next();
      const name = ident().t;
      expect('=');
      aliases.set(name, type());
    } else if (tok.t === 'const') {
      next();
      const name = ident().t;
      if (at().t === ':') { next(); type(); }
      expect('=');
      const value = at();
      if (/^(0[xX][0-9a-fA-F]+|\d+)[iu]?$/.test(value.t) && tokens[i + 1]?.t === ';') {
        consts.set(name, parseInt(value.t, /^0[xX]/.test(value.t) ? 16 : 10));
      }
    } else if (tok.t === 'var') {
      next();
      let space = 'function';
      if (at().t === '<') {
        next();
        space = ident().t;
        while (at().t !== '>') next();
        next();
      }
      const name = ident();
      if (at().t === ':') {
        next();
        vars.push({ name: name.t, space, type: type(), line: name.line });
      }
    } else {
      next();
    }
  }
  return { structs, aliases, consts, vars };
}

// -- layouts ---------------------------------------------------------------------------

const SCALARS = { f32: 'f32', i32: 'i32', u32: 'u32' };
const SHORT_SUFFIX = { f: 'f32', i: 'i32', u: 'u32' };

/**
 * Layouts of types in a parsed source. `of(type)` gives one of:
 *   { kind: 'scalar', scalar, size, align }
 *   { kind: 'vector', n, scalar, size, align }
 *   { kind: 'matrix', c, r, scalar, colStride, size, align }
 *   { kind: 'array', elem, count, stride, size, align }   (count null: runtime-sized)
 *   { kind: 'struct', name, members: [{ name, offset, type }], size, align }
 */
export function layouts(decls) {
  const structCache = new Map();

  const intArg = (arg, what) => {
    if (arg.value !== undefined) return arg.value;
    if (decls.consts.has(arg.name) && !arg.args.length) return decls.consts.get(arg.name);
    throw new LayoutError(arg.line, `${what}: needs an integer literal or a simple const, not "${arg.name}"`);
  };
  const attrInt = (tokens, line, what) => {
    if (tokens.length !== 1) throw new LayoutError(line, `${what} wants one integer`);
    const t = tokens[0];
    if (/^\d/.test(t)) return parseInt(t, /^0[xX]/.test(t) ? 16 : 10);
    if (decls.consts.has(t)) return decls.consts.get(t);
    throw new LayoutError(line, `${what}(${t}): needs an integer literal or a simple const`);
  };
  const scalarOf = (arg, line, where) => {
    const s = arg && !arg.value && !arg.args.length ? SCALARS[arg.name] : undefined;
    if (!s) throw new LayoutError(line, `${where}: element type must be f32, i32 or u32 to share with JS`);
    return s;
  };
  const vector = (n, scalar) => ({ kind: 'vector', n, scalar, size: 4 * n, align: n === 2 ? 8 : 16 });

  function of(t, seen = new Set()) {
    const { name, args, line } = t;
    if (SCALARS[name] && !args.length) return { kind: 'scalar', scalar: name, size: 4, align: 4 };
    if (name === 'atomic') return { kind: 'scalar', scalar: scalarOf(args[0], line, 'atomic'), size: 4, align: 4 };
    if (name === 'bool') throw new LayoutError(line, 'bool cannot be shared with the host; use u32');
    if (name === 'f16' || /^(vec\dh|mat\dx\dh)$/.test(name)) {
      throw new LayoutError(line, `${name}: f16 is not supported in shared structs yet`);
    }

    let m = name.match(/^vec([234])([fiu])?$/);
    if (m) {
      const scalar = m[2] ? SHORT_SUFFIX[m[2]] : scalarOf(args[0], line, name);
      return vector(+m[1], scalar);
    }
    m = name.match(/^mat([234])x([234])(f)?$/);
    if (m) {
      const [c, r] = [+m[1], +m[2]];
      const scalar = m[3] ? 'f32' : scalarOf(args[0], line, name);
      if (scalar !== 'f32') throw new LayoutError(line, `${name}: matrices are f32`);
      const col = vector(r, scalar);
      const colStride = roundUp(col.align, col.size);
      return { kind: 'matrix', c, r, scalar, colStride, size: c * colStride, align: col.align };
    }
    if (name === 'array') {
      if (!args[0] || args[0].value !== undefined) throw new LayoutError(line, 'array needs an element type');
      const elem = of(args[0], seen);
      if (elem.kind === 'array' && elem.count === null) {
        throw new LayoutError(line, 'an array of runtime-sized arrays is not allowed');
      }
      const stride = roundUp(elem.align, elem.size);
      const count = args[1] ? intArg(args[1], 'array size') : null;
      return { kind: 'array', elem, count, stride, size: (count ?? 1) * stride, align: elem.align };
    }
    if (decls.aliases.has(name) && !args.length) return of(decls.aliases.get(name), seen);
    if (decls.structs.has(name) && !args.length) return struct(name, seen);
    throw new LayoutError(line, `${name}: not a type that can be shared with JS (or not declared)`);
  }

  function struct(name, seen) {
    if (structCache.has(name)) return structCache.get(name);
    const decl = decls.structs.get(name);
    if (seen.has(name)) throw new LayoutError(decl.line, `struct ${name} contains itself`);
    seen = new Set(seen).add(name);

    const members = [];
    let end = 0, align = 1;
    decl.members.forEach((member, k) => {
      const type = of(member.type, seen);
      if (type.kind === 'array' && type.count === null && k !== decl.members.length - 1) {
        throw new LayoutError(member.line, `${name}.${member.name}: a runtime-sized array must be the last member`);
      }
      const memberAlign = member.align ? attrInt(member.align, member.line, '@align') : type.align;
      const memberSize = member.size ? attrInt(member.size, member.line, '@size') : type.size;
      if (memberSize < type.size) {
        throw new LayoutError(member.line, `${name}.${member.name}: @size(${memberSize}) is smaller than the type (${type.size})`);
      }
      const offset = roundUp(memberAlign, end);
      members.push({ name: member.name, offset, type });
      end = offset + memberSize;
      align = Math.max(align, memberAlign);
    });
    const layout = { kind: 'struct', name, members, size: roundUp(align, end), align };
    structCache.set(name, layout);
    return layout;
  }

  return { of };
}

/**
 * The structs a source shares with the host: those reachable from its
 * uniform and storage variables, nested structs before the structs that
 * contain them.
 */
export function sharedStructs(code) {
  const decls = parseDeclarations(code);
  const { of } = layouts(decls);
  const found = new Map();
  const visit = (layout) => {
    if (layout.kind === 'array') return visit(layout.elem);
    if (layout.kind !== 'struct' || found.has(layout.name)) return;
    for (const m of layout.members) visit(m.type);
    found.set(layout.name, layout);
  };
  for (const v of decls.vars) {
    if (v.space === 'uniform' || v.space === 'storage') visit(of(v.type));
  }
  return [...found.values()];
}
