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
  const { maze, scene } = mazeScene({ seed: 2, rings: 4, hallHeight: 3, wallThickness: 0.3, material: 'brick' });
  assert.equal(new Set(maze.cells.map((c) => c.ring)).size, 4);
  assert.ok('brick' in scene.materials);
  const walls = JSON.stringify(scene.objects.maze);
  assert.equal(walls.includes('"material":"brick"'), true);
  assert.ok(walls.includes('"thickness":3'), 'the walls are 3 tall');
});

test('a bad option is refused', () => {
  const run = spawnSync('node', [script, '--rings', 'many'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--rings needs a number/);
});
