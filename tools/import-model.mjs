#!/usr/bin/env node
// Convert a mesh - a file or a URL - into a model a scene can reference,
// once, rather than converting it every time it loads.
//
//   node tools/import-model.mjs model.stl > model.json
//   node tools/import-model.mjs https://example.com/teapot.ply.gz --fit 2 --material brass -o teapot.json
//   node tools/import-model.mjs \
//     'http://graphics.stanford.edu/pub/3Dscanrep/dragon/dragon_recon.tar.gz#dragon_recon/dragon_vrip.ply' \
//     --up y --float32 -o public/scenes/parts/stanford/dragon.json.gz
//
// Reads PLY (ascii or binary), STL (ascii or binary) and glTF (.glb, or
// .gltf with its buffers in it or beside it), any of them gzipped, or in a
// tar archive (gzipped or not) - the file in it named after a #, or, if
// the archive holds only one mesh, that one. A glTF is read as a viewer
// shows it: its default scene's meshes, each placed by its node, a skinned
// one at rest; y up, as glTF is, unless --up says otherwise. Its materials
// are not kept, as PLY's and STL's colours aren't. The Stanford
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
// What it writes is the model alone: a subtree, the mesh's planes inside
// its bounding spheroid (meshToTree()), turned so that --up is up, centred
// over the origin and standing on z = 0, and scaled by --fit. A scene
// places it by reference wherever a subtree goes:
//
//   { "sphere": { ... }, "material": "jade",
//     "inside": { "use": "@parts/stanford/dragon.json.gz", "scale": 4 } }
//
// A mesh names no material, so it is made of whatever the node around it
// in the scene names - jade, there - unless --material names one for it,
// which the scene then defines. An output name ending .gz is gzipped,
// which the loaders unzip.
//
// Reports what it found on stderr, and writes the model on stdout unless
// told where.

const VERSION_MAJ = 0;
const VERSION_MIN = 2;

import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { readSTL } from '../public/stl.js';
import { readPLY } from '../public/ply.js';
import { meshToTree, treeStats, boundsOf, placeTriangles } from '../public/mesh-import.js';
import { compileScene } from '../public/antisphere-scene.js';
import { readGLTF, trianglesOf } from '../public/gltf.js';
import { openSource } from './sources.mjs';
import { stringifyJSON } from '../public/fbm-json.js';
import { parseOptions } from './args.mjs';

const USAGE = `
import-model - convert a mesh, from a file or a URL, into a model for scenes

  node tools/import-model.mjs <source> [options]

  <source>             a file or URL: .ply, .stl, .glb or .gltf, maybe .gz;
                       or a tar archive (.tar, .tar.gz, .tgz) with the file
                       in it after a #: archive.tar.gz#dir/model.ply
  -o, --out <file>     write here instead of stdout; a name ending .gz is
                       gzipped
      --fit <size>     scale the model so its longest side is this
      --material <m>   what it is made of: a material the scene using it
                       defines (default: none, so whatever the node around
                       it in the scene names)
      --up <axis>      which of the file's axes is up: x, y, z or one of
                       them negated, -y (default z; y for glTF, whose spec
                       it is); the model is turned so that it points along
                       +z, the scene's up
      --float32        numbers as float32, in as few digits as give the same
                       float32 back: the GPU works in f32, and a mesh's
                       vertices usually are float32 to begin with
      --pretty         make output more readable
`.trim();

const thisScriptName = path.relative(process.cwd(), fileURLToPath(import.meta.url));

function parseArguments(argv) {
  const { values, positionals } = parseOptions(argv, {
    out: { type: 'string', short: 'o' },
    fit: { type: 'number' },
    material: { type: 'string' },
    up: { type: 'string' },
    float32: { type: 'boolean' },
    pretty: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  }, { positionals: true });
  if (values.fit !== undefined && !(values.fit > 0)) throw new Error('--fit needs a positive number');
  if (values.up !== undefined && !UP[values.up]) throw new Error(`--up ${values.up}: x, y, z, -x, -y or -z`);
  if (positionals.length > 1) throw new Error(`one source at a time, not ${positionals.length}`);
  return { ...values, source: positionals[0] };
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

const MESH = /\.(ply|stl|glb|gltf)$/i;

/**
 * The mesh a source names: { name, triangles, degenerate, flipped,
 * openEdges }, `name` the mesh file's, without directories or extensions.
 * Fetched if a URL, read if a file; unzipped if gzipped; taken out of an
 * archive if one, by the member after a # (tools/sources.mjs).
 */
async function readSource(source, say) {
  const { bytes, file, besideIt } = await openSource(source, { kind: MESH, what: 'meshes', say });
  const format = file.match(MESH)?.[1]?.toLowerCase();
  if (!format) throw new Error(`${file}: not a mesh this reads - .ply, .stl, .glb or .gltf (maybe .gz, or in an archive)`);
  if (format === 'glb' || format === 'gltf') {
    // A .gltf's buffers may be files beside it, read from the same place.
    const gltf = await readGLTF(bytes, { readBytes: besideIt, base: '' });
    const { triangles, skipped } = trianglesOf(gltf);
    return { name: file.replace(MESH, ''), triangles, skipped, up: 'y', degenerate: 0, flipped: 0, openEdges: 0 };
  }
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

const float32Converter = (key, val) => (typeof val === 'number' ? asFloat32(val) : val);

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
      + (read.openEdges ? `, ${read.openEdges} open edges (what is inside it is partly a guess)` : '')
      + (read.skipped ? `, and ${read.skipped} primitives that aren't triangles (skipped)` : ''));
  if (!read.triangles.length) throw new Error('nothing to convert');

  const up = options.up ?? read.up ?? 'z';
  const upright = up !== 'z' ? read.triangles.map((tri) => tri.map(UP[up])) : read.triangles;
  const placed = placeTriangles(upright, { fit: options.fit });

  const started = Date.now();
  const model = meshToTree(placed);
  if (!model) throw new Error('the mesh produced no geometry');
  const stats = treeStats(model);
  say(`  ${stats.nodes} nodes, depth ${stats.depth}, ${stats.solidLeaves} solid regions`
      + ` (${((Date.now() - started) / 1000).toFixed(1)}s)`);

  const { lo, hi } = boundsOf(placed);
  const out = {
    _meta: {
      importer:           thisScriptName,
      importerVersionMaj: VERSION_MAJ,
      importerVersionMin: VERSION_MIN,
      importArguments:    argv,
      sourceTricount:     read.triangles.length,
      dimensions:         hi.map((v, i) => +(v - lo[i]).toPrecision(4)),
    },
    ...(options.material ? { material: options.material } : {}),
    ...model,
  };

  // Compile before writing, as a scene would place it: a model that will
  // not load is worse than an error here, about a file nobody wrote by hand.
  const built = compileScene({
    materials: options.material ? { [options.material]: {} } : {},
    lights: [],
    root: structuredClone(out),
  });
  say(`  compiles to ${built.nodes.length - 1} nodes`);

  const filter = options.float32 ? float32Converter : undefined;
  const json = stringifyJSON(out, filter, options.pretty?2:null) + "\n"
  if (options.out) {
    mkdirSync(path.dirname(options.out), { recursive: true });
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
