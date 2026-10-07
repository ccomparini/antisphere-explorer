// Tests for the maze scene writer. Run with:
//   node --test tools/maze.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileScene } from '../public/antisphere-scene.js';
import { mazeScene } from './maze.mjs';

const script = fileURLToPath(new URL('./maze.mjs', import.meta.url));

test('writes a complete scene that compiles, on stdout', () => {
  const scene = JSON.parse(execFileSync('node', [script, '--seed', '4', '--rings', '3'],
                                        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.ok(scene.camera && scene.lights.length && scene.objects.maze.cylinder);
  const built = compileScene(scene);
  assert.ok(built.nodes.length > 20, `${built.nodes.length} nodes`);
});

test('options reach the maze', () => {
  const { maze, scene } = mazeScene({ seed: 2, rings: 4, wallHeight: 3, wallThickness: 0.3, material: 'brick' });
  assert.equal(new Set(maze.cells.map((c) => c.ring)).size, 4);
  assert.ok('brick' in scene.materials);
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

test('walls, doorways, tops and floor can each have a material, given a look for its part', () => {
  const { scene } = mazeScene({ material: 'brick', doorMaterial: 'oak', topMaterial: 'slate', floorMaterial: 'grass' });
  for (const name of ['brick', 'oak', 'slate', 'grass']) assert.ok(name in scene.materials, name);
  assert.equal(scene.materials.grass.pattern, 'checker', 'the floor gets the floor look');
  assert.equal(scene.root.inside.union[1].material, 'grass', 'the floor beyond the maze');
  // Every node carrying one: the floor is the plane at 0, tops the other
  // planes, doorways complemented slabs.
  const seen = { top: new Set(), door: new Set(), wall: new Set(), floor: new Set() };
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.material) {
      const part = n.plane ? (n.plane.offset === 0 ? 'floor' : 'top') : n.slab?.complement ? 'door' : 'wall';
      seen[part].add(n.material);
    }
    walk(n.inside); walk(n.outside);
  };
  walk(scene.objects.maze);
  assert.deepEqual([...seen.top], ['slate']);
  assert.deepEqual([...seen.door], ['oak']);
  assert.deepEqual([...seen.wall], ['brick']);
  assert.deepEqual([...seen.floor], ['grass'], 'the floor within the maze');
  // Unless given, doorways and tops are the walls'.
  const plain = JSON.stringify(mazeScene({ material: 'brick' }).scene.objects.maze);
  assert.ok(!plain.includes('oak') && !plain.includes('slate'));
});

test('torches: lights on the nodes holding their cells, and a dimmer sun', () => {
  const { maze, scene } = mazeScene({ seed: 3, rings: 3, torches: 0.5, sun: 0.1 });
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
  const built = compileScene(structuredClone(scene));
  assert.ok(built.nodes.length > 20);
});
