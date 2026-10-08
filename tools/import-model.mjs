#!/usr/bin/env node
// Convert a mesh - a file or a URL - into a scene, once, so that a scene
// can reference it without converting it every time it loads.
//
//   node tools/import-model.mjs model.stl > model.json
//   node tools/import-model.mjs https://example.com/teapot.ply.gz --fit 2 --material brass -o teapot.json
//   node tools/import-model.mjs \
//     'http://graphics.stanford.edu/pub/3Dscanrep/dragon/dragon_recon.tar.gz#dragon_recon/dragon_vrip.ply' \
//     --name dragon --up y --float32 -o public/scenes/parts/stanford/dragon.json.gz
//
// Reads PLY (ascii or binary) and STL (ascii or binary), either of them
// gzipped, or in a tar archive (gzipped or not) - the file in it named
// after a #, or, if the archive holds only one mesh, that one. The Stanford
// 3D Scanning Repository's models come as such archives:
//
//   bunny   http://graphics.stanford.edu/pub/3Dscanrep/bunny.tar.gz#bunny/reconstruction/bun_zipper.ply
//   dragon  http://graphics.stanford.edu/pub/3Dscanrep/dragon/dragon_recon.tar.gz#dragon_recon/dragon_vrip.ply
//
// They are y up, hence --up y. They are stress tests, taken at full
// resolution, and big - the dragon is 871,414 triangles and takes a couple
// of minutes - so they are not in git: public/scenes/parts/stanford/ is
// gitignored, for converting them into.
//
// What it writes is what tools/stl-to-scene.mjs writes (sceneAroundMesh()):
// a complete scene, the mesh as one object - turned so that --up is up,
// centred on the floor, scaled by --fit - inside a ball of --material,
// with a floor, a sky, lights and a camera, so it opens as it is; and a
// scene that wants the mesh alone references the object:
// "@parts/stanford/dragon.json.gz#/objects/dragon".
// An output name ending .gz is gzipped, which the loaders unzip.
//
// Reports what it found on stderr, and writes the scene on stdout unless
// told where.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readSTL } from '../public/stl.js';
import { readPLY } from '../public/ply.js';
import { meshToTree, treeStats, boundsOf, placeTriangles } from '../public/mesh-import.js';
import { compileScene, sceneAroundMesh } from '../public/antisphere-scene.js';

const USAGE = `
import-model - convert a mesh, from a file or a URL, into a scene

  node tools/import-model.mjs <source> [options]

  <source>             a file or URL: .ply or .stl, either maybe .gz; or a
                       tar archive (.tar, .tar.gz, .tgz) with the file in it
                       after a #: archive.tar.gz#dir/model.ply
  -o, --out <file>     write here instead of stdout; a name ending .gz is
                       gzipped
      --fit <size>     scale the model so its longest side is this
      --material <m>   what the scene makes it of (default "clay")
      --name <n>       the object's name in the scene (default: the file's)
      --up <axis>      which of the file's axes is up: x, y, z (the default)
                       or one of them negated, -y; the model is turned so
                       that it points along +z, the scene's up
      --float32        numbers as float32, in as few digits as give the same
                       float32 back: the GPU works in f32, and a mesh's
                       vertices usually are float32 to begin with
`.trim();

function parseArguments(argv) {
  const options = { material: 'clay' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '-o' || arg === '--out') options.out = next();
    else if (arg === '--fit') {
      options.fit = Number(next());
      if (!(options.fit > 0)) throw new Error('--fit needs a positive number');
    } else if (arg === '--material') options.material = next();
    else if (arg === '--name') options.name = next();
    else if (arg === '--up') {
      options.up = next();
      if (!UP[options.up]) throw new Error(`--up ${options.up}: x, y, z, -x, -y or -z`);
    }
    else if (arg === '--float32') options.float32 = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else rest.push(arg);
  }
  if (rest.length > 1) throw new Error(`one source at a time, not ${rest.length}`);
  options.source = rest[0];
  return options;
}

// Turning the axis named up onto +z, each a rotation (so windings, and
// what is inside, are kept): a quarter turn about x for y, about y for x, a
// half turn about x for -z.
const UP = {
  z: ([x, y, z]) => [x, y, z],
  '-z': ([x, y, z]) => [x, -y, -z],
  y: ([x, y, z]) => [x, -z, y],
  '-y': ([x, y, z]) => [x, z, -y],
  x: ([x, y, z]) => [-z, y, x],
  '-x': ([x, y, z]) => [z, y, -x],
};

const isURL = (path) => /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
const isGzipped = (bytes) => bytes[0] === 0x1f && bytes[1] === 0x8b;
const isTar = (bytes) => new TextDecoder().decode(bytes.subarray(257, 262)) === 'ustar';
const MESH = /\.(ply|stl)$/i;

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
 * The mesh a source names: { name, triangles, degenerate, flipped,
 * openEdges }, `name` the mesh file's, without directories or extensions.
 * Fetched if a URL, read if a file; unzipped if gzipped; taken out of an
 * archive if one, by the member after a #.
 */
async function readSource(source, say) {
  const hash = source.indexOf('#');
  const location = hash < 0 ? source : source.slice(0, hash);
  const member = hash < 0 ? null : decodeURIComponent(source.slice(hash + 1));
  let bytes;
  if (isURL(location) && !location.startsWith('file:')) {
    say(`fetching ${location}`);
    const response = await fetch(location);
    if (!response.ok) throw new Error(`${location}: ${response.status} ${response.statusText}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    bytes = new Uint8Array(readFileSync(location.startsWith('file:') ? fileURLToPath(location) : location));
  }
  let file = location.split(/[?]/)[0].split('/').pop();
  if (isGzipped(bytes)) {
    bytes = new Uint8Array(gunzipSync(bytes));
    file = file.replace(/\.t?gz$/i, (ext) => (ext.toLowerCase() === '.tgz' ? '.tar' : ''));
  }
  if (isTar(bytes)) {
    const files = untar(bytes);
    const meshes = [...files.keys()].filter((name) => MESH.test(name.replace(/\.gz$/i, '')));
    const chosen = member ?? (meshes.length === 1 ? meshes[0] : null);
    if (!chosen) {
      throw new Error(`${location} holds ${meshes.length ? `${meshes.length} meshes` : 'no meshes'}; ` +
                      `name one after a #${meshes.length ? `:\n  ${meshes.join('\n  ')}` : ''}`);
    }
    if (!files.has(chosen)) throw new Error(`${location} has no ${chosen}`);
    bytes = files.get(chosen);
    file = chosen.split('/').pop();
    if (isGzipped(bytes)) {
      bytes = new Uint8Array(gunzipSync(bytes));
      file = file.replace(/\.gz$/i, '');
    }
  } else if (member) {
    throw new Error(`${location} is not an archive, so it has no ${member} in it`);
  }
  const format = file.match(MESH)?.[1]?.toLowerCase();
  if (!format) throw new Error(`${file}: not a mesh this reads - .ply or .stl (maybe .gz, or in an archive)`);
  const read = format === 'ply' ? readPLY(bytes) : readSTL(bytes);
  return { name: file.replace(MESH, ''), ...read };
}

/**
 * A number as float32, written as briefly as gives that float32 back: a
 * double's seventeen digits were half the file.
 */
function asFloat32(x) {
  if (!Number.isFinite(x) || Number.isInteger(x)) return x;
  const f = Math.fround(x);
  for (let digits = 6; digits < 9; digits++) {
    const short = Number(f.toPrecision(digits));
    if (Math.fround(short) === f) return short;
  }
  return Number(f.toPrecision(9));
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help || !options.source) {
    console.log(USAGE);
    process.exit(options.help ? 0 : 1);
  }
  const say = (...parts) => console.error(...parts);

  const read = await readSource(options.source, say);
  say(`${read.name}: ${read.triangles.length} triangles`
      + (read.degenerate ? `, ${read.degenerate} with no area (skipped)` : '')
      + (read.flipped ? `, ${read.flipped} wound backwards (corrected)` : '')
      + (read.openEdges ? `, ${read.openEdges} open edges (what is inside it is partly a guess)` : ''));
  if (!read.triangles.length) throw new Error('nothing to convert');

  const turn = UP[options.up ?? 'z'];
  const upright = options.up && options.up !== 'z' ? read.triangles.map((tri) => tri.map(turn)) : read.triangles;
  const placed = placeTriangles(upright, { fit: options.fit });
  const { lo, hi } = boundsOf(placed);
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);

  const started = Date.now();
  const model = meshToTree(placed);
  if (!model) throw new Error('the mesh produced no geometry');
  const stats = treeStats(model);
  say(`  ${stats.nodes} nodes, depth ${stats.depth}, ${stats.solidLeaves} solid regions`
      + ` (${((Date.now() - started) / 1000).toFixed(1)}s)`);

  const name = options.name ?? read.name;
  const scene = {
    _comment: `${options.source}, converted by tools/import-model.mjs; the mesh alone is objects.${name}.`,
    ...sceneAroundMesh(model, { name, material: options.material, size, bounds: { lo, hi } }),
  };

  // Compile before writing: a scene that will not load is worse than an
  // error here, about a file nobody wrote by hand.
  const built = compileScene(structuredClone(scene));
  say(`  compiles to ${built.nodes.length - 1} nodes`);

  const json = JSON.stringify(scene, options.float32 ? (key, v) => (typeof v === 'number' ? asFloat32(v) : v) : undefined) + '\n';
  if (options.out) {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, /\.gz$/i.test(options.out) ? gzipSync(json, { level: 9 }) : json);
    say(`  written to ${options.out}`);
  } else {
    process.stdout.write(json);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`import-model: ${error.message}`);
  process.exit(1);
});
