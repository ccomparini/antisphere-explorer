// Tests for circular mazes: the maze as a graph, and the walls built from it
// standing where the graph says, by classifying points in the compiled
// scene the way trace() does. Run with:
//   node --test maze.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { circularMaze, seeded } from './maze.js';
import { compileScene } from './antisphere-scene.js';

const OPTIONS = { seed: 3, rings: 5, hallWidth: 1.2, wallHeight: 2.5, wallThickness: 0.2, innerRadius: 1.5 };

test('the same seed makes the same maze, and others other ones', () => {
  assert.deepEqual(circularMaze(OPTIONS).passages, circularMaze(OPTIONS).passages);
  const others = [4, 5, 6].map((seed) => JSON.stringify(circularMaze({ ...OPTIONS, seed }).passages));
  assert.equal(new Set([JSON.stringify(circularMaze(OPTIONS).passages), ...others]).size, 4);
  const a = seeded(9), b = seeded(9);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test('the passages are a spanning tree over the hub and every cell', () => {
  for (const seed of [1, 2, 3, 4]) {
    const { cells, passages } = circularMaze({ ...OPTIONS, seed });
    // A tree over cells + hub has one edge fewer than it has nodes.
    assert.equal(passages.length, cells.length);
    const next = new Map([[-1, []], ...cells.map((_, k) => [k, []])]);
    for (const [a, b] of passages) { next.get(a).push(b); next.get(b).push(a); }
    const seen = new Set([-1]), todo = [-1];
    while (todo.length) for (const n of next.get(todo.pop())) if (!seen.has(n)) { seen.add(n); todo.push(n); }
    assert.equal(seen.size, cells.length + 1, `seed ${seed}: all reachable`);
  }
});

test('each ring has as many cells as the one inside it, or twice as many', () => {
  const { cells } = circularMaze({ ...OPTIONS, rings: 8 });
  const counts = [];
  for (const c of cells) counts[c.ring] = (counts[c.ring] ?? 0) + 1;
  assert.equal(counts[0], 6);
  counts.slice(1).forEach((c, i) => assert.ok(c === counts[i] || c === 2 * counts[i], `${counts}`));
  assert.ok(counts.at(-1) > counts[0], `${counts}: it doubles somewhere`);
});

// -- the walls, where the graph says ------------------------------------------------

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const H = (p, R) => {
  const along = dot(p.axis, R);
  return p.k_perp * dot(R, R) + (p.k_par - p.k_perp) * along * along + 2 * dot(p.linear, R) + p.constant;
};
function solidAt(built, R) {
  let index = 1, found = 0;
  for (let step = 0; step < 20000 && index !== 0; step++) {
    const nd = built.nodes[index];
    if (H(nd.prim, R) < 0) {
      if (built.materials[nd.material].solid) { if (!found) found = index; } else found = 0;
      index = nd.inside;
    } else {
      found = 0;
      index = nd.outside;
    }
  }
  return found !== 0;
}

test('the walls stand where the maze says, and open where it says', () => {
  const maze = circularMaze({ ...OPTIONS, material: 'stone' });
  const built = compileScene({
    materials: { stone: {} },
    lights: [{ pos: [0, 0, 20], color: [1, 1, 1] }],
    objects: { maze: maze.tree },
    root: { sphere: { center: [0, 0, 0], radius: 100 }, material: null, inside: { use: 'maze' } },
  });
  const { hallWidth: w, wallThickness: t, innerRadius, wallHeight: h, rings } = OPTIONS;
  const rho = (i) => innerRadius + i * (w + t);
  const at = (r, a, z = h / 2) => [r * Math.cos(a), r * Math.sin(a), z];
  const near = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 1e-6;
  const doors = maze.openings.filter((o) => o.ring !== undefined);

  // Every doorway is open, through the middle of its wall; the wall is
  // still there opposite it (the slab alone would have cut both sides).
  for (const { ring, angle } of doors) {
    assert.equal(solidAt(built, at(rho(ring) + t / 2, angle)), false, `doorway in wall ${ring} at ${angle}`);
    const opposite = angle + Math.PI;
    if (!doors.some((d) => d.ring === ring && near(d.angle, opposite))) {
      assert.equal(solidAt(built, at(rho(ring) + t / 2, opposite)), true, `wall ${ring} opposite its doorway`);
    }
  }
  // Midway between doorways, each ring wall is solid.
  for (let i = 0; i <= rings; i++) {
    const mine = doors.filter((d) => d.ring === i).map((d) => d.angle).sort((a, b) => a - b);
    for (let k = 0; k < mine.length; k++) {
      const a = mine[k], b = k + 1 < mine.length ? mine[k + 1] : mine[0] + 2 * Math.PI;
      if (b - a > 0.6) assert.equal(solidAt(built, at(rho(i) + t / 2, (a + b) / 2)), true, `wall ${i} between doorways`);
    }
  }
  // Each cell's middle is open; its far end blocked exactly where the
  // maze keeps the radial wall.
  const openRadial = maze.openings.filter((o) => o.radial !== undefined);
  for (const cell of maze.cells) {
    const mid = (rho(cell.ring) + t + rho(cell.ring + 1)) / 2;
    assert.equal(solidAt(built, at(mid, (cell.angle0 + cell.angle1) / 2)), false, 'mid-cell');
    const ringCells = maze.cells.filter((c) => c.ring === cell.ring).length;
    if (ringCells < 2) continue;
    const kept = !openRadial.some((o) => o.radial === cell.ring && near(o.angle, cell.angle1));
    assert.equal(solidAt(built, at(mid, cell.angle1)), kept, `radial wall, ring ${cell.ring} at ${cell.angle1}`);
  }
  // Nothing above the halls; the exit cut through the outer wall.
  assert.equal(solidAt(built, at(rho(2) + t / 2, 0.3, h + 0.5)), false);
  assert.equal(solidAt(built, at(rho(rings) + t / 2, maze.exit.angle)), false, 'the exit');
});
