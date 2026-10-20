// Tests for the tools' option parsing. Run with:
//   node --test tools/args.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

test('commandLine(): the command line as given, a script relative to here, -e\'s arguments as they are', () => {
  const ARGS = pathToFileURL(fileURLToPath(new URL('./args.mjs', import.meta.url))).href;
  const show = `import { commandLine } from ${JSON.stringify(ARGS)}; console.log(JSON.stringify(commandLine()));`;
  // realpathSync here is because on OSX /var (where temp files are put)
  // is a symlink, but cwd() in the subproc will show the canonical path,
  // and we need them to match:
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'command-line-')));
  try {
    mkdirSync(join(dir, 'tools'));
    writeFileSync(join(dir, 'tools/show.mjs'), show);
    const run = (...args) => {
      const out = spawnSync('node', args, { cwd: dir, encoding: 'utf8' });
      assert.equal(out.status, 0, out.stderr);
      return JSON.parse(out.stdout);
    };
    assert.deepEqual(run('tools/show.mjs', '-o', 'x.json'), ['node', 'tools/show.mjs', '-o', 'x.json']);
    assert.deepEqual(run('--no-warnings', join(dir, 'tools/show.mjs'), 'a'), ['node', '--no-warnings', 'tools/show.mjs', 'a'],
                     'node\'s own options; the script relative to here, however it was named');
    assert.deepEqual(run('--input-type=module', '-e', show, 'fruitbats'), ['node', '--input-type=module', '-e', show, 'fruitbats']);
    assert.deepEqual(run('--input-type=module', '-e', show), ['node', '--input-type=module', '-e', show]);
    assert.deepEqual(run('--input-type=module', '-e', show, '/abs/path'), ['node', '--input-type=module', '-e', show, '/abs/path'],
                     'after -e, an argument like a path is left as it is');

    // Only absolute paths to files that exist are made relative.
    const script = (...args) => run('tools/show.mjs', ...args).slice(2);
    assert.deepEqual(script('-r', '.', 'tools/', 'tools/show.mjs'), ['-r', '.', 'tools/', 'tools/show.mjs'], 'relative ones as typed');
    assert.deepEqual(script(dir, join(dir, 'tools'), join(dir, 'tools/show.mjs')), ['.', 'tools', 'tools/show.mjs'],
                     'absolute ones relative to here, here itself "."');
    assert.deepEqual(script('/abs/not/there'), ['/abs/not/there']);
    // What can't be looked up is left alone, not thrown over.
    const long = 'x'.repeat(300);
    assert.deepEqual(script(join(dir, 'tools/show.mjs/x'), `/${long}`), [join(dir, 'tools/show.mjs/x'), `/${long}`],
                     'a path through a file (ENOTDIR), a name too long (ENAMETOOLONG)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
