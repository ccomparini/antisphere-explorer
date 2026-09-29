// JS classes for WGSL structs, generated from their layouts (see layout.js).
//
// For a struct S the generated class has only statics:
//
//   S.SIZE, S.ALIGN, S.STRIDE   bytes; STRIDE is one array element's step
//   S.FIELDS                    { name: { offset, type } }, frozen
//   S.allocate(count)           views over a new zeroed buffer of count S's
//   S.write(views, i, values)   element i of an array of S; sets only the
//                               fields present in `values`
//   S.read(views, i)            element i as a plain object
//   S.writeAt / S.readAt        the same at a byte offset, for nesting
//
// `views` is { buffer, f32, u32, i32 } over one ArrayBuffer, from viewsOf()
// or allocate(). Values are numbers for scalars, arrays for vectors, arrays
// of column arrays for matrices, arrays for arrays, objects for structs.
// The writes are straight-line code with the offsets folded in, so filling
// a large array is a plain loop over typed-array stores.

const typeName = (t) => {
  switch (t.kind) {
    case 'scalar': return t.scalar;
    case 'vector': return `vec${t.n}<${t.scalar}>`;
    case 'matrix': return `mat${t.c}x${t.r}<${t.scalar}>`;
    case 'array': return t.count === null ? `array<${typeName(t.elem)}>` : `array<${typeName(t.elem)}, ${t.count}>`;
    case 'struct': return t.name;
  }
  throw new Error(`unknown kind ${t.kind}`);
};

// Word offsets are kept as "w + <constant>" plus any loop terms, so that
// constant parts fold at generation time.
const word = (base, bytes, extra = '') => `${base}${bytes ? ` + ${bytes / 4}` : ''}${extra}`;

function writeCode(t, value, base, bytes, extra, depth, indent) {
  const pad = ' '.repeat(indent);
  switch (t.kind) {
    case 'scalar':
      return `${pad}${t.scalar}[${word(base, bytes, extra)}] = ${value};\n`;
    case 'vector': {
      let s = '';
      for (let j = 0; j < t.n; j++) s += `${pad}${t.scalar}[${word(base, bytes + 4 * j, extra)}] = ${value}[${j}];\n`;
      return s;
    }
    case 'matrix': {
      let s = '';
      for (let c = 0; c < t.c; c++) {
        for (let r = 0; r < t.r; r++) {
          s += `${pad}${t.scalar}[${word(base, bytes + c * t.colStride + 4 * r, extra)}] = ${value}[${c}][${r}];\n`;
        }
      }
      return s;
    }
    case 'array': {
      const i = `i${depth}`, e = `e${depth}`;
      return `${pad}for (let ${i} = 0; ${i} < ${t.count}; ${i}++) {\n` +
             `${pad}  const ${e} = ${value}[${i}];\n` +
             `${pad}  if (${e} === undefined) continue;\n` +
             writeCode(t.elem, e, base, bytes, `${extra} + ${i} * ${t.stride / 4}`, depth + 1, indent + 2) +
             `${pad}}\n`;
    }
    case 'struct':
      return `${pad}${t.name}.writeAt(views, (${word(base, bytes, extra)}) * 4, ${value});\n`;
  }
  throw new Error(`unknown kind ${t.kind}`);
}

function readCode(t, base, bytes, extra, depth) {
  switch (t.kind) {
    case 'scalar':
      return `${t.scalar}[${word(base, bytes, extra)}]`;
    case 'vector':
      return `[${Array.from({ length: t.n }, (_, j) => `${t.scalar}[${word(base, bytes + 4 * j, extra)}]`).join(', ')}]`;
    case 'matrix':
      return `[${Array.from({ length: t.c }, (_, c) =>
        `[${Array.from({ length: t.r }, (_, r) => `${t.scalar}[${word(base, bytes + c * t.colStride + 4 * r, extra)}]`).join(', ')}]`,
      ).join(', ')}]`;
    case 'array': {
      const i = `i${depth}`;
      return `Array.from({ length: ${t.count} }, (_, ${i}) => ${readCode(t.elem, base, bytes, `${extra} + ${i} * ${t.stride / 4}`, depth + 1)})`;
    }
    case 'struct':
      return `${t.name}.readAt(views, (${word(base, bytes, extra)}) * 4)`;
  }
  throw new Error(`unknown kind ${t.kind}`);
}

function structClass(s) {
  for (const m of s.members) {
    if (m.type.kind === 'array' && m.type.count === null) {
      throw new Error(`${s.name}.${m.name}: runtime-sized array members are not supported in JS layouts yet`);
    }
  }
  const fields = s.members.map((m) =>
    `    ${m.name}: Object.freeze({ offset: ${m.offset}, type: '${typeName(m.type)}' }),`).join('\n');
  const writes = s.members.map((m) =>
    `    if (values.${m.name} !== undefined) {\n` +
    writeCode(m.type, `values.${m.name}`, 'w', m.offset, '', 0, 6) +
    '    }\n').join('');
  const reads = s.members.map((m) => `      ${m.name}: ${readCode(m.type, 'w', m.offset, '', 0)},`).join('\n');
  return `export class ${s.name} {
  static SIZE = ${s.size};
  static ALIGN = ${s.align};
  static STRIDE = ${Math.ceil(s.size / s.align) * s.align};
  static FIELDS = Object.freeze({
${fields}
  });

  static allocate(count = 1) { return viewsOf(new ArrayBuffer(count * ${s.name}.STRIDE)); }
  static write(views, index, values) { ${s.name}.writeAt(views, index * ${s.name}.STRIDE, values); }
  static read(views, index) { return ${s.name}.readAt(views, index * ${s.name}.STRIDE); }

  static writeAt(views, byteOffset, values) {
    const { f32, u32, i32 } = views, w = byteOffset >> 2;
${writes}  }

  static readAt(views, byteOffset) {
    const { f32, u32, i32 } = views, w = byteOffset >> 2;
    return {
${reads}
    };
  }
}
`;
}

/**
 * The whole generated module for these struct layouts. `header` is a
 * comment block to put first. Structs must come nested-first, as
 * sharedStructs() returns them.
 */
export function emitModule(structs, header) {
  return `${header}
/** Views of one buffer as each element type a struct can hold. */
export function viewsOf(buffer) {
  return { buffer, f32: new Float32Array(buffer), u32: new Uint32Array(buffer), i32: new Int32Array(buffer) };
}

${structs.map(structClass).join('\n')}`;
}
