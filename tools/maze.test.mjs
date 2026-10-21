// Tests for the maze scene writer. Run with:
//   node --test tools/maze.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileScene } from '../public/antisphere-scene.js';
import { mazeScene } from './maze.mjs';

const script = fileURLToPath(new URL('./maze.mjs', import.meta.url));
// Where a scene written on stdout finds lib/maze_defaults.json: run from here.
const SCENES = fileURLToPath(new URL('../public/scenes/', import.meta.url));
const DEFAULTS = JSON.parse(readFileSync(join(SCENES, 'lib/maze_defaults.json'), 'utf8'));
// A scene as the default library makes it: compiled as if in public/scenes.
const compiled = (scene) => compileScene(structuredClone(scene),
  { files: { 'scenes/lib/maze_defaults.json': DEFAULTS }, path: 'scenes/maze.json' });

test('writes a complete scene that compiles, on stdout', () => {
  const scene = JSON.parse(execFileSync('node', [script, '--seed', '4', '--rings', '3'],
                                        { cwd: SCENES, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.ok(scene.camera && scene.lights.length && scene.objects.maze.cylinder);
  assert.equal(scene.materials, '@lib/maze_defaults.json', 'its materials are the defaults library');
  const built = compiled(scene);
  assert.ok(built.nodes.length > 20, `${built.nodes.length} nodes`);
});

test('the defaults library defines what the scene names by default, and an ambient light for --material-ambient', () => {
  for (const part of ['default', 'floor', 'sky', 'dusk', 'night']) assert.ok(`maze-${part}` in DEFAULTS, part);
  const { scene } = mazeScene({ rings: 3, sun: 0.4, materialAmbient: 'maze-dusk' });
  assert.equal(scene.materials, '@lib/maze_defaults.json', 'the scene defines nothing, dusk included');
  assert.equal(scene.root.material, 'maze-dusk', 'the ambient light fills the scene\'s outermost node');
  assert.equal(mazeScene({ rings: 3, sun: 0.4 }).scene.root.material, undefined, 'without --material-ambient, none: the renderer\'s own');
  const built = compiled(scene);
  assert.equal(built.materials[built.nodes[1].material].name, 'maze-dusk');
  // The sun's light dims with --sun; the ambient light is --material-ambient's alone.
  assert.ok(scene.lights[0].color[0] < mazeScene({ rings: 3 }).scene.lights[0].color[0]);
});

test('options reach the maze', () => {
  const { maze, scene } = mazeScene({ seed: 2, rings: 4, wallHeight: 3, wallThickness: 0.3, materialDefault: 'brick' });
  assert.equal(new Set(maze.cells.map((c) => c.ring)).size, 4);
  const walls = JSON.stringify(scene.objects.maze);
  assert.equal(walls.includes('"material":"brick"'), true);
  assert.ok(walls.includes('"offset":3}'), 'the tops are at 3: the walls are 3 tall');
});

test('a bad option is refused', () => {
  const run = spawnSync('node', [script, '--rings', 'many'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--rings needs a number/);
});

test('the hub radius is an option, and doorways that cannot fit are refused', () => {
  const { maze } = mazeScene({ hallWidth: 4, innerRadius: 8 });
  assert.equal(maze.hub.radius, 8);
  assert.equal(mazeScene({ hallWidth: 4 }).maze.hub.radius, 5, 'by default 1.25 hall widths');
  const run = spawnSync('node', [script, '--hall-width', '4', '--inner-radius', '1.5'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /does not fit in wall 0.*make innerRadius larger/);
});

// The materials of a maze's faces, by part: the floor is the plane at 0,
// tops the other planes, doorways complemented slabs.
function partsOf(tree) {
  const seen = { top: new Set(), door: new Set(), wall: new Set(), floor: new Set() };
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.material) {
      const part = n.plane ? (n.plane.offset === 0 ? 'floor' : 'top') : n.slab?.complement ? 'door' : 'wall';
      seen[part].add(n.material);
    }
    walk(n.inside); walk(n.outside);
  };
  walk(tree);
  return Object.fromEntries(Object.entries(seen).map(([part, names]) => [part, [...names]]));
}

test('materials are named after the prefix: the walls, doorways and tops share maze-default', () => {
  const { scene } = mazeScene({ rings: 3 });
  assert.deepEqual(partsOf(scene.objects.maze), { top: ['maze-default'], door: ['maze-default'], wall: ['maze-default'], floor: ['maze-floor'] });
  assert.equal(scene.root.inside.union[1].material, 'maze-floor', 'the floor beyond the maze');
  assert.equal(scene.root.inside.union[1].outside.material, 'maze-sky');

  const castle = mazeScene({ rings: 3, prefix: 'castle' }).scene;
  assert.deepEqual(partsOf(castle.objects.maze), { top: ['castle-default'], door: ['castle-default'], wall: ['castle-default'], floor: ['castle-floor'] });
  assert.equal(castle.root.inside.union[1].outside.material, 'castle-sky');

  const bare = mazeScene({ rings: 3, prefix: '' }).scene;
  assert.deepEqual(partsOf(bare.objects.maze), { top: ['default'], door: ['default'], wall: ['default'], floor: ['floor'] });
  assert.equal(bare.root.inside.union[1].outside.material, 'sky', 'an empty prefix: the name alone');
});

test('a material given is named exactly; --material-default is the parts\' unless they have their own', () => {
  const { scene } = mazeScene({ prefix: 'castle', materialWall: 'brick', materialDoor: 'oak', materialTop: 'slate', materialFloor: 'grass' });
  assert.equal(scene.materials, '@lib/maze_defaults.json', 'none defined');
  assert.deepEqual(partsOf(scene.objects.maze), { top: ['slate'], door: ['oak'], wall: ['brick'], floor: ['grass'] });
  assert.equal(scene.root.inside.union[1].material, 'grass', 'the floor beyond the maze');
  assert.deepEqual(partsOf(mazeScene({ materialWall: 'brass' }).scene.objects.maze),
                   { top: ['maze-default'], door: ['maze-default'], wall: ['brass'], floor: ['maze-floor'] }, 'the walls alone');
  assert.deepEqual(partsOf(mazeScene({ materialDefault: 'brick', materialTop: 'slate' }).scene.objects.maze),
                   { top: ['slate'], door: ['brick'], wall: ['brick'], floor: ['maze-floor'] }, 'not the floor');

  // From the command line: --material is --material-default.
  const parts = (...args) => {
    const run = spawnSync('node', [script, '--rings', '3', '--no-check', ...args], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return partsOf(JSON.parse(run.stdout).objects.maze);
  };
  const brick = { top: ['brick'], door: ['brick'], wall: ['brick'], floor: ['castle-floor'] };
  assert.deepEqual(parts('--prefix=castle', '--material-default', 'brick'), brick);
  assert.deepEqual(parts('--prefix=castle', '--material=brick'), brick);
  assert.deepEqual(parts('--material-wall', 'brass').wall, ['brass']);

  // The sky and the ambient light, exactly too.
  const run = (...args) => JSON.parse(spawnSync('node', [script, '--rings', '3', '--no-check', ...args], { encoding: 'utf8' }).stdout);
  assert.equal(run('--prefix=castle', '--material-sky=sky').root.inside.union[1].outside.material, 'sky');
  assert.equal(run('--prefix=castle', '--material-ambient=maze-night').root.material, 'maze-night');
  for (const old of ['--material-lib=x', '--material-prefix=x', '--ambient=x', '--door-material=x']) {
    assert.match(spawnSync('node', [script, old], { encoding: 'utf8' }).stderr, /unknown option/, old);
  }
  const both = spawnSync('node', [script, '--material', 'a', '--material-default', 'b'], { encoding: 'utf8' });
  assert.equal(both.status, 1);
  assert.match(both.stderr, /--material is --material-default: give one/);
});

test('torches: lights on the nodes holding their cells, and a dimmer sun', () => {
  const { maze, scene } = mazeScene({ seed: 3, rings: 3, torches: 0.5, sun: 0.1, materialAmbient: 'maze-night' });
  assert.ok(maze.torches.length > 2 && maze.torches.length < maze.cells.length, `${maze.torches.length} torches`);
  const carried = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.lights) carried.push(...n.lights.map((light) => light.pos.join()));
    walk(n.inside); walk(n.outside);
  };
  walk(scene.objects.maze);
  assert.deepEqual(new Set(carried), new Set(maze.torches.map((torch) => torch.pos.join())));
  assert.equal(mazeScene({ seed: 3, rings: 3 }).maze.torches.length, 0, 'none by default');
  const dim = scene.lights[0].color[0], full = mazeScene({ seed: 3, rings: 3 }).scene.lights[0].color[0];
  assert.ok(Math.abs(dim / full - 0.1) < 0.01, `${dim} vs ${full}`);
  assert.ok(compiled(scene).nodes.length > 20);
});

test('--torches-global: the same torches as the scene\'s own lights, and the same tree without them', () => {
  const options = { seed: 3, rings: 3, torches: 0.5, sun: 0.1 };
  const scoped = mazeScene(options), global = mazeScene({ ...options, scopeTorches: false });
  const positions = (lights) => lights.map((light) => light.pos.join()).sort();
  assert.deepEqual(positions(global.scene.lights.slice(1)), positions(scoped.maze.torches));
  assert.equal(JSON.stringify(global.scene.objects.maze).includes('"lights"'), false);
  assert.equal(JSON.stringify(global.scene.objects.maze), JSON.stringify(mazeScene({ ...options, torches: 0 }).scene.objects.maze),
               'no torch nodes: the unlit tree');
  const run = spawnSync('node', [script, '--seed', '3', '--rings', '3', '--torches', '0.5', '--torches-global'], { cwd: SCENES, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(JSON.parse(run.stdout).lights.length > 2);
});

test('--library: the scene uses the libraries, in order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maze-lib-'));
  try {
    mkdirSync(join(dir, 'lib'));
    const rock = { albedo: [0.5, 0.5, 0.5] };
    writeFileSync(join(dir, 'lib/rock.json'), JSON.stringify({ 'maze-default': rock, 'maze-floor': {} }));
    writeFileSync(join(dir, 'lib/sky.json'), JSON.stringify({ 'maze-sky': { kind: 'unlit', albedo: [0, 0, 1] }, _comment: 'a note' }));
    const write = (...args) => {
      const run = spawnSync('node', [script, '--rings', '3', ...args, '-o', join(dir, 'maze.json')], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(readFileSync(join(dir, 'maze.json'), 'utf8'));
    };
    assert.deepEqual(write('--library', 'lib/rock.json', '--library=lib/sky.json').materials,
                     ['@lib/rock.json', '@lib/sky.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the check: a library not found, or a material none defines, is an error; --no-check writes it anyway', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maze-check-'));
  const out = join(dir, 'maze.json');
  const run = (...args) => spawnSync('node', [script, '--rings', '3', ...args, '-o', out], { encoding: 'utf8' });
  try {
    // Here, no lib/maze_defaults.json: the default library isn't found.
    const missing = run();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /maze: cannot load .*lib\/maze_defaults\.json.*\(--no-check writes it anyway\)/);
    const anyway = run('--no-check');
    assert.equal(anyway.status, 0, anyway.stderr);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).materials, '@lib/maze_defaults.json');

    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'lib/maze_defaults.json'), JSON.stringify(DEFAULTS));
    assert.equal(run().status, 0, 'found');
    const oak = run('--material-door', 'oak');
    assert.equal(oak.status, 1);
    assert.match(oak.stderr, /unknown material "oak".*\(--no-check writes it anyway\)/);
    assert.equal(run('--material-door', 'oak', '--no-check').status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a scene named all from lib/materials.json passes the check', () => {
  // Written into public/scenes, where the library is found.
  const out = join(SCENES, `zz-maze-test-${process.pid}.json`);
  try {
    const run = spawnSync('node', [script, '--rings', '3', `--out=${out}`, '--material-top=jade', '--material-floor=floor',
                                   '--material-sky=sky', '--material=stone', '--library=lib/materials.json'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /compiles to \d+ nodes/);
  } finally {
    rmSync(out, { force: true });
  }
});
