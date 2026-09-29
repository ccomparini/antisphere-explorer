// Tests for WGSL struct layouts and the JS classes generated from them. Run with:
//   node --test tools/shader-build/
//
// The sizes and offsets here are worked from the WGSL spec's memory layout
// rules. public/gpu.test.mjs checks the generated classes against what Dawn
// actually lays out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sharedStructs, parseDeclarations, layouts, LayoutError } from './layout.js';
import { emitModule } from './emit-js.js';
import { buildAll } from './index.js';

const shared = (code) => Object.fromEntries(sharedStructs(code).map((s) => [s.name, s]));
const offsets = (s) => Object.fromEntries(s.members.map((m) => [m.name, m.offset]));
const load = async (code) =>
  import(`data:text/javascript,${encodeURIComponent(emitModule(sharedStructs(code), '// test'))}`);

test('scalars and vectors: vec3 aligns like vec4, and the struct rounds up', () => {
  const s = shared(`
    struct S { a : f32, b : vec3<f32>, c : u32, d : vec2f, e : i32 }
    @group(0) @binding(0) var<storage, read> xs : array<S>;
  `).S;
  assert.deepEqual(offsets(s), { a: 0, b: 16, c: 28, d: 32, e: 40 });
  assert.equal(s.align, 16);
  assert.equal(s.size, 48);
});

test('arrays stride by roundUp(align, size), matrices by aligned columns', () => {
  const s = shared(`
    struct S {
      a : array<vec3<f32>, 2>,   // stride 16
      b : array<f32, 3>,         // stride 4
      m : mat3x3<f32>,           // three 16-byte columns
      n : mat2x2f,               // two 8-byte columns
    }
    @group(0) @binding(0) var<uniform> u : S;
  `).S;
  assert.deepEqual(offsets(s), { a: 0, b: 32, m: 48, n: 96 });
  assert.equal(s.members[0].type.stride, 16);
  assert.equal(s.members[2].type.size, 48);
  assert.equal(s.members[3].type.size, 16);
  assert.equal(s.size, 112);
});

test('@align and @size move members; nested structs keep their own alignment', () => {
  const s = shared(`
    struct Inner { x : f32, y : vec2<f32> }   // align 8, size 16
    struct S {
      @size(12) a : f32,
      b : Inner,
      @align(32) c : u32,
      d : array<Inner, 2>,
    }
    @group(0) @binding(0) var<storage> s : S;
  `);
  assert.equal(s.Inner.size, 16);
  assert.deepEqual(offsets(s.S), { a: 0, b: 16, c: 32, d: 40 });
  assert.equal(s.S.align, 32);
  assert.equal(s.S.size, 96);                      // 72 bytes, rounded to the 32 @align set
});

test('the project structs come out at their hand-worked sizes', () => {
  const s = shared(`
    struct Node {
      axis : vec3<f32>, curvature_perp : f32, linear : vec3<f32>, curvature_delta : f32,
      const_term : f32, inside : u32, outside : u32, material : i32, env : i32,
    };
    struct Seg { node : u32, t0 : f32, t1 : f32 };
    struct Light { pos : vec3<f32>, pad0 : f32, color : vec3<f32>, pad1 : f32 };
    @group(0) @binding(1) var<storage, read> nodes : array<Node>;
    @group(0) @binding(3) var<storage, read> lights : array<Light>;
    @group(0) @binding(6) var<storage, read_write> rayResults : array<Seg>;
  `);
  assert.equal(s.Node.size, 64);                   // 52 bytes of fields, rounded to 16
  assert.equal(offsets(s.Node).env, 48);
  assert.equal(s.Seg.size, 12);
  assert.equal(s.Light.size, 32);
});

test('only structs reachable from uniform and storage variables are shared', () => {
  const s = shared(`
    struct Shared { x : f32 }
    struct Nested { y : f32 }
    struct Outer { n : array<Nested, 2> }
    struct Private { z : f32 }
    struct Local { w : f32 }
    @group(0) @binding(0) var<storage> a : Shared;
    @group(0) @binding(1) var<uniform> b : Outer;
    var<private> p : Private;
    fn f() { var l : Local; }
  `);
  assert.deepEqual(Object.keys(s), ['Shared', 'Nested', 'Outer']);   // nested before outer
});

test('aliases, consts, comments and function bodies are handled or skipped', () => {
  const s = shared(`
    /* a /* nested */ comment with struct Fake { x : f32 } in it */
    // struct AlsoFake { y : f32 }
    const COUNT : u32 = 4u;
    const OTHER = 0x10;
    alias V = vec4<f32>;
    struct S { v : V, a : array<u32, COUNT>, b : array<f32, OTHER> }
    fn f(x : vec3<f32>) -> vec3<f32> { var s : S; if (x.x < 1.0) { return x; } return x >> vec3u(1); }
    @group(0) @binding(0) var<storage> s : S;
  `).S;
  assert.deepEqual(offsets(s), { v: 0, a: 16, b: 32 });
  assert.equal(s.size, 96);
});

test('what cannot cross to the host is refused, at its line', () => {
  const refuses = (code, pattern) => assert.throws(() => sharedStructs(code), (e) => {
    assert.ok(e instanceof LayoutError);
    assert.match(e.message, pattern);
    return true;
  });
  refuses('struct S { b : bool }\n@group(0) @binding(0) var<storage> s : S;', /bool cannot be shared/);
  refuses('struct S { h : f16 }\n@group(0) @binding(0) var<storage> s : S;', /f16/);
  refuses('struct S { a : array<f32>, b : f32 }\n@group(0) @binding(0) var<storage> s : S;', /must be the last member/);
  refuses('struct S { t : Missing }\n@group(0) @binding(0) var<storage> s : S;', /Missing/);
  refuses('struct S { a : array<f32, N> }\n@group(0) @binding(0) var<storage> s : S;', /simple const/);
  refuses('struct S { s : S }\n@group(0) @binding(0) var<storage> s : S;', /contains itself/);
  assert.throws(
    () => sharedStructs('\n\nstruct S {\n  ok : f32,\n  bad : bool,\n}\n@group(0) @binding(0) var<storage> s : S;'),
    (e) => e.line === 5,
  );
});

test('generated classes write and read every kind of field', async () => {
  const code = `
    struct Inner { x : f32, y : vec2<f32> }
    struct S {
      a : u32, b : vec3<f32>, c : i32,
      m : mat2x3<f32>,
      arr : array<vec2<f32>, 3>,
      inner : Inner,
      inners : array<Inner, 2>,
    }
    @group(0) @binding(0) var<storage> s : array<S>;
  `;
  const { S } = await load(code);
  assert.equal(S.SIZE, sharedStructs(code).find((s) => s.name === 'S').size);
  const values = {
    a: 7, b: [1, 2, 3], c: -5,
    m: [[1, 2, 3], [4, 5, 6]],
    arr: [[1, 2], [3, 4], [5, 6]],
    inner: { x: 9, y: [10, 11] },
    inners: [{ x: 1, y: [2, 3] }, { x: 4, y: [5, 6] }],
  };
  const v = S.allocate(3);
  S.write(v, 2, values);
  assert.deepEqual(S.read(v, 2), values);
  assert.deepEqual(S.read(v, 0).b, [0, 0, 0]);            // other elements untouched
  // Fields that are not given are left alone.
  S.write(v, 2, { a: 8 });
  assert.equal(S.read(v, 2).a, 8);
  assert.deepEqual(S.read(v, 2).b, [1, 2, 3]);
  // And the bytes are where FIELDS says.
  const base = 2 * S.STRIDE;
  assert.equal(v.u32[(base + S.FIELDS.a.offset) / 4], 8);
  assert.equal(v.i32[(base + S.FIELDS.c.offset) / 4], -5);
  assert.equal(S.FIELDS.m.type, 'mat2x3<f32>');
});

test('the build links, maps layout errors to their source, and refuses clashing layouts', async () => {
  const tree = {
    'shaders/node.wgsl': 'struct N { x : f32 }',
    'shaders/a.wgsl': '#import "node.wgsl"\n@group(0) @binding(0) var<storage> n : array<N>;',
    'shaders/b.wgsl': 'struct N { x : u32, y : u32 }\n@group(0) @binding(0) var<storage> n : N;',
    'shaders/bad.wgsl': '#import "node.wgsl"\n\nstruct B {\n  flag : bool,\n}\n@group(0) @binding(0) var<storage> b : B;',
  };
  const read = (p) => { if (!(p in tree)) throw new Error('no file'); return tree[p]; };
  const files = await buildAll({
    outputs: [{ entry: 'shaders/a.wgsl', out: 'gen/a.wgsl' }], layouts: 'gen/layouts.js',
  }, read);
  assert.deepEqual(files.map((f) => f.path), ['gen/a.wgsl', 'gen/layouts.js']);
  assert.match(files[0].content, /^\/\/ GENERATED by .* from shaders\/a\.wgsl/);
  assert.match(files[0].content, /\n\/\/ sourcemap: \[.*"path":"shaders\/node\.wgsl"/);
  assert.match(files[1].content, /export class N \{/);

  const failsWith = (promise, pattern) =>
    assert.rejects(promise, (e) => { assert.match(e.message, pattern); return true; });
  await failsWith(buildAll({ outputs: [{ entry: 'shaders/bad.wgsl', out: 'x' }] }, read),
                  /^shaders\/bad\.wgsl:4: bool cannot be shared/);
  await failsWith(buildAll({
    outputs: [{ entry: 'shaders/a.wgsl', out: 'x' }, { entry: 'shaders/b.wgsl', out: 'y' }],
  }, read), /^struct N is laid out differently/);
});

test('parseDeclarations finds the uniform and storage variables and their types', () => {
  const d = parseDeclarations(`
    @group(0) @binding(0) var<uniform> cam : Camera;
    @group(0) @binding(1) var<storage, read_write> out : array<Seg>;
    @group(0) @binding(2) var tex : texture_storage_2d<rgba8unorm, write>;
    var<private> stack : array<Seg, 32>;
  `);
  assert.deepEqual(d.vars.map((v) => [v.name, v.space, v.type.name]),
                   [['cam', 'uniform', 'Camera'], ['out', 'storage', 'array'],
                    ['tex', 'function', 'texture_storage_2d'], ['stack', 'private', 'array']]);
  assert.ok(layouts(d));
});
