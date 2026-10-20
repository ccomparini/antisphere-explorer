// Tests for the tools' option parsing. Run with:
//   node --test tools/args.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOptions, commandLine } from './args.mjs';

const OPTIONS = {
  out:   { type: 'string', short: 'o' },
  fit:   { type: 'number' },
  up:    { type: 'string' },
  rev:   { type: 'string', short: 'r', multiple: true },
  runs:  { type: 'number', short: 'n', default: 3 },
  whole: { type: 'boolean' },
  help:  { type: 'boolean', short: 'h' },
};
const parse = (argv, opts = { positionals: true }) => parseOptions(argv, OPTIONS, opts);

test('a value goes after a space or an =, a short one\'s straight on too', () => {
  for (const argv of [['--fit', '23'], ['--fit=23']]) assert.equal(parse(argv).values.fit, 23);
  for (const argv of [['-o', 'a.json'], ['-oa.json'], ['-o=a.json'], ['--out=a.json'], ['--out', 'a.json']]) {
    assert.equal(parse(argv).values.out, 'a.json', argv.join(' '));
  }
});

test('a number option gives a number; a default is given when it is absent', () => {
  assert.equal(parse([]).values.runs, 3);
  assert.equal(parse(['-n', '5']).values.runs, 5);
  assert.equal(parse(['-n=5']).values.runs, 5);
  assert.equal(parse(['--fit=1e-3']).values.fit, 0.001);
  assert.equal(parse([]).values.fit, undefined);
  assert.throws(() => parse(['--fit', 'big']), /^Error: --fit needs a number, not "big"$/);
  assert.throws(() => parse(['--fit=']), /--fit needs a number, not ""/);
});

test('a value starting with - is the value, unless it is one of the options', () => {
  assert.equal(parse(['--up', '-y']).values.up, '-y');
  assert.equal(parse(['--fit', '-1']).values.fit, -1);
  assert.equal(parse(['-o', '-x.json']).values.out, '-x.json');
  assert.throws(() => parse(['--out', '-h']), /--out needs a value/);
  assert.throws(() => parse(['--out', '--whole']), /--out needs a value \(one starting -- goes as --out=\.\.\.\)/);
  assert.equal(parse(['--out=--whole']).values.out, '--whole');
});

test('repeated, a multiple option collects every value', () => {
  assert.deepEqual(parse(['-r', 'main', '--rev=HEAD', '-r', '.']).values.rev, ['main', 'HEAD', '.']);
});

test('booleans, positionals, and --', () => {
  const { values, positionals } = parse(['a.stl', '--whole', '-h', 'b', '--', '--fit', '-o']);
  assert.equal(values.whole, true);
  assert.equal(values.help, true);
  assert.equal(values.fit, undefined);
  assert.deepEqual(positionals, ['a.stl', 'b', '--fit', '-o']);
});

test('what is wrong, said shortly', () => {
  assert.throws(() => parse(['--bogus']), /^Error: unknown option --bogus$/);
  assert.throws(() => parse(['-q']), /^Error: unknown option -q$/);
  assert.throws(() => parse(['--fit']), /^Error: --fit needs a value$/);
  assert.throws(() => parse(['-o']), /^Error: --out needs a value$/);
  assert.throws(() => parse(['--whole=yes']), /^Error: --whole takes no value$/);
  assert.throws(() => parse(['stray'], {}), /^Error: unexpected argument stray$/);
});

test('commandLine() names the script node was run on, not args.mjs', () => {
  // Under node --test, each test file is the script its process runs.
  const [runtime, script] = commandLine();
  assert.equal(runtime, 'node');
  assert.equal(script, relative(process.cwd(), fileURLToPath(import.meta.url)));
});
