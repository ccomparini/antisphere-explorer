// Tests for the shader preprocessor. Run with:
//   node --test tools/shader-build/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, evaluate, resolvePath, ShaderSourceError } from './preprocess.js';
import { mapLine } from '../../public/shader-map.js';

// A little file system: path -> text.
const files = (tree) => (path) => {
  if (!(path in tree)) throw new Error('no such file');
  return tree[path];
};

const rejects = (promise, pattern) => assert.rejects(promise, (e) => {
  assert.match(e.message, pattern);
  return true;
});

test('conditions: names, numbers, !, &&, || and parentheses', () => {
  const d = { A: true, B: 0, C: 'yes' };
  assert.equal(evaluate('A', d), true);
  assert.equal(evaluate('B', d), false);                 // defined but falsy
  assert.equal(evaluate('MISSING', d), false);
  assert.equal(evaluate('!MISSING && C', d), true);
  assert.equal(evaluate('B || (A && !B)', d), true);
  assert.equal(evaluate('0', d), false);
  assert.equal(evaluate('1', d), true);
  assert.equal(evaluate('!(A || B)', d), false);
  assert.equal(evaluate('A || B && MISSING', d), true);  // && binds tighter
  for (const bad of ['', 'A &&', '(A', 'A B', 'A == B', 'A )']) {
    assert.throws(() => evaluate(bad, d), undefined, bad);
  }
});

test('paths resolve against the importing file', () => {
  assert.equal(resolvePath('shaders/raycast.wgsl', 'node.wgsl'), 'shaders/node.wgsl');
  assert.equal(resolvePath('shaders/a/b.wgsl', '../c.wgsl'), 'shaders/c.wgsl');
  assert.equal(resolvePath('shaders/a/b.wgsl', './c/d.wgsl'), 'shaders/a/c/d.wgsl');
  assert.equal(resolvePath('shaders/a.wgsl', '/lib/x.wgsl'), 'lib/x.wgsl');
  assert.throws(() => resolvePath('a.wgsl', '../../x.wgsl'));
});

test('imports come first, each once, and every line keeps its number', async () => {
  const tree = {
    'main.wgsl': '#import "b.wgsl"\n#import "a.wgsl"\nfn main() {}\n// last',
    'a.wgsl': '#import "common.wgsl"\nfn a() {}',
    'b.wgsl': '#import "common.wgsl"\nfn b() {}',
    'common.wgsl': 'struct C { x : f32 }',
  };
  const { code, map, files: order } = await build('main.wgsl', { read: files(tree) });
  assert.deepEqual(order, ['common.wgsl', 'b.wgsl', 'a.wgsl', 'main.wgsl']);
  assert.equal(code.match(/struct C/g).length, 1);        // once, however often imported
  const out = code.split('\n');
  // Every source line is at its mapped place, directives blanked in situ.
  for (const [path, text] of Object.entries(tree)) {
    text.split('\n').forEach((line, n) => {
      const at = out.findIndex((_, k) => {
        const m = mapLine(map, k + 1);
        return m && m.path === path && m.line === n + 1;
      });
      assert.ok(at >= 0, `${path}:${n + 1} is mapped`);
      assert.equal(out[at], line.startsWith('#') ? '' : line, `${path}:${n + 1}`);
    });
  }
});

test('#if, #elif, #else and #endif, nested, blank what they drop', async () => {
  const src = [
    '#if A',                // 1
    'a',                    // 2
    '#elif B',              // 3
    'b',                    // 4
    '#else',                // 5
    'neither',              // 6
    '#if B',                // 7
    'neither and b',        // 8
    '#endif',               // 9
    '#endif',               // 10
    'always',               // 11
  ].join('\n');
  const run = async (defines) => (await build('x.wgsl', { defines, read: () => src })).code.split('\n');
  const keep = (lines) => lines.map((l, i) => (l ? i + 1 : 0)).filter(Boolean);
  assert.deepEqual(keep(await run({ A: 1, B: 1 })), [2, 11]);
  assert.deepEqual(keep(await run({ B: 1 })), [4, 11]);
  assert.deepEqual(keep(await run({})), [6, 11]);
  assert.equal((await run({})).length, 11);              // nothing removed
});

test('an import inside a branch not taken is not imported', async () => {
  const tree = {
    'x.wgsl': '#if FANCY\n#import "fancy.wgsl"\n#else\n#import "plain.wgsl"\n#endif',
    'plain.wgsl': 'fn plain() {}',
  };
  const { files: order } = await build('x.wgsl', { read: files(tree) });
  assert.deepEqual(order, ['plain.wgsl', 'x.wgsl']);
  await rejects(build('x.wgsl', { defines: { FANCY: true }, read: files(tree) }),
                /^x\.wgsl:2: cannot read #import "fancy\.wgsl"/);
});

test('mistakes are reported where they are', async () => {
  const one = (text, defines = {}) => build('s.wgsl', { defines, read: () => text });
  await rejects(one('fn f() {}\n#if A\n'), /^s\.wgsl:2: #if without #endif/);
  await rejects(one('#endif'), /^s\.wgsl:1: #endif without #if/);
  await rejects(one('#if A\n#else\n#else\n#endif'), /^s\.wgsl:3: a second #else/);
  await rejects(one('#if A\n#else\n#elif B\n#endif'), /^s\.wgsl:3: #elif after #else/);
  await rejects(one('\n#if A &&\n#endif'), /^s\.wgsl:2: #if A &&:/);
  await rejects(one('#include "x.wgsl"'), /^s\.wgsl:1: unknown directive #include/);
  await rejects(one('#import node.wgsl'), /^s\.wgsl:1: #import wants a quoted path/);
  await rejects(one('#if 1\n#error "not this way"\n#endif'), /^s\.wgsl:2: #error not this way/);
  // A typo in a condition is caught even inside a branch not taken...
  await rejects(one('#if 0\n#if A B\n#endif\n#endif'), /^s\.wgsl:2:/);
  // ...but other directives there are ignored, as the lines around them are.
  await build('s.wgsl', { read: () => '#if 0\n#error "unreached"\n#pragma whatever\n#endif' });
});

test('an import cycle names the import that closes it', async () => {
  const tree = { 'a.wgsl': '#import "b.wgsl"', 'b.wgsl': '\n#import "a.wgsl"' };
  await rejects(build('a.wgsl', { read: files(tree) }), /^b\.wgsl:2: #import "a\.wgsl" makes a cycle/);
});

test('errors are ShaderSourceErrors carrying their place', async () => {
  try {
    await build('s.wgsl', { read: () => '\n\n#bogus' });
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof ShaderSourceError);
    assert.equal(e.path, 's.wgsl');
    assert.equal(e.line, 3);
  }
});
