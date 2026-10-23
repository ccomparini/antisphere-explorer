// Tests for the mesh importer, offline: files of our own, local paths and a
// local HTTP server. Run with:
//   node --test tools/import-model.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { writeSTL } from '../public/stl.js';
import { compileScene, isSolid } from '../public/antisphere-scene.js';
import { quadricAt as H } from '../public/quadric.js';
import { fixture, toGLB, toGLTFText } from '../public/gltf-fixture.mjs';

const script = fileURLToPath(new URL('./import-model.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'import-model-'));

/** Run the tool: { status, stdout, stderr }. Asynchronous, so a server in this process can answer it. */
function run(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}
const model = async (args) => {
  const got = await run(args);
  assert.equal(got.status, 0, got.stderr);
  return JSON.parse(got.stdout);
};

// A tetrahedron 2 across, as a PLY and as an STL.
const VERTICES = [[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2]];
const FACES = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
const PLY = `ply
format ascii 1.0
element vertex 4
property float x
property float y
property float z
element face 4
property list uchar int vertex_indices
end_header
${VERTICES.map((v) => v.join(' ')).join('\n')}
${FACES.map((f) => `3 ${f.join(' ')}`).join('\n')}
`;
const STL = Buffer.from(writeSTL(FACES.map((f) => f.map((i) => VERTICES[i]))));

/** A ustar archive of { name: bytes or text } files. */
function tar(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write('0000644\0', 100);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('0', 156);
    header.write('ustar\0' + '00', 257);
    header.write('        ', 148);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const file = (name, content) => { const path = join(scratch, name); writeFileSync(path, content); return path; };

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const CLAY = [0.7, 0.5, 0.4], BRASS = [0.7, 0.6, 0.2];

/**
 * What fills point R of a model, as a scene places it: inside a ball of
 * clay, which it is made of unless it names a material of its own - the
 * albedo there, or null where nothing solid is. By trace()'s rules, from
 * the model down: a ray reaches it through the empty space round it,
 * which forgets the ball's own claim.
 */
function albedoAt(got, R) {
  const built = compileScene({
    materials: { clay: { albedo: CLAY }, brass: { albedo: BRASS } },
    lights: [],
    root: { sphere: { center: [0, 0, 0], radius: 100 }, material: 'clay', inside: got },
  });
  let index = built.nodes[1].inside, found = 0;
  while (index) {
    const nd = built.nodes[index];
    if (H(nd.prim, R) < 0) {
      if (isSolid(built.materials[nd.material])) { if (!found) found = index; } else found = 0;
      if (!nd.inside) break;
      index = nd.inside;
    } else {
      found = 0;
      index = nd.outside;
    }
  }
  return found ? built.materials[built.nodes[found].material].albedo : null;
}

// The tetrahedron as placed - centred over the origin, standing on z = 0 -
// spans x and y from -1 to 1 and z from 0 to 2: its centroid is here.
const INSIDE = [-0.5, -0.5, 0.5];

/** The model alone - a subtree, no scene round it - and solid where the mesh is. */
function checkMesh(got, inside = INSIDE, albedo = CLAY) {
  assert.ok(got.spheroid, 'the mesh\'s bounding spheroid, at the top');
  for (const key of ['objects', 'materials', 'lights', 'camera', 'root']) assert.ok(!(key in got), `no ${key}`);
  assert.deepEqual(albedoAt(got, inside), albedo);
  assert.equal(albedoAt(got, [0.9, 0.9, 1.9]), null, 'outside the slanted face');
}

test('PLY and STL files become models: the mesh alone, as a subtree', async () => {
  checkMesh(await model([file('tet.ply', PLY)]));
  checkMesh(await model([file('wedge.stl', STL)]));
});

test('--fit and --material, as stl-to-scene takes them', async () => {
  // 5 across rather than 2: the centroid 2.5 times as far out.
  const got = await model([file('tet.ply', PLY), '--fit', '5', '--material', 'brass']);
  assert.equal(got.material, 'brass');
  assert.deepEqual(albedoAt(got, INSIDE.map((v) => v * 2.5)), BRASS, 'made of brass, whatever is round it');
  assert.equal(albedoAt(got, [2.3, 2.3, 4.8]), null);
  // With none, it names none, and is made of what is round it.
  assert.ok(!('material' in await model([file('tet.ply', PLY)])));
});

test('--up turns the axis named onto the scene\'s up', async () => {
  // A box 1 by 4 by 1, tall along y: as written it lies 1 high, so solid
  // half a unit up and empty 3.5 up; with --up y (or -y) it stands 4 high,
  // solid at both.
  const v = [[0, 0, 0], [1, 0, 0], [1, 4, 0], [0, 4, 0], [0, 0, 1], [1, 0, 1], [1, 4, 1], [0, 4, 1]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const box = file('post.stl', Buffer.from(writeSTL(quads.flatMap(([a, b, c, d]) => [[v[a], v[b], v[c]], [v[a], v[c], v[d]]]))));
  const standing = (got) => [albedoAt(got, [0, 0, 0.5]) !== null, albedoAt(got, [0, 0, 3.5]) !== null];
  assert.deepEqual(standing(await model([box])), [true, false]);
  for (const up of ['y', '-y']) assert.deepEqual(standing(await model([box, '--up', up])), [true, true], `--up ${up}`);
  assert.deepEqual(standing(await model([box, '--up', 'x'])), [true, false], '--up x: 1 wide, so 1 high');
  assert.match((await run([box, '--up', 'w'])).stderr, /--up w: x, y, z, -x, -y or -z/);
});

test('gzipped, and out of archives: by name after a #, or the one mesh there', async () => {
  checkMesh(await model([file('tet.ply.gz', gzipSync(PLY))]));
  checkMesh(await model([file('wedge.stl.gz', gzipSync(STL))]));
  const archive = file('models.tar.gz', gzipSync(tar({ 'models/readme.txt': 'hello', 'models/scan/tet.ply': PLY, 'models/wedge.stl.gz': gzipSync(STL) })));
  checkMesh(await model([`${archive}#models/scan/tet.ply`]));
  checkMesh(await model([`${archive}#models/wedge.stl.gz`]));
  const one = file('one.tgz', gzipSync(tar({ 'readme.txt': 'hi', 'only/tet.ply': PLY })));
  checkMesh(await model([one]));
  checkMesh(await model([file('plain.tar', tar({ 'tet.ply': PLY }))]));
  const which = await run([archive]);
  assert.equal(which.status, 1);
  assert.match(which.stderr, /holds 2 meshes; name one after a #:\n {2}models\/scan\/tet.ply\n {2}models\/wedge.stl.gz/);
  assert.match((await run([`${archive}#models/nope.ply`])).stderr, /has no models\/nope.ply/);
  assert.match((await run([`${file('tet.ply', PLY)}#x.ply`])).stderr, /is not an archive/);
  assert.match((await run([file('notes.txt', 'hello')])).stderr, /not a mesh this reads/);
});

test('from a URL, http or file', async () => {
  const served = { '/m/tet.ply.gz': gzipSync(PLY), '/m/a.tar.gz': gzipSync(tar({ 'x/wedge.stl': STL })) };
  const server = createServer((req, res) => {
    const body = served[req.url];
    res.writeHead(body ? 200 : 404);
    res.end(body ?? 'not found');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    checkMesh(await model([`${base}/m/tet.ply.gz`]));
    checkMesh(await model([`${base}/m/a.tar.gz#x/wedge.stl`]));
    const missing = await run([`${base}/m/nope.ply`]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /nope.ply: 404/);
  } finally {
    server.close();
  }
  checkMesh(await model([pathToFileURL(file('tet.ply', PLY)).href]));
});

test('-o writes there, gzipped if its name ends .gz; --float32 rounds every number to a float32', async () => {
  const source = file('tet.ply', PLY);
  const plain = join(scratch, 'out/tet.json');
  assert.equal((await run([source, '--fit', '3', '-o', plain])).status, 0);
  const full = JSON.parse(readFileSync(plain, 'utf8'));
  checkMesh(full);
  const zipped = join(scratch, 'out/tet32.json.gz');
  assert.equal((await run([source, '--fit', '3', '--float32', '-o', zipped])).status, 0);
  const text = gunzipSync(readFileSync(zipped)).toString();
  const short = JSON.parse(text);
  checkMesh(short);
  const numbers = (value, out = []) => {
    if (typeof value === 'number') out.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => numbers(v, out));
    return out;
  };
  const before = numbers(full), after = numbers(short);
  assert.equal(after.length, before.length);
  // Each the same float32 as the full number, written as briefly as that allows.
  after.forEach((v, i) => assert.equal(Math.fround(v), Math.fround(before[i]), `number ${i}: ${v} for ${before[i]}`));
  assert.ok(before.some((v, i) => v !== after[i]), 'some were rounded');
  assert.ok(text.match(/\d\.\d{10,}/) === null, 'none written with more digits than a float32 needs');
});

test('what it cannot do, it says', async () => {
  const none = await run([]);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /import-model - convert a mesh/);
  assert.match((await run(['a.ply', '--fit', '-1'])).stderr, /--fit needs a positive number/);
  assert.match((await run(['a.ply', '--bogus'])).stderr, /unknown option --bogus/);
  assert.match((await run(['a.ply', 'b.ply'])).stderr, /one source at a time/);
});

// -- glTF: public/gltf-fixture.mjs's three tubes, up glTF's +y ----------------

test('glTF: a .glb, a .gltf with its buffer in it or beside it - y up made z up, standing on z = 0', async () => {
  const f = fixture();
  // As placed: the tubes up z, centred over the origin, from 0 (the first
  // ring, 0.1 up glTF's y) to 2: inside the first tube, solid; beside it, not.
  const check = (got, what) => {
    assert.deepEqual(albedoAt(got, [0, 0, 0.4]), CLAY, `${what}: inside the first tube`);
    assert.equal(albedoAt(got, [0.5, 0, 0.4]), null, `${what}: beside it`);
  };
  check(await model([file('chain.glb', toGLB(f))]), '.glb');
  check(await model([file('chain.gltf', toGLTFText(f))]), '.gltf, data: URI');
  file('chain.bin', f.bin);
  check(await model([file('beside.gltf', JSON.stringify({ ...f.json, buffers: [{ byteLength: f.bin.length, uri: 'chain.bin' }] }))]),
        '.gltf, its buffer beside it');
  check(await model([file('chain.glb.gz', gzipSync(toGLB(f)))]), 'gzipped');
  check(await model([`${file('models.tar', tar({ 'models/chain.glb': toGLB(f) }))}#models/chain.glb`]), 'in an archive');
  const said = await run([file('chain.glb', toGLB(f))]);
  assert.match(said.stderr, /chain: 192 triangles/);
});

test('glTF: --up z keeps the file\'s own axes - the tubes lying along y - and what isn\'t triangles is skipped, said', async () => {
  // Along y, centred: the first tube's middle, glTF y 0.5, is y -0.6; lying on z = 0, its axis at z 0.2.
  assert.deepEqual(albedoAt(await model([file('flat.glb', toGLB(fixture())), '--up', 'z']), [0, -0.6, 0.2]), CLAY);
  const lines = fixture();
  lines.json.meshes[0].primitives.push({ attributes: { POSITION: 0 }, mode: 1 });
  assert.match((await run([file('lines.glb', toGLB(lines))])).stderr, /192 triangles, and 1 primitives that aren't triangles \(skipped\)/);
});

test('real glTFs from test_models: Box beside its buffer, the Fox at rest', async () => {
  const models = fileURLToPath(new URL('../test_models/', import.meta.url));
  const box = await model([join(models, 'Box/Box.gltf')]);
  assert.deepEqual(box._meta.dimensions, [1, 1, 1]);
  assert.deepEqual(albedoAt(box, [0, 0, 0.5]), CLAY, 'inside the cube, standing on z = 0');
  assert.equal(albedoAt(box, [0, 0, 1.5]), null, 'above it');
  const said = await run([join(models, 'Fox.glb')]);
  assert.equal(said.status, 0, said.stderr);
  assert.match(said.stderr, /Fox: 576 triangles/);
  const [wide, long, tall] = JSON.parse(said.stdout)._meta.dimensions;
  assert.ok(tall > wide && long > tall, `upright, nose to tail along y: ${wide} x ${long} x ${tall}`);
});

// -- --skeleton: a skinned glTF as a model with a skeleton --------------------

const chain = () => file('chain.glb', toGLB(fixture()));

test('--skeleton: a skeleton, an object per bone in its rest pose, and the whole, referring to them within its file', async () => {
  const m = await model([chain(), '--skeleton', 'mesh']);
  assert.deepEqual(m.skeleton.bones.map((b) => [b.name, b.parent]), [['j0', -1], ['j1', 0], ['j2', 1]]);
  assert.ok(m.skeleton.base, 'with its base frame');
  assert.deepEqual(Object.keys(m.objects).sort(), ['j0', 'j1', 'j2', 'model']);
  assert.deepEqual(m.objects.model, { group: ['@#/objects/j0', '@#/objects/j1', '@#/objects/j2'] },
                   'the whole, named "model" on stdout');
  assert.equal(m.objects.j0.material, 'M_Skin', 'mesh: the source\'s own material');
  // Placed in a scene, at rest: j0's tube round the scene's z axis, from 0.1 to 0.9.
  const built = compileScene({ materials: { M_Skin: {} }, lights: [], objects: m.objects, root: { use: 'model' } });
  const solid = (p) => {
    let i = 1, found = 0;
    while (i) {
      const n = built.nodes[i];
      if (H(n.prim, p) < 0) { if (isSolid(built.materials[n.material])) found = found || i; else found = 0; if (!n.inside) break; i = n.inside; }
      else { found = 0; i = n.outside; }
    }
    return !!found;
  };
  assert.equal(solid([0, 0, 0.5]), true, 'inside j0\'s tube');
  assert.equal(solid([0.5, 0, 0.5]), false, 'beside it');
});

test('--skeleton fit-to-mesh and along-bones, of <prefix>-...; --name names the whole', async () => {
  const fitted = await model([chain(), '--skeleton', 'fit-to-mesh', '--prefix', 'robot', '--name', 'chain']);
  assert.deepEqual(Object.keys(fitted.objects).sort(), ['chain', 'j0', 'j1'], 'the thin j2 folded into j1');
  assert.equal(fitted.objects.j0.material, 'robot-skin');
  const along = await model([chain(), '--skeleton', 'along-bones']);
  assert.equal(along.objects.j0.material, 'figure-bone');
  assert.ok(along.objects.j2.sphere, 'the end bone a ball');
  assert.match((await run([chain(), '--skeleton', 'clay'])).stderr, /--skeleton clay: fit-to-mesh, along-bones, mesh/);
});

test('--material-template: the materials named, a library to fill in, coloured as the source colours them', async () => {
  const f = fixture();
  f.json.materials[0].pbrMetallicRoughness = { baseColorFactor: [0.2, 0.4, 0.6, 1] };
  const painted = file('painted.glb', toGLB(f));
  const template = join(scratch, 'template.json');
  const read = () => JSON.parse(readFileSync(template, 'utf8'));
  const fitted = await run([painted, '--skeleton', 'fit-to-mesh', '--prefix', 'robot', '--material-template', template]);
  assert.equal(fitted.status, 0, fitted.stderr);
  assert.match(fitted.stderr, /materials: robot-skin\n/, 'said, whether or not a template is asked for');
  assert.match(fitted.stderr, /template\.json: robot-skin added\n/);
  assert.deepEqual(read()['robot-skin'], { kind: 'lambert', albedo: [0.2, 0.4, 0.6] }, 'the source\'s baseColorFactor');
  assert.match(read()._comment, /painted names/);
  // A scene listing it after its library gets the colour.
  const m = JSON.parse(fitted.stdout);
  const built = compileScene({ materials: ['@lib.json', '@template.json'], lights: [], objects: m.objects, root: { use: 'model' } },
                             { files: { [join(scratch, 'lib.json')]: { clay: {} }, [template]: read() }, path: join(scratch, 'scene.json') });
  assert.ok(built.materials.some((mat) => mat.albedo?.every((v, i) => Math.abs(v - [0.2, 0.4, 0.6][i]) < 1e-6)), 'robot-skin, from the template');

  // Filled in, then imported again or otherwise: what is there is kept, only what it lacks is added.
  writeFileSync(template, JSON.stringify({ ...read(), _comment: 'mine', 'robot-skin': { albedo: [1, 0, 0] } }));
  const along = await run([painted, '--skeleton', 'along-bones', '--material-template', template]);
  assert.match(along.stderr, /figure-bone added\n/);
  assert.deepEqual(read(), { _comment: 'mine', 'robot-skin': { albedo: [1, 0, 0] }, 'figure-bone': { kind: 'lambert', albedo: [0.7, 0.7, 0.7] } },
                   'an uncoloured one grey');
  const again = await run([painted, '--skeleton', 'fit-to-mesh', '--prefix', 'robot', '--material-template', template]);
  assert.match(again.stderr, /nothing to add, 1 already there/);
  assert.deepEqual(read()['robot-skin'], { albedo: [1, 0, 0] });

  // mesh: the source's own names, coloured; a static mesh, --material's.
  const meshed = join(scratch, 'meshed.json');
  await model([painted, '--skeleton', 'mesh', '--material-template', meshed]);
  assert.deepEqual(JSON.parse(readFileSync(meshed, 'utf8')).M_Skin.albedo, [0.2, 0.4, 0.6]);
  const brass = join(scratch, 'brass.json');
  await model([file('tet.ply', PLY), '--material', 'brass', '--material-template', brass]);
  assert.deepEqual(JSON.parse(readFileSync(brass, 'utf8')).brass, { kind: 'lambert', albedo: [0.7, 0.7, 0.7] });
});

test('--material-template: none to write, said; a file there that isn\'t a library, left as it is', async () => {
  const none = join(scratch, 'none.json');
  const plain = await run([file('tet.ply', PLY), '--material-template', none]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stderr, /materials: none/);
  assert.match(plain.stderr, /names no materials, so there are none to write/);
  assert.equal(existsSync(none), false);
  const notes = file('notes.json', 'not JSON');
  const out = join(scratch, 'unwritten.json');
  const refused = await run([chain(), '--skeleton', 'along-bones', '--material-template', notes, '-o', out]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /notes\.json: .*, so it is left as it is/);
  assert.equal(readFileSync(notes, 'utf8'), 'not JSON');
  assert.equal(existsSync(out), false, 'nor the model written');
});

test('--skeleton: --overlap shares a blended band; --fit scales the skeleton too, and records it', async () => {
  const plain = await model([chain(), '--skeleton', 'mesh']), shared = await model([chain(), '--skeleton', 'mesh', '--overlap', '0.3']);
  assert.notDeepEqual(shared.objects.j1, plain.objects.j1, 'j1\'s piece takes in the band it weighs 0.4');
  const fitted = await model([chain(), '--skeleton', 'fit-to-mesh', '--fit', '4']);
  assert.ok(Math.abs(fitted.scale - 2) < 1e-6, `scale ${fitted.scale}: 2 tall (0.1 to 2.1) made 4`);
  assert.deepEqual(fitted.skeleton.bones[1].translation.map((v) => +v.toFixed(6)), [0, 2, 0], 'j1 two up now');
});

test('without --skeleton, a skin is ignored; with it, a file without one is converted as a mesh, said so', async () => {
  const plain = await model([chain()]);
  assert.equal(plain.skeleton, undefined);
  assert.ok(plain.spheroid, 'one tree, wrapped, as before');
  const stl = await run([file('tet.stl', STL), '--skeleton', 'fit-to-mesh']);
  assert.equal(stl.status, 0, stl.stderr);
  assert.match(stl.stderr, /--skeleton: tet has no skin, so it is converted as a mesh/);
  assert.ok(JSON.parse(stl.stdout).spheroid);
});

test('--skeleton on the real skins in test_models: SimpleSkin, the Fox and the mannequin', async () => {
  const models = fileURLToPath(new URL('../test_models/', import.meta.url));
  const simple = await model([join(models, 'SimpleSkin/SimpleSkin.gltf'), '--skeleton', 'along-bones']);
  assert.equal(simple.skeleton.bones.length, 2);
  const fox = await model([join(models, 'Fox.glb'), '--skeleton', 'fit-to-mesh']);
  assert.equal(fox.skeleton.bones.length, 24);
  const wrote = await run([join(models, 'UAL1_Standard.glb'), '--skeleton', 'fit-to-mesh', '-o', join(scratch, 'mannequin.json')]);
  assert.equal(wrote.status, 0, wrote.stderr);
  const written = JSON.parse(readFileSync(join(scratch, 'mannequin.json'), 'utf8'));
  assert.equal(written.skeleton.bones.length, 65);
  assert.equal(Object.keys(written.objects).length, 22 + 1, 'parts on 22 bones, and the whole');
  // Placed by reference in another scene: its whole holds, referring within its file.
  const host = { materials: { 'figure-main': {}, 'figure-joints': {} }, lights: [], root: { use: '@mannequin.json#/objects/mannequin' } };
  const built = compileScene(host, { files: { [join(scratch, 'mannequin.json')]: written }, path: join(scratch, 'host.json') });
  assert.ok(built.nodes.length > 200, `${built.nodes.length} nodes: all of it`);
});
