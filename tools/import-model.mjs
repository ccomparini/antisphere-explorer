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
// --skeleton <mode>, on a glTF with a skin, writes a model with a skeleton
// instead, for clips (tools/import-animations.mjs) to pose:
//
//   { "skeleton": { "base", "bones": [{ "name", "parent", "translation",
//                   "rotation" }, ...] },        every joint's rest pose
//     "scale": s,                                 if --fit scaled it
//     "objects": { "<bone>": ..., ...,            each bone's part, in the
//                                                 rest pose, in scene
//                                                 coordinates
//                  "<name>": { "group": ["@#/objects/<bone>", ...] } } }
//                                                 the whole, at rest
//
// What each bone's part is made of (public/skin.js):
//
//   fit-to-mesh   a spheroid fitted to the vertices the bone weighs most,
//                 per material, fingers folded into mittens
//                 (--min-thickness) - made of <prefix>-<material>
//   along-bones   spheroids from joint to joint, from the skeleton alone -
//                 made of <prefix>-bone
//   mesh          the model's own triangles, each to the bone weighing it
//                 most (or, --overlap, every bone weighing it that much),
//                 each bone's a tree - of the source's own materials. It
//                 compiles slowly for now: a group of overlapping meshes.
//
// --fit scales such a model, skeleton and all, about its origin, and
// records the scale, by which its clips' translations are to be scaled.
//
// Reports what it found on stderr, and writes the model on stdout unless
// told where.

const VERSION_MAJ = 0;
const VERSION_MIN = 3;

import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { readSTL } from '../public/stl.js';
import { readPLY } from '../public/ply.js';
import { meshToTree, treeStats, boundsOf, placeTriangles } from '../public/mesh-import.js';
import { compileScene } from '../public/antisphere-scene.js';
import { readGLTF, trianglesOf } from '../public/gltf.js';
import { skinOf, meshParts, fitToMeshParts, alongBonesParts } from '../public/skin.js';
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

  A glTF with a skin, as a model with a skeleton:
      --skeleton <mode>
                       each bone's part: fit-to-mesh, along-bones or mesh
                       (see above); without, the mesh as one model
      --overlap <w>    mesh: a triangle also goes to every bone weighting
                       one of its vertices at least w (0 to 1)
      --min-thickness <m>
                       fit-to-mesh: a bone thinner than this gives its
                       vertices to its parent (default 0.06: fingers)
      --fit-percentile <p>
                       fit-to-mesh: how much of a bone's vertices its part
                       covers (default 95)
      --prefix <p>     fit-to-mesh, along-bones: materials <p>-... (default
                       "figure")
      --name <n>       the whole model's object (default: the output file's
                       name; on stdout, model)
      --skin <n>       which of the file's skins (default 0)
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
    skeleton: { type: 'string' },
    overlap: { type: 'number' },
    'min-thickness': { type: 'number', default: 0.06 },
    'fit-percentile': { type: 'number', default: 95 },
    prefix: { type: 'string', default: 'figure' },
    name: { type: 'string' },
    skin: { type: 'number', default: 0 },
    help: { type: 'boolean', short: 'h' },
  }, { positionals: true });
  if (values.fit !== undefined && !(values.fit > 0)) throw new Error('--fit needs a positive number');
  if (values.up !== undefined && !UP[values.up]) throw new Error(`--up ${values.up}: x, y, z, -x, -y or -z`);
  if (positionals.length > 1) throw new Error(`one source at a time, not ${positionals.length}`);
  if (values.skeleton !== undefined && !SKELETON_MODES.includes(values.skeleton)) {
    throw new Error(`--skeleton ${values.skeleton}: ${SKELETON_MODES.join(', ')}`);
  }
  if (values.overlap !== undefined && !(values.overlap > 0 && values.overlap <= 1)) throw new Error('--overlap needs a weight, above 0, up to 1');
  if (!(values['min-thickness'] >= 0)) throw new Error('--min-thickness needs a number, 0 or more');
  if (!(values['fit-percentile'] > 50 && values['fit-percentile'] <= 100)) throw new Error('--fit-percentile needs a number above 50, up to 100');
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
const SKELETON_MODES = ['fit-to-mesh', 'along-bones', 'mesh'];

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
    return { name: file.replace(MESH, ''), gltf, triangles, skipped, up: 'y', degenerate: 0, flipped: 0, openEdges: 0 };
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
  if (options.skeleton && read.gltf?.json.skins?.length) {
    const name = options.name ?? (options.out ? path.basename(options.out).replace(/\.json(\.gz)?$/i, '') : 'model');
    return write(options, say, skinnedModel(read, options, name, say, argv));
  }
  if (options.skeleton) say(`  --skeleton: ${read.name} has no skin, so it is converted as a mesh`);
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

  write(options, say, { out, scene: {
    materials: options.material ? { [options.material]: {} } : {},
    lights: [],
    root: structuredClone(out),
  } });
}

/**
 * A model with a skeleton, from a glTF's skin (see the top): { out, scene },
 * the model and a scene placing it whole, at rest, to compile.
 */
function skinnedModel(read, options, name, say, argv) {
  if (options.up && options.up !== 'y') say(`  --up ${options.up}: ignored with --skeleton, whose base turns glTF's y up`);
  const skin = skinOf(read.gltf, options.skin);
  let mode = options.skeleton;
  if (mode !== 'along-bones' && !skin.primitives.length) {
    say('  no mesh is skinned to it: --skeleton along-bones');
    mode = 'along-bones';
  }
  // --fit: scaled about its origin, its skeleton with it.
  let scale = 1;
  const points = skin.primitives.flatMap((p) => p.points);
  if (options.fit && points.length) {
    const { lo, hi } = boundsOf([points]);
    scale = options.fit / Math.max(...hi.map((v, i) => v - lo[i]));
  }
  if (scale !== 1) {
    const times = (v) => v.map((x) => x * scale);
    skin.skeleton.base.translation = times(skin.skeleton.base.translation);
    for (const bone of skin.skeleton.bones) bone.translation = times(bone.translation);
    for (const prim of skin.primitives) prim.points = prim.points.map(times);
    const worldOf = skin.worldOf;
    skin.worldOf = (i) => { const m = Float64Array.from(worldOf(i)); for (const k of [12, 13, 14]) m[k] *= scale; return m; };
  }
  if (mode === 'mesh') say('  --skeleton mesh: slow to compile for now (a group of overlapping meshes)');
  const started = Date.now();
  const parts = mode === 'mesh' ? meshParts(skin, { overlap: options.overlap ?? null })
    : mode === 'fit-to-mesh' ? fitToMeshParts(skin, { minThickness: options['min-thickness'],
                                                       percentile: options['fit-percentile'] / 100, prefix: options.prefix })
    : alongBonesParts(skin, { prefix: options.prefix });
  const objects = {};
  for (const [bone, def] of parts) objects[skin.skeleton.bones[bone].name] = def;
  // The whole, at rest: named so as not to be taken for a bone, its parts
  // referred to within its file, so that it holds wherever it is used.
  let whole = name;
  while (whole in objects) whole = `${whole}-model`;
  objects[whole] = { group: Object.keys(objects).map((part) => `@#/objects/${part}`) };
  say(`${read.name}: a skin of ${skin.skeleton.bones.length} bones, ${parts.size} with ${mode} parts`
      + ` (${((Date.now() - started) / 1000).toFixed(1)}s); the whole as objects.${whole}`);
  const out = {
    _meta: {
      importer:           thisScriptName,
      importerVersionMaj: VERSION_MAJ,
      importerVersionMin: VERSION_MIN,
      importArguments:    argv,
    },
    skeleton: skin.skeleton,
    ...(scale !== 1 ? { scale } : {}),
    objects,
  };
  const materials = new Set();
  JSON.stringify(objects, (key, value) => { if (key === 'material' && typeof value === 'string') materials.add(value); return value; });
  return { out, scene: { materials: Object.fromEntries([...materials].map((m) => [m, {}])), lights: [],
                         objects: structuredClone(objects), root: { use: whole } } };
}

/**
 * Compile `scene` - the model, placed as a scene would place it - and write
 * `out`: a model that will not load is worse than an error here, about a
 * file nobody wrote by hand.
 */
function write(options, say, { out, scene }) {
  const built = compileScene(scene);
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
