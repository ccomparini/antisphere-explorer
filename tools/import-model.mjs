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
// A glTF (.glb or .gltf) is read too, turned z up from its y up. One with a
// skin is a model with a skeleton, unless --no-skeleton: its bones, rest
// pose and all (public/skin.js), and an object for each bone with geometry
// - named for the bone, in the rest pose, in scene coordinates - and one
// for the whole, named for the file it is written to, at rest. A clip
// (tools/import-animations.mjs) poses it (public/figure.js). What each
// bone's object is made of, --parts:
//
//   mesh      the model's own triangles, each to the bone weighting it most
//             (or, --overlap, every bone weighting it that much), each
//             bone's a tree - made of the source's own materials
//   spheroid  a spheroid fitted to each bone's vertices, per material,
//             fingers folded into mittens (--min-thickness): light, for
//             trying a clip - made of <prefix>-<material>
//   bones     spheroids along the bones themselves, needing no geometry -
//             made of <prefix>-bone
//
// --fit scales a model with a skeleton about its origin, skeleton and all,
// and records the scale, by which its clips' translations are scaled.
//
// Reports what it found on stderr, and writes the model on stdout unless
// told where.

const VERSION_MAJ = 0;
const VERSION_MIN = 3;

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readSTL } from '../public/stl.js';
import { readPLY } from '../public/ply.js';
import { meshToTree, treeStats, boundsOf, placeTriangles } from '../public/mesh-import.js';
import { compileScene } from '../public/antisphere-scene.js';
import { readGLTF, compose, multiply, transformPoint } from '../public/gltf.js';
import { skinOf, meshParts, spheroidParts, boneParts, Y_UP_TO_Z_UP } from '../public/skin.js';
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
      --up <axis>      which of the file's axes is up: x, y, z (the default)
                       or one of them negated, -y; the model is turned so
                       that it points along +z, the scene's up
      --float32        numbers as float32, in as few digits as give the same
                       float32 back: the GPU works in f32, and a mesh's
                       vertices usually are float32 to begin with
      --pretty         make output more readable

  A glTF with a skin:
      --no-skeleton    just its geometry, at rest, as one model
      --parts <how>    each bone's object: mesh (the default), spheroid or
                       bones (see above)
      --overlap <w>    mesh: a triangle also goes to every bone weighting
                       one of its vertices at least w (0 to 1)
      --min-thickness <m>
                       spheroid: a bone thinner than this gives its vertices
                       to its parent (default 0.06: fingers into hands)
      --fit-percentile <p>
                       spheroid: how much of a bone's vertices its part
                       covers (default 95)
      --prefix <p>     spheroid, bones: materials are <p>-... (default
                       "figure")
      --name <n>       the whole model's object (default: the output
                       file's name; on stdout, model)
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
    'no-skeleton': { type: 'boolean' },
    parts: { type: 'string', default: 'mesh' },
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
  if (!['mesh', 'spheroid', 'bones'].includes(values.parts)) throw new Error(`--parts ${values.parts}: mesh, spheroid or bones`);
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

const isURL = (path) => /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
const isGzipped = (bytes) => bytes[0] === 0x1f && bytes[1] === 0x8b;
const isTar = (bytes) => new TextDecoder().decode(bytes.subarray(257, 262)) === 'ustar';
const MESH = /\.(ply|stl|glb|gltf)$/i;

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
  if (!format) throw new Error(`${file}: not a mesh this reads - .ply, .stl, .glb or .gltf (maybe .gz, or in an archive)`);
  if (format === 'glb' || format === 'gltf') {
    // A .gltf's sidecar buffers, beside it, if it is a local file.
    const dir = isURL(location) ? null : path.dirname(location);
    const gltf = await readGLTF(bytes, { readBytes: dir ? async (p) => readFileSync(p) : undefined, base: dir ? `${dir}/` : '' });
    return { name: file.replace(MESH, ''), gltf };
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

/**
 * Every triangle of a glTF at rest, in scene coordinates (z up): skinned
 * meshes as their skins pose them, the rest as their nodes place them.
 */
function trianglesOfGLTF(gltf) {
  const triangles = [];
  (gltf.json.skins ?? []).forEach((_, i) => {
    for (const { points, triangles: tris } of skinOf(gltf, i).primitives) {
      for (const [a, b, c] of tris) triangles.push([points[a], points[b], points[c]]);
    }
  });
  const world = gltf.worldMatrices(), toScene = compose({ rotation: Y_UP_TO_Z_UP });
  gltf.json.nodes.forEach((node, n) => {
    if (node.mesh === undefined || node.skin !== undefined) return;
    const m = multiply(toScene, world[n]);
    for (const prim of gltf.json.meshes[node.mesh].primitives) {
      if ((prim.mode ?? 4) !== 4 || prim.attributes.POSITION === undefined) continue;
      const pos = gltf.accessor(prim.attributes.POSITION);
      const at = (v) => transformPoint(m, [pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]]);
      const order = prim.indices === undefined ? Array.from({ length: pos.length / 3 }, (_, i) => i) : gltf.accessor(prim.indices);
      for (let i = 0; i + 2 < order.length; i += 3) triangles.push([at(order[i]), at(order[i + 1]), at(order[i + 2])]);
    }
  });
  return triangles;
}

/**
 * A model with a skeleton, from a glTF's skin: { skeleton, scale, objects },
 * an object per bone with geometry and one for the whole (see the top).
 */
function skinnedModel(gltf, options, name, say) {
  const skin = skinOf(gltf, options.skin);
  // --fit: the model scaled about its origin, its skeleton with it.
  let scale = 1;
  if (options.fit) {
    const points = skin.primitives.flatMap((p) => p.points);
    if (points.length) {
      const { lo, hi } = boundsOf([points]);
      scale = options.fit / Math.max(...hi.map((v, i) => v - lo[i]));
    }
  }
  if (scale !== 1) {
    const times = (v) => v.map((x) => x * scale);
    skin.skeleton.base.translation = times(skin.skeleton.base.translation);
    for (const bone of skin.skeleton.bones) bone.translation = times(bone.translation);
    for (const prim of skin.primitives) prim.points = prim.points.map(times);
    const worldOf = skin.worldOf;
    skin.worldOf = (i) => { const m = Float64Array.from(worldOf(i)); for (const k of [12, 13, 14]) m[k] *= scale; return m; };
  }
  const how = skin.primitives.length ? options.parts : 'bones';
  if (how !== options.parts) say(`  no mesh is skinned to it: --parts bones`);
  const parts = how === 'mesh' ? meshParts(skin, { overlap: options.overlap ?? null })
    : how === 'spheroid' ? spheroidParts(skin, { minThickness: options['min-thickness'],
                                                  percentile: options['fit-percentile'] / 100, prefix: options.prefix })
    : boneParts(skin, { prefix: options.prefix });
  const objects = {};
  for (const [bone, def] of parts) objects[skin.skeleton.bones[bone].name] = def;
  // The whole, at rest: named so as not to be taken for a bone.
  let whole = name;
  while (whole in objects) whole = `${whole}-model`;
  objects[whole] = { group: Object.keys(objects) };
  say(`  ${skin.skeleton.bones.length} bones, ${parts.size} with ${how} parts; the whole as objects.${whole}`);
  return { skeleton: skin.skeleton, ...(scale !== 1 ? { scale } : {}), objects, whole };
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help || !options.source) {
    console.log(USAGE);
    process.exit(options.help ? 0 : 1);
  }
  const say = (...parts) => console.error(...parts);

  const read = await readSource(options.source, say);
  const meta = {
    importer:           thisScriptName,
    importerVersionMaj: VERSION_MAJ,
    importerVersionMin: VERSION_MIN,
    importArguments:    argv,
  };
  let out, scene;
  if (read.gltf && read.gltf.json.skins?.length && !options['no-skeleton']) {
    // A model with a skeleton.
    const name = options.name ?? (options.out ? path.basename(options.out).replace(/\.json(\.gz)?$/i, '') : 'model');
    say(`${read.name}: a skin`);
    const started = Date.now();
    const { whole, ...model } = skinnedModel(read.gltf, options, name, say);
    say(`  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    out = { _meta: meta, ...model };
    // To compile it: the whole, at rest, its materials whatever they are.
    const materials = new Set();
    JSON.stringify(model.objects, (key, value) => { if (key === 'material' && typeof value === 'string') materials.add(value); return value; });
    scene = { materials: Object.fromEntries([...materials].map((m) => [m, {}])), lights: [],
              objects: structuredClone(model.objects), root: { use: whole } };
  } else {
    if (read.gltf) read.triangles = trianglesOfGLTF(read.gltf);
    say(`${read.name}: ${read.triangles.length} triangles`
        + (read.degenerate ? `, ${read.degenerate} with no area (skipped)` : '')
        + (read.flipped ? `, ${read.flipped} wound backwards (corrected)` : '')
        + (read.openEdges ? `, ${read.openEdges} open edges (what is inside it is partly a guess)` : ''));
    if (!read.triangles.length) throw new Error('nothing to convert');

    const turn = UP[options.up ?? 'z'];
    const upright = options.up && options.up !== 'z' ? read.triangles.map((tri) => tri.map(turn)) : read.triangles;
    const placed = placeTriangles(upright, { fit: options.fit });

    const started = Date.now();
    const model = meshToTree(placed);
    if (!model) throw new Error('the mesh produced no geometry');
    const stats = treeStats(model);
    say(`  ${stats.nodes} nodes, depth ${stats.depth}, ${stats.solidLeaves} solid regions`
        + ` (${((Date.now() - started) / 1000).toFixed(1)}s)`);

    const { lo, hi } = boundsOf(placed);
    out = {
      _meta: { ...meta, sourceTricount: read.triangles.length, dimensions: hi.map((v, i) => +(v - lo[i]).toPrecision(4)) },
      ...(options.material ? { material: options.material } : {}),
      ...model,
    };
    scene = { materials: options.material ? { [options.material]: {} } : {}, lights: [], root: structuredClone(out) };
  }

  // Compile before writing, as a scene would place it: a model that will
  // not load is worse than an error here, about a file nobody wrote by hand.
  const built = compileScene(scene);
  say(`  compiles to ${built.nodes.length - 1} nodes`);

  const filter = options.float32 ? float32Converter : undefined;
  const json = stringifyJSON(out, filter, options.pretty?2:null) + "\n"
  if (options.out) {
    mkdirSync(path.dirname(options.out), { recursive: true });
    writeFileSync(options.out, /\.gz$/i.test(options.out) ? gzipSync(json, { level: 9 }) : json);
    say(`  written to ${options.out} (${(json.length / 1024).toFixed(0)} KB of JSON)`);
  } else {
    process.stdout.write(json);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`import-model: ${error.message}`);
  process.exit(1);
});
