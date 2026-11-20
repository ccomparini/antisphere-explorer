#!/usr/bin/env node
// Precompile an object: compile it once, as a "use" of it would, and write
// its nodes, so a scene using it reads them instead of compiling it again
// (compiled-format.md, "A precompiled object").
//
//   node tools/precompile.mjs public/scenes/parts/fetched/stanford/dragon.json.gz
//   node tools/precompile.mjs public/scenes/parts/bolt.json#/objects/bolt -o bolt.qssp
//
// Writes beside the source by default, named for it: dragon.json.gz ->
// dragon.qssp.gz (gzipped, as the name says). A scene then uses it as it
// used the source: "use": "@parts/fetched/stanford/dragon.qssp.gz".

import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { loadReferences, precompileObject, isGzip } from '../public/antisphere-scene.js';
import { encodeQSSP } from '../public/qssp.js';
import { parseOptions } from './args.mjs';

const USAGE = `
precompile - compile an object once, for scenes to use without compiling it

  node tools/precompile.mjs <file>[#/pointer] [options]

  <file>            the object: a .json (or a part of one, by #/pointer),
                    a mesh's tree (.json.gz), or an .stl
  -o, --out <file>  write here; by default beside the source, as
                    <name>.qssp.gz. Ending .gz, it is gzipped.
`.trim();

function main(argv) {
  const { values, positionals } = parseOptions(argv, {
    out: { type: 'string', short: 'o' },
    help: { type: 'boolean', short: 'h' },
  }, { positionals: true });
  const source = positionals[0];
  if (values.help || !source) {
    console.log(USAGE);
    process.exit(source ? 0 : 1);
  }
  return run(source, values.out);
}

async function run(source, out) {
  const [file, pointer] = source.split('#');
  const dir = path.dirname(path.resolve(file));
  // Read as a scene beside it would read it: by reference, from its directory.
  const from = path.join(dir, 'precompile.json');
  const reference = `@${path.basename(file)}${pointer ? `#${pointer}` : ''}`;
  const say = (...parts) => console.error(...parts);
  let started = performance.now();
  const files = await loadReferences({ use: reference }, {
    from, readText: (p) => readFileSync(p, 'utf8'), readBytes: (p) => readFileSync(p),
    warn: (msg) => { throw new Error(msg); },
  });
  say(`${source}: read (${((performance.now() - started) / 1000).toFixed(1)} s)`);
  started = performance.now();
  const object = precompileObject(reference, { files, path: from, warn: (where, msg) => say(`  warning: ${where}: ${msg}`) });
  const { manifest } = object;
  say(`  ${manifest.nodes} nodes, ${manifest.surfaces} surfaces, ${manifest.materials.length} materials`
      + `${manifest.reach ? '' : ', no reach'} (${((performance.now() - started) / 1000).toFixed(1)} s)`);

  out ??= path.join(dir, `${path.basename(file).replace(/(\.json|\.stl)?(\.gz)?$/i, '')}${pointer ? `-${pointer.split('/').pop()}` : ''}.qssp.gz`);
  manifest.generator = 'tools/precompile.mjs';
  manifest.source = path.relative(path.dirname(path.resolve(out)), path.resolve(file)) + (pointer ? `#${pointer}` : '');
  const bytes = encodeQSSP(object);
  const written = isGzip(out) ? gzipSync(bytes) : bytes;
  writeFileSync(out, written);
  say(`  written to ${out}: ${(written.length / 1e6).toFixed(1)} MB${isGzip(out) ? ` (${(bytes.length / 1e6).toFixed(1)} MB unzipped)` : ''}`);
}

main(process.argv.slice(2))?.catch?.((error) => {
  console.error(`precompile: ${error.message}`);
  process.exit(1);
});
