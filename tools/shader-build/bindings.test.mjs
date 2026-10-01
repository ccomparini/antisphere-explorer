// Tests for binding assignment and each entry point's resources. Run with:
//   node --test tools/shader-build/
//
// public/gpu.test.mjs checks the real shaders' lists against the compiler's
// own 'auto' layouts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignBindings, BindingError } from './bindings.js';
import { buildAll } from './index.js';

const SOURCE = `struct S { x : f32 }
var<uniform> cam : S;
var<storage, read> nodes : array<S>;
var<private> stack : array<f32, 4>;
var outTex : texture_storage_2d<rgba8unorm, write>;
var samp : sampler;
var<storage, read_write> results : array<S>;

fn leaf() -> f32 { return nodes[0].x; }
fn middle() -> f32 { return leaf() + stack[0]; }
fn usesCam(s : S) -> f32 { return s.x + cam.x; }

@compute @workgroup_size(64)
fn first(@builtin(global_invocation_id) gid : vec3<u32>) {
  results[gid.x] = S(middle());
}

@compute @workgroup_size(1)
fn second() {
  textureStore(outTex, vec2<i32>(0), vec4<f32>(usesCam(S(1.0))));
}

// A field named like a resource is not a use of it.
struct Q { results : u32 }
@vertex fn vs(q : Q) -> @builtin(position) vec4<f32> { return vec4<f32>(f32(q.results)); }
`;

test('resources are numbered in declaration order; private vars are not resources', () => {
  const { slots } = assignBindings(SOURCE);
  assert.deepEqual(slots, { cam: 0, nodes: 1, outTex: 2, samp: 3, results: 4 });
});

test('the attributes go on each declaration\'s own line, so lines keep their numbers', () => {
  const { code } = assignBindings(SOURCE);
  const before = SOURCE.split('\n'), after = code.split('\n');
  assert.equal(after.length, before.length);
  assert.equal(after[1], '@group(0) @binding(0) var<uniform> cam : S;');
  assert.equal(after[3], before[3]);
  assert.equal(after[6], '@group(0) @binding(4) var<storage, read_write> results : array<S>;');
});

test('an entry point uses what it reaches through every call, and nothing else', () => {
  const { entries } = assignBindings(SOURCE);
  assert.deepEqual(entries, {
    first: ['nodes', 'results'],       // through middle() and leaf()
    second: ['cam', 'outTex'],         // through usesCam()
    vs: [],                            // q.results is a field
  });
});

test('a hand-written @group or @binding is refused, at its line', () => {
  assert.throws(() => assignBindings('struct S { x : f32 }\n@group(0) @binding(3) var<uniform> u : S;'),
                (e) => e instanceof BindingError && e.line === 2 && /without @group or @binding/.test(e.message));
});

test('the build numbers bindings per output, across imports, and maps errors to their file', async () => {
  const tree = {
    'shaders/lib.wgsls': 'struct N { x : f32 }\nvar<storage, read> nodes : array<N>;\nfn get(i : u32) -> f32 { return nodes[i].x; }',
    'shaders/a.wgsls': '#import "lib.wgsls"\nvar<storage, read_write> out : array<f32>;\n' +
                       '@compute @workgroup_size(1) fn main() { out[0] = get(0u); }',
    'shaders/b.wgsls': 'var<uniform> u : f32;\n#import "lib.wgsls"\n@compute @workgroup_size(1) fn other() { _ = u; }',
    'shaders/bad.wgsls': '#import "lib.wgsls"\n\n@group(0) @binding(9) var<uniform> u : f32;',
  };
  const read = (p) => { if (!(p in tree)) throw new Error('no file'); return tree[p]; };
  const files = await buildAll({
    outputs: [{ entry: 'shaders/a.wgsls', out: 'gen/a.wgsl' }, { entry: 'shaders/b.wgsls', out: 'gen/b.wgsl' }],
    layouts: 'gen/layouts.js',
  }, read);
  const a = files.find((f) => f.path === 'gen/a.wgsl').content;
  assert.match(a, /@group\(0\) @binding\(0\) var<storage, read> nodes/);
  assert.match(a, /@group\(0\) @binding\(1\) var<storage, read_write> out/);

  const layouts = files.find((f) => f.path === 'gen/layouts.js').content;
  const { BINDINGS } = await import(`data:text/javascript,${encodeURIComponent(layouts)}`);
  // An import is placed before the file that first asks for it.
  assert.deepEqual(BINDINGS, {
    a: { slots: { nodes: 0, out: 1 }, entries: { main: ['nodes', 'out'] } },
    b: { slots: { nodes: 0, u: 1 }, entries: { other: ['u'] } },
  });
  assert.ok(Object.isFrozen(BINDINGS.a.entries.main));

  await assert.rejects(buildAll({ outputs: [{ entry: 'shaders/bad.wgsls', out: 'x' }] }, read), (e) => {
    assert.match(e.message, /^shaders\/bad\.wgsls:3: @group: resources are written without/);
    return true;
  });
});
