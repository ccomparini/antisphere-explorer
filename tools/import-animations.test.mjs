// Tests for the animation importer, on the tiny model in
// public/gltf-fixture.mjs: its one clip, "Bend", turns j1 (LINEAR), steps
// j0 (STEP) and moves j2 (CUBICSPLINE). Run with:
//   node --test tools/import-animations.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGLTF, trackOf, clipRange } from '../public/gltf.js';
import { sampleTrack, angleBetween } from '../public/keyframes.js';
import { fixture, toGLB } from '../public/gltf-fixture.mjs';
import { clipsFromGLTF } from './import-animations.mjs';

const script = fileURLToPath(new URL('./import-animations.mjs', import.meta.url));
const clipsOf = async (options = {}) => clipsFromGLTF(await readGLTF(toGLB(fixture())), options);

test('each clip by bone name, every bone it moves - even one a model might fold away - with its own keys and mode', async () => {
  const { Bend } = await clipsOf();
  assert.equal(Bend.duration, 1);
  assert.equal(Bend.loop, undefined, 'not named _Loop: plays once');
  assert.deepEqual(Object.keys(Bend.channels).sort(), ['j0', 'j1', 'j2'], 'j2, thin, kept: a clip doesn\'t know the model');
  assert.deepEqual(Bend.channels.j1.rotation.times, [0, 1]);
  assert.equal(Bend.channels.j1.rotation.interpolation, undefined, 'linear: the default, not written');
  assert.equal(Bend.channels.j0.translation.interpolation, 'step');
  assert.equal(Bend.channels.j2.translation.interpolation, 'cubic');
  assert.equal(Bend.channels.j2.translation.values[0].length, 3, 'cubic keys: in-tangent, value, out-tangent');
});

test('reduction and resampling', async () => {
  assert.deepEqual((await clipsOf({ fps: 30 })).Bend.channels.j1.rotation.times, [0, 1], 'a resampled slerp reduces to its ends');
  assert.equal((await clipsOf({ fps: 30, rotationTolerance: 0 })).Bend.channels.j1.rotation.times.length, 31);
  assert.equal((await clipsOf({ fps: 30 })).Bend.channels.j2.translation.interpolation, undefined, 'resampled, linear');
  await assert.rejects(clipsOf({ clips: ['Dance'] }), /no animation "Dance"/);
});

test('from the command line: clips alone, no skeleton; how they were made recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-animations-'));
  try {
    writeFileSync(join(dir, 'chain.glb'), toGLB(fixture()));
    const run = (...args) => spawnSync('node', [script, 'chain.glb', ...args], { cwd: dir, encoding: 'utf8' });
    const ok = run('-o', 'anim.json');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stderr, /1 clips, moving 3 bones/);
    const out = JSON.parse(readFileSync(join(dir, 'anim.json'), 'utf8'));
    assert.deepEqual(Object.keys(out), ['_meta', 'clips']);
    assert.deepEqual(out._meta.generatedBy.slice(2), ['chain.glb', '-o', 'anim.json']);
    assert.match(run('--clips', 'Dance').stderr, /import-animations: no animation "Dance"/);
    assert.match(run('--fps', '0').stderr, /--fps needs a positive number/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- real files: test_models/Fox.glb (Khronos) and UAL1_Standard.glb (Quaternius) --

const MODELS = new URL('../test_models/', import.meta.url);
const ROTATION = 0.1 * Math.PI / 180, TRANSLATION = 0.0005;

/**
 * Every key of a clip's source, sampled from its reduced tracks at the key's
 * own time: the worst angle (radians) and distance off, over its channels.
 */
function worstAgainstSource(gltf, animation, clip) {
  const [start] = clipRange(gltf, animation);
  let angle = 0, distance = 0;
  for (const channel of animation.channels) {
    const { node, path } = channel.target;
    const track = clip.channels[gltf.nodes[node].name]?.[path];
    if (!track) continue;                                   // a track at rest throughout: left out
    const source = trackOf(gltf, animation.samplers[channel.sampler]);
    source.times.forEach((t, k) => {
      const want = source.interpolation === 'cubic' ? source.values[k][1] : source.values[k];
      const got = sampleTrack(track, t - start, { rotation: path === 'rotation' });
      if (path === 'rotation') angle = Math.max(angle, angleBetween(got, want));
      else distance = Math.max(distance, Math.hypot(...got.map((v, i) => v - want[i])));
    });
  }
  return { angle, distance };
}

test('the Fox: three clips, by its joints\' names, each source key kept within the tolerances; --loop names the loops', async () => {
  const gltf = await readGLTF(readFileSync(new URL('Fox.glb', MODELS)));
  const clips = clipsFromGLTF(gltf, { loop: ['Walk', 'Run'] });
  assert.deepEqual(Object.keys(clips), ['Survey', 'Walk', 'Run']);
  assert.deepEqual(Object.values(clips).map((c) => +c.duration.toFixed(3)), [3.417, 0.708, 1.158]);
  assert.deepEqual(Object.entries(clips).filter(([, c]) => c.loop).map(([n]) => n), ['Walk', 'Run']);
  const joints = new Set(gltf.json.skins[0].joints.map((j) => gltf.nodes[j].name));
  for (const clip of Object.values(clips)) for (const bone of Object.keys(clip.channels)) assert.ok(joints.has(bone), `${bone}: one of its joints`);
  for (const animation of gltf.json.animations) {
    const { angle, distance } = worstAgainstSource(gltf, animation, clips[animation.name]);
    assert.ok(angle <= ROTATION + 1e-9 && distance <= TRANSLATION + 1e-9, `${animation.name}: ${angle} rad, ${distance} off`);
  }
  assert.deepEqual(Object.values(clipsFromGLTF(gltf, { loop: [] })).filter((c) => c.loop), [], 'none');
});

test('the mannequin: 43 clips moving 55 bones, fingers among them; *_Loop looping; source keys kept within the tolerances', async () => {
  const gltf = await readGLTF(readFileSync(new URL('UAL1_Standard.glb', MODELS)));
  const clips = clipsFromGLTF(gltf);
  assert.equal(Object.keys(clips).length, 43);
  const bones = new Set(Object.values(clips).flatMap((c) => Object.keys(c.channels)));
  assert.equal(bones.size, 55);
  assert.ok(['index_01_l', 'thumb_02_r', 'pinky_03_l'].every((b) => bones.has(b)), 'finger bones, kept for any model that has them');
  assert.equal(Object.values(clips).filter((c) => c.loop).length, 19);
  for (const name of ['Walk_Loop', 'Jump_Start']) {
    const animation = gltf.json.animations.find((a) => a.name === name);
    const { angle, distance } = worstAgainstSource(gltf, animation, clips[name]);
    assert.ok(angle <= ROTATION + 1e-9 && distance <= TRANSLATION + 1e-9, `${name}: ${angle} rad, ${distance} off`);
  }
});

test('sources as import-model takes them: a URL (a .gltf\'s buffer fetched beside it), gzipped, in an archive', async () => {
  // Asynchronous, so a server in this process can answer it.
  const runAsync = (args, cwd) => new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], { cwd });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
  const f = fixture();
  const served = {
    '/models/chain.gltf': JSON.stringify({ ...f.json, buffers: [{ byteLength: f.bin.length, uri: 'chain.bin' }] }),
    '/models/chain.bin': Buffer.from(f.bin),
  };
  const server = createServer((req, res) => {
    const body = served[req.url];
    res.writeHead(body ? 200 : 404);
    res.end(body ?? 'not found');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const dir = mkdtempSync(join(tmpdir(), 'import-animations-'));
  try {
    const bends = (got) => {
      assert.equal(got.status, 0, got.stderr);
      return Object.keys(JSON.parse(got.stdout).clips);
    };
    const url = `http://127.0.0.1:${server.address().port}/models/chain.gltf`;
    assert.deepEqual(bends(await runAsync([url])), ['Bend'], 'over http, its buffer fetched beside it');
    writeFileSync(join(dir, 'chain.glb.gz'), gzipSync(toGLB(f)));
    assert.deepEqual(bends(await runAsync(['chain.glb.gz'], dir)), ['Bend'], 'gzipped');
    writeFileSync(join(dir, 'models.tar'), tar({ 'models/readme.txt': 'hi', 'models/chain.glb': toGLB(f) }));
    assert.deepEqual(bends(await runAsync(['models.tar'], dir)), ['Bend'], 'the one glTF in an archive');
    assert.match((await runAsync([`${url.replace('chain.gltf', 'gone.gltf')}`])).stderr, /404 Not Found/);
    writeFileSync(join(dir, 'tet.stl'), 'solid x\nendsolid x\n');
    assert.match((await runAsync(['tet.stl'], dir)).stderr, /tet.stl: not a glTF - .glb or .gltf/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A tar archive of { name: content } (ustar, as untar() reads). */
function tar(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257); header.write('00', 263);
    let sum = 0; for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
