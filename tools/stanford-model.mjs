#!/usr/bin/env node
// Fetch a model from the Stanford 3D Scanning Repository and convert it
// into a parts file, once, so a scene can import it without converting it
// every time it loads.
//
//   node tools/stanford-model.mjs dragon
//   node tools/stanford-model.mjs dragon --archive dragon_recon.tar.gz -o dragon.json
//
// The models are stress tests, so they are taken at full resolution, and
// they are big: the dragon is 871,414 triangles and takes a minute or so
// to convert. That is why the result is not in git: by default it goes to
// public/scenes/parts/stanford/, which .gitignore leaves out, and a scene
// that wants it imports "parts/stanford/dragon.json" and uses
// "dragon:dragon" (see scenes/dragon.json).
//
// The file written is what an STL import gives (meshAsScene()): one object,
// named for the model, in the model's own coordinates - the scans are y up
// and in metres - and no material, so the scene says what it is made of.

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { meshAsScene } from '../public/antisphere-scene.js';
import { countOpenEdges } from '../public/stl.js';
import { treeStats } from '../public/mesh-import.js';

const REPOSITORY = 'http://graphics.stanford.edu/pub/3Dscanrep';

// Each model: its archive, and the reconstruction in it at full resolution.
const MODELS = {
  bunny: {
    archive: `${REPOSITORY}/bunny.tar.gz`,
    ply: 'bunny/reconstruction/bun_zipper.ply',
    title: 'Stanford Bunny',
  },
  dragon: {
    archive: `${REPOSITORY}/dragon/dragon_recon.tar.gz`,
    ply: 'dragon_recon/dragon_vrip.ply',
    title: 'Stanford Dragon',
  },
};

const PARTS = fileURLToPath(new URL('../public/scenes/parts/stanford/', import.meta.url));

const USAGE = `
stanford-model - fetch a Stanford scan and convert it into a parts file

  node tools/stanford-model.mjs <model> [options]

  models: ${Object.keys(MODELS).join(', ')}

  -o, --out <file>       write here (default public/scenes/parts/stanford/<model>.json)
      --archive <file>   use this .tar.gz instead of downloading it
`.trim();

function parseArguments(argv) {
  const options = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '-o' || arg === '--out') options.out = next();
    else if (arg === '--archive') options.archive = next();
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else rest.push(arg);
  }
  options.model = rest[0];
  return options;
}

/** The files in a tar archive, as a Map of name to bytes. */
function untar(bytes) {
  const files = new Map();
  const text = (at, length) => {
    const field = bytes.subarray(at, at + length);
    const end = field.indexOf(0);
    return new TextDecoder().decode(end < 0 ? field : field.subarray(0, end));
  };
  let at = 0;
  while (at + 512 <= bytes.length && bytes[at] !== 0) {
    const name = text(at, 100);
    const size = parseInt(text(at + 124, 12).trim() || '0', 8);
    const type = text(at + 156, 1);
    const prefix = text(at + 345, 155);
    if (type === '0' || type === '') {
      files.set(prefix ? `${prefix}/${name}` : name, bytes.subarray(at + 512, at + 512 + size));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * An ASCII PLY's faces, as triangles (polygons fanned). The repository's
 * reconstructions are all ASCII, with x, y and z the first three vertex
 * properties and the faces a list of vertex indices.
 */
function readPLY(bytes) {
  const lines = new TextDecoder().decode(bytes).split('\n');
  let i = 0, vertices = 0, faces = 0, format = null;
  for (; i < lines.length && lines[i].trim() !== 'end_header'; i++) {
    const word = lines[i].trim().split(/\s+/);
    if (word[0] === 'format') format = word[1];
    if (word[0] === 'element' && word[1] === 'vertex') vertices = Number(word[2]);
    if (word[0] === 'element' && word[1] === 'face') faces = Number(word[2]);
  }
  if (format !== 'ascii') throw new Error(`a PLY in ${format} format; only ascii is read`);
  i++;
  const v = [];
  for (let k = 0; k < vertices; k++) v.push(lines[i++].trim().split(/\s+/).slice(0, 3).map(Number));
  const triangles = [];
  for (let k = 0; k < faces; k++) {
    const word = lines[i++].trim().split(/\s+/).map(Number);
    for (let j = 2; j < word[0]; j++) triangles.push([v[word[1]], v[word[j]], v[word[j + 1]]]);
  }
  return triangles;
}

async function main(argv) {
  const options = parseArguments(argv);
  const model = MODELS[options.model];
  if (options.help || !model) {
    console.log(USAGE);
    process.exit(options.help ? 0 : 1);
  }
  const name = options.model;
  const say = (...parts) => console.error(...parts);

  let archive;
  if (options.archive) {
    archive = readFileSync(options.archive);
  } else {
    say(`fetching ${model.archive}`);
    const response = await fetch(model.archive);
    if (!response.ok) throw new Error(`${model.archive}: ${response.status} ${response.statusText}`);
    archive = Buffer.from(await response.arrayBuffer());
  }
  const ply = untar(gunzipSync(archive)).get(model.ply);
  if (!ply) throw new Error(`no ${model.ply} in the archive`);

  const triangles = readPLY(ply);
  const open = countOpenEdges(triangles);
  say(`${model.ply}: ${triangles.length} triangles` +
      (open ? `, ${open} open edges (what is inside it is partly a guess)` : ''));

  const started = Date.now();
  const scene = meshAsScene(triangles, name);
  const stats = treeStats(scene.objects[name]);
  say(`  ${stats.nodes} nodes, depth ${stats.depth}` +
      ` (${((Date.now() - started) / 1000).toFixed(1)}s)`);

  const out = options.out ?? `${PARTS}${name}.json`;
  const file = {
    _comment: `${model.title}: ${model.ply} from the Stanford 3D Scanning Repository ` +
              `(${model.archive}), converted by tools/stanford-model.mjs. ` +
              `Generated, and not in git; run that again to remake it.`,
    ...scene,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(file) + '\n');
  say(`  written to ${out}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`stanford-model: ${error.message}`);
  process.exit(1);
});
