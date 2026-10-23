#!/usr/bin/env node
// Import a glTF's animations as a library of clips, for any model whose
// bones are named as the file's are.
//
//   node tools/import-animations.mjs test_models/UAL1_Standard.glb -o ual.json
//   node tools/import-animations.mjs model.glb --clips Walk_Loop,Idle_Loop -o walk.json
//   node tools/import-animations.mjs \
//     https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Fox/glTF-Binary/Fox.glb \
//     --loop Walk,Run -o fox.json
//
// The source is a file or a URL, maybe gzipped, or in a tar archive (the
// file in it named after a #) - as tools/import-model.mjs takes them
// (tools/sources.mjs); a .gltf's buffers beside it are read from the same
// place.
//
// Each clip keeps its source's keys - each bone's local rotation, and the
// translation of the bones that move (a walk's pelvis) - keyframed
// (public/keyframes.js), every bone the source animates kept, fingers and
// all: a model without them passes them over. Keys interpolation reproduces
// within --rotation-tolerance and --translation-tolerance are dropped, or
// the clips are resampled at --fps. A track that never leaves its bone's
// rest is left out: a bone a clip doesn't move stays at its model's rest.
// glTF doesn't say which clips loop: --loop names them, or by default a
// clip named *_Loop loops. glTF has no markers, so none are imported.
//
// Reports on stderr; writes the clips on stdout unless told where.

const VERSION_MAJ = 0;
const VERSION_MIN = 1;

import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { readGLTF, trackOf, clipRange } from '../public/gltf.js';
import { sampleTrack, reduceTrack } from '../public/keyframes.js';
import { parseOptions, commandLine } from './args.mjs';
import { openSource } from './sources.mjs';

const GLTF = /\.(glb|gltf)$/i;

const USAGE = `
import-animations - a glTF's animations as a library of keyframed clips

  node tools/import-animations.mjs <source> [options]

  <source>                  a .glb or .gltf, a file or a URL, maybe .gz; or a
                            tar archive with the file in it after a #:
                            archive.tar.gz#dir/model.glb

  -o, --out <file>          write here instead of stdout; a name ending .gz
                            is gzipped
      --clips <a,b,...>     which animations to keep (default all)
      --rotation-tolerance <degrees>
                            drop the keys interpolation reproduces this
                            closely (default 0.1; 0 keeps every key)
      --translation-tolerance <metres>
                            the same for translations (default 0.0005)
      --fps <n>             resample the clips at this rate, rather than
                            keeping their own keys
      --loop <a,b,...>      the clips that loop (default: those named *_Loop;
                            none for no clip)
      --pretty              make the output more readable
`.trim();

function parseArguments(argv) {
  const { values, positionals } = parseOptions(argv, {
    out: { type: 'string', short: 'o' },
    clips: { type: 'string' },
    'rotation-tolerance': { type: 'number', default: 0.1 },
    'translation-tolerance': { type: 'number', default: 0.0005 },
    fps: { type: 'number' },
    loop: { type: 'string' },
    pretty: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  }, { positionals: true });
  if (positionals.length > 1) throw new Error(`one source at a time, not ${positionals.length}`);
  if (values.fps !== undefined && !(values.fps > 0)) throw new Error('--fps needs a positive number');
  for (const key of ['rotation-tolerance', 'translation-tolerance']) {
    if (!(values[key] >= 0)) throw new Error(`--${key} needs a number, 0 or more`);
  }
  return {
    source: positionals[0], out: values.out, pretty: values.pretty, help: values.help, fps: values.fps ?? null,
    clips: values.clips?.split(',').map((s) => s.trim()).filter(Boolean),
    loop: values.loop === undefined ? null : values.loop.trim() === 'none' ? [] : values.loop.split(',').map((s) => s.trim()).filter(Boolean),
    rotationTolerance: values['rotation-tolerance'] * Math.PI / 180, translationTolerance: values['translation-tolerance'],
  };
}

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot4 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

/**
 * A glTF's animations as clips: { name: { duration, loop, channels: {
 * bone: { rotation, translation } } } }, bones by their nodes' names.
 * Options: clips (names), rotationTolerance (radians), translationTolerance
 * (metres), fps (to resample), loop (the names of the clips that loop; by
 * default, those named *_Loop), warn.
 */
export function clipsFromGLTF(gltf, { clips: wanted, rotationTolerance = 0.1 * Math.PI / 180,
                                      translationTolerance = 0.0005, fps = null, loop = null, warn = console.warn } = {}) {
  const json = gltf.json;
  const named = (json.animations ?? []).map((a, i) => [a.name ?? `animation${i}`, a]);
  for (const name of [...(wanted ?? []), ...(loop ?? [])]) if (!named.some(([n]) => n === name)) throw new Error(`no animation "${name}"`);
  const loops = (name) => (loop ? loop.includes(name) : /_loop$/i.test(name));
  const clips = {};
  for (const [clipName, animation] of named) {
    if (wanted && !wanted.includes(clipName)) continue;
    const [start, end] = clipRange(gltf, animation);
    const channels = {};
    let scaled = false;
    for (const channel of animation.channels) {
      const node = channel.target.node, path = channel.target.path;
      if (node === undefined) continue;
      const source = trackOf(gltf, animation.samplers[channel.sampler]);
      if (path === 'scale') {
        if (source.values.flat(2).some((v) => Math.abs(v - 1) > 1e-3)) scaled = true;
        continue;
      }
      if (path !== 'rotation' && path !== 'translation') continue;
      const rotation = path === 'rotation';
      // The source's keys, from the clip's start; or resampled.
      let track = { times: source.times.map((t) => t - start), values: source.values, interpolation: source.interpolation };
      if (fps) {
        const n = Math.max(1, Math.round((end - start) * fps) + 1);
        const times = Array.from({ length: n }, (_, f) => Math.min(f / fps, end - start));
        track = { times, values: times.map((t) => sampleTrack(source, t + start, { rotation })), interpolation: 'linear' };
      }
      // A track that never leaves its node's rest is no track at all.
      const rest = gltf.rest(node)[path];
      const values = track.interpolation === 'cubic' ? track.values.map((v) => v[1]) : track.values;
      const atRest = rotation
        ? values.every((q) => Math.abs(Math.abs(dot4(q, rest)) - 1) < 1e-9)
        : values.every((t) => Math.hypot(...sub(t, rest)) < 1e-5);
      if (atRest) continue;
      track = reduceTrack(track, rotation ? rotationTolerance : translationTolerance, { rotation });
      if (track.interpolation === 'linear') delete track.interpolation;   // the default
      (channels[json.nodes[node].name ?? `node${node}`] ??= {})[path] = track;
    }
    if (scaled) warn(`${clipName}: scales a bone, which a clip doesn't keep`);
    clips[clipName] = { duration: end - start, ...(loops(clipName) ? { loop: true } : {}), channels };
  }
  return clips;
}

// Numbers in as few digits as a float32 holds, which is all the file had.
const shorter = (key, value) => (typeof value === 'number' && !Number.isInteger(value) ? +value.toPrecision(7) : value);

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help || !options.source) {
    console.log(USAGE);
    process.exit(options.help ? 0 : 1);
  }
  const say = (...parts) => console.error(...parts);
  const { bytes, file, besideIt } = await openSource(options.source, { kind: GLTF, what: 'glTF files', say });
  if (!GLTF.test(file)) throw new Error(`${file}: not a glTF - .glb or .gltf (maybe .gz, or in an archive)`);
  const gltf = await readGLTF(bytes, { readBytes: besideIt, base: '' });
  const clips = clipsFromGLTF(gltf, { ...options, warn: (msg) => say(`  ${msg}`) });
  const bones = new Set(Object.values(clips).flatMap((c) => Object.keys(c.channels)));
  say(`${file}: ${Object.keys(clips).length} clips, moving ${bones.size} bones`);
  const out = {
    _meta: {
      generatedBy: commandLine(),
      generatorVersionMaj: VERSION_MAJ,
      generatorVersionMin: VERSION_MIN,
      source: file,
    },
    clips,
  };
  const json = JSON.stringify(out, shorter, options.pretty ? 1 : 0) + '\n';
  if (options.out) {
    mkdirSync(path.dirname(options.out), { recursive: true });
    writeFileSync(options.out, /\.gz$/i.test(options.out) ? gzipSync(json, { level: 9 }) : json);
    say(`  written to ${options.out} (${(json.length / 1024).toFixed(0)} KB of JSON)`);
  } else {
    process.stdout.write(json);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`import-animations: ${error.message}`);
    process.exit(1);
  });
}
