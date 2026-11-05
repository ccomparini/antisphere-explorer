#!/usr/bin/env node
// Models with a public source are fetched, not kept in git: this downloads
// each - pinned (Khronos' sample assets by commit) and checked against its
// SHA-256 - and, for a scene model, converts it with tools/import-model.mjs,
// exactly as a person would run it.
//
//   node tools/fetch-models.mjs                    every model that's missing
//   node tools/fetch-models.mjs barramundi teapot  these, if missing
//   node tools/fetch-models.mjs --list             which are there and which missing
//   node tools/fetch-models.mjs --clean [name ...] deleted, not fetched: every one (and
//                                                  all of parts/fetched/), or those
//                                                  named - the next fetch is afresh
//
// Only what is missing is downloaded, so the dragon's couple of minutes
// are paid once.
//
// A scene model's sources go to public/scenes/parts/fetched/sources/ and
// what it is converted to beside them, in public/scenes/parts/fetched/,
// which git ignores; scenes use "@parts/fetched/...". A test model goes
// where the tests read it, in test_models/ (ignored by name); the tests
// fetch what they need when it is missing (ensureModels()), then run
// offline. A download whose checksum is wrong is an error naming both,
// and is kept beside where it would go, as <file>.unverified, to look at:
// the source may have changed, or moved.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IMPORT_MODEL = fileURLToPath(new URL('./import-model.mjs', import.meta.url));

// Khronos' glTF-Sample-Assets, at a commit, so what a test reads can't
// change under it.
const KHRONOS = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/8f492390ddc7a2ae221a1369ef560589cf8c70fb/Models';
const STANFORD = 'http://graphics.stanford.edu/pub/3Dscanrep';
const FETCHED = 'public/scenes/parts/fetched';
const SOURCES = `${FETCHED}/sources`;

/**
 * Each model: its name, where it is from (and its licence), its files -
 * { url, sha256, to } - and, for a scene model, import-model's arguments
 * and what they write (`outputs`), all paths from the repository's root.
 */
export const MODELS = [
  {
    name: 'box',
    about: 'Box, Khronos glTF-Sample-Assets; (c) 2017 Cesium, CC BY 4.0. A test model.',
    files: [
      { url: `${KHRONOS}/Box/glTF/Box.gltf`, to: 'test_models/Box/Box.gltf',
        sha256: '4a0d69eecfce0672a50b71dc218cbacec6c53fe2445040c235c6314b1b2c41b9' },
      { url: `${KHRONOS}/Box/glTF/Box0.bin`, to: 'test_models/Box/Box0.bin',
        sha256: '3266a8e39b9f425b3341cbe5eec7849f44310256bfa651e6b8b40c85ce0ccafb' },
    ],
  },
  {
    name: 'fox',
    about: 'Fox, Khronos glTF-Sample-Assets; model PixelMannen, CC0 1.0; rigging and animation tomkranis, CC BY 4.0; glTF @AsoboStudio and @scurest, CC BY 4.0. A test model.',
    files: [
      { url: `${KHRONOS}/Fox/glTF-Binary/Fox.glb`, to: 'test_models/Fox.glb',
        sha256: 'd97044e701822bac5a62696459b27d7b375aada5de8574ed4362edbba94771f7' },
    ],
  },
  {
    name: 'simple-skin',
    about: 'SimpleSkin, Khronos glTF-Sample-Assets; Marco Hutter, CC0 1.0. A test model.',
    files: [
      ['SimpleSkin.gltf', '8d92e9888340eb98e82a65a1f8b037d9a1d9f09e5fd0b6ba6d40fd93700b3239'],
      ['SimpleSkin_animation.bin', 'ff21b1bc3d0abbe53f7665060ec6c22d873b6e85a7669171a2b6b8ae01c39347'],
      ['SimpleSkin_geometry.bin', '35f0ca6bc07976c0aadc163d4737758989cfcc9870a99800004c4478fe698b63'],
      ['SimpleSkin_inverseBindMatrices.bin', '5844ab221cd2ad367420a248f6387b46e5f8498604427730a37ee96b4d4ec599'],
      ['SimpleSkin_skinningData.bin', '413bc8a8c0da673df767874e6f05f0b00c9261756a08586b9d555bd5535414b5'],
    ].map(([file, sha256]) => ({ url: `${KHRONOS}/SimpleSkin/glTF/${file}`, to: `test_models/SimpleSkin/${file}`, sha256 })),
  },
  {
    name: 'barramundi',
    about: 'Barramundi Fish, Khronos glTF-Sample-Assets; Microsoft, CC0 1.0. Its base colour as a texture atlas.',
    files: [
      { url: `${KHRONOS}/BarramundiFish/glTF-Binary/BarramundiFish.glb`, to: `${SOURCES}/BarramundiFish.glb`,
        sha256: 'ecc3bafb6b00f2c8b810863c388e3768a7b7ea0d0335e8cb8c574c266e571f4a' },
    ],
    import: [`${SOURCES}/BarramundiFish.glb`, '--fit', '2', '--texture-density', '235',
             '-o', `${FETCHED}/barramundi.json`, '--material-template', `${FETCHED}/barramundi-materials.json`],
    outputs: [`${FETCHED}/barramundi.json`, `${FETCHED}/barramundi-texture-atlas.png`, `${FETCHED}/barramundi-materials.json`],
  },
  {
    name: 'teapot',
    about: 'The Utah teapot (solid), Wikimedia Commons; zzubnik (Nik Clark), CC0 1.0.',
    files: [
      { url: 'https://upload.wikimedia.org/wikipedia/commons/9/93/Utah_teapot_%28solid%29.stl', to: `${SOURCES}/teapot.stl`,
        sha256: '0ba068b3ffd2a927b72d5037a163fcc17860bc474c06f0e85a78ad34faccce15' },
    ],
    import: [`${SOURCES}/teapot.stl`, '--fit', '.25', '-o', `${FETCHED}/teapot.json`],
    outputs: [`${FETCHED}/teapot.json`],
  },
  {
    name: 'bunny',
    about: 'The Stanford Bunny, the Stanford 3D Scanning Repository, at full resolution. A stress test.',
    files: [
      { url: `${STANFORD}/bunny.tar.gz`, to: `${SOURCES}/bunny.tar.gz`,
        sha256: 'a5720bd96d158df403d153381b8411a727a1d73cff2f33dc9b212d6f75455b84' },
    ],
    import: [`${SOURCES}/bunny.tar.gz#bunny/reconstruction/bun_zipper.ply`, '--up', 'y', '--float32',
             '-o', `${FETCHED}/stanford/bunny.json.gz`],
    outputs: [`${FETCHED}/stanford/bunny.json.gz`],
  },
  {
    name: 'dragon',
    about: 'The Stanford Dragon, the Stanford 3D Scanning Repository, at full resolution (871,414 triangles, a couple of minutes). A stress test.',
    files: [
      { url: `${STANFORD}/dragon/dragon_recon.tar.gz`, to: `${SOURCES}/dragon_recon.tar.gz`,
        sha256: '74ac1d90989c9b1732edee82d57e9ce71452144cf4355f108d8c9c616d28d02f' },
    ],
    import: [`${SOURCES}/dragon_recon.tar.gz#dragon_recon/dragon_vrip.ply`, '--up', 'y', '--float32',
             '-o', `${FETCHED}/stanford/dragon.json.gz`],
    outputs: [`${FETCHED}/stanford/dragon.json.gz`],
  },
];

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Whether a model is all there: its files, and what it is converted to. */
export const isFetched = (model, root = ROOT) =>
  [...model.files.map((f) => f.to), ...(model.outputs ?? [])].every((p) => existsSync(path.join(root, p)));

// A file downloaded and checked: written where it goes, or, if its sum is
// wrong, kept as .unverified and an error naming both sums.
async function download({ url, sha256, to }, root, say) {
  say(`  ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const where = path.join(root, to), sum = sha256Of(bytes);
  mkdirSync(path.dirname(where), { recursive: true });
  if (sum !== sha256) {
    writeFileSync(`${where}.unverified`, bytes);
    throw new Error(`${url}: its SHA-256 is ${sum}, not ${sha256} as recorded - kept as ${to}.unverified, to look at`);
  }
  // Written aside, then renamed into place - at once - so tests fetching
  // the same file side by side never read half of it.
  writeFileSync(`${where}.${process.pid}.part`, bytes);
  renameSync(`${where}.${process.pid}.part`, where);
}

// import-model, as a person would run it, from the repository's root.
function runImport(args, root, say) {
  return new Promise((done, fail) => {
    say(`  node tools/import-model.mjs ${args.join(' ')}`);
    const child = spawn(process.execPath, [IMPORT_MODEL, ...args], { cwd: root });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => (status === 0 ? done(stderr) : fail(new Error(`import-model: ${stderr.trim().split('\n').pop()}`))));
  });
}

const modelNamed = (name, models) => models.find((m) => m.name === name);
const noModel = (name, models) => `no model "${name}" (${models.map((m) => m.name).join(', ')})`;

/**
 * Delete the models named - their files, what they were converted to, and
 * any download kept as .unverified - so the next fetch is afresh. Every
 * model, if none are named, and all of public/scenes/parts/fetched/ with
 * them, whatever else is in it. What was deleted, as paths from the root.
 */
export function cleanModels(names = [], { models = MODELS, root = ROOT } = {}) {
  const chosen = names.length ? names.map((n) => modelNamed(n, models) ?? (() => { throw new Error(noModel(n, models)); })()) : models;
  const paths = chosen.flatMap((m) => [...m.files.flatMap((f) => [f.to, `${f.to}.unverified`]), ...(m.outputs ?? [])]);
  if (!names.length) paths.push(FETCHED);
  const deleted = paths.filter((p) => existsSync(path.join(root, p)));
  for (const p of deleted) rmSync(path.join(root, p), { recursive: true, force: true });
  return deleted;
}

/**
 * Fetch the models named (and convert them) where they aren't all there.
 * Null if they are all there now, or why not, the first failure, with how
 * to try again. `models` and `root` are for the tests of this.
 */
export async function ensureModels(names, { say = () => {}, models = MODELS, root = ROOT } = {}) {
  for (const name of names) {
    const model = modelNamed(name, models);
    if (!model) return noModel(name, models);
    if (isFetched(model, root)) continue;
    say(`${name}: ${model.about}`);
    try {
      for (const file of model.files) {
        if (!existsSync(path.join(root, file.to))) await download(file, root, say);
      }
      if (model.import) say((await runImport(model.import, root, say)).trim().split('\n').map((l) => `    ${l}`).join('\n'));
    } catch (error) {
      return `${name} not fetched: ${error.message} (node tools/fetch-models.mjs ${name})`;
    }
  }
  return null;
}

const USAGE = `
fetch-models - models with a public source, fetched and converted, not kept in git

  node tools/fetch-models.mjs [name ...]     fetch the models named, or every one,
                                             where missing
      --list                                 which are there and which missing;
                                             fetch nothing
      --clean                                delete them, fetching nothing (no
                                             names: every one, and all of
                                             parts/fetched/); the next fetch is
                                             afresh

  models: ${MODELS.map((m) => m.name).join(', ')}
`.trim();

async function main(argv) {
  const known = ['--list', '--clean', '-h', '--help'];
  const unknown = argv.filter((a) => a.startsWith('-') && !known.includes(a));
  if (unknown.length) throw new Error(`${unknown.join(', ')}? (--help)`);
  if (argv.includes('-h') || argv.includes('--help')) { console.log(USAGE); return; }
  const named = argv.filter((a) => !a.startsWith('-'));
  for (const n of named) if (!modelNamed(n, MODELS)) throw new Error(noModel(n, MODELS));
  if (argv.includes('--list')) {
    for (const m of MODELS) console.log(`${isFetched(m) ? '  fetched' : '  missing'}  ${m.name.padEnd(12)} ${m.about}`);
    return;
  }
  if (argv.includes('--clean')) {
    const deleted = cleanModels(named);
    console.error(deleted.length ? `deleted: ${deleted.join(', ')}` : 'nothing to delete');
    return;
  }
  const names = named.length ? named : MODELS.map((m) => m.name);
  const missing = names.filter((n) => !isFetched(modelNamed(n, MODELS)));
  if (!missing.length) { console.error(`all there: ${names.join(', ')} (--list; --clean, then fetch, for afresh)`); return; }
  const failed = await ensureModels(missing, { say: (...s) => console.error(...s) });
  if (failed) throw new Error(failed);
  console.error(`fetched: ${missing.join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`fetch-models: ${error.message}`);
    process.exit(1);
  });
}
