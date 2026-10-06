#!/usr/bin/env node
// Write a scene with a circular maze in it (public/maze.js).
//
//   node tools/maze.mjs > maze.json
//   node tools/maze.mjs --seed 7 --rings 8 --hall-height 3 -o public/scenes/maze.json
//
// The scene is complete - a floor, a sky, a light and a camera looking down
// over the maze - so it opens in the page or the editor as it is. Reports
// on stderr, writes the scene on stdout unless told where.

import { writeFileSync } from 'node:fs';
import { circularMaze } from '../public/maze.js';
import { compileScene } from '../public/antisphere-scene.js';

const USAGE = `
maze - write a scene with a circular maze in it

  node tools/maze.mjs [options]

  -o, --out <file>          write here instead of stdout
      --seed <n>            which maze (default 1)
      --rings <n>           corridors round the hub (default 5)
      --hall-width <w>      corridor width (default 1.2)
      --hall-height <h>     wall height (default 2.5)
      --wall-thickness <t>  (default 0.2)
      --material <m>        what the walls are (default "stone")
`.trim();

const NUMBERS = {
  '--seed': 'seed', '--rings': 'rings', '--hall-width': 'hallWidth',
  '--hall-height': 'hallHeight', '--wall-thickness': 'wallThickness',
};

function parseArguments(argv) {
  const options = { material: 'stone' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '-o' || arg === '--out') options.out = next();
    else if (arg === '--material') options.material = next();
    else if (NUMBERS[arg]) {
      const value = Number(next());
      if (!Number.isFinite(value)) throw new Error(`${arg} needs a number`);
      options[NUMBERS[arg]] = value;
    } else if (arg === '-h' || arg === '--help') options.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

/** The scene round a maze: floor, sky, a light and a camera, sized to it. */
export function mazeScene(options = {}) {
  const { material = 'stone' } = options;
  const maze = circularMaze({ ...options, material });
  const R = maze.radius;
  const sun = [R * 0.8, -R * 1.1, R * 2.5];
  const eye = [0, -R * 1.5, R * 1.5];
  const distance = Math.hypot(...eye);
  return {
    maze,
    scene: {
      _comment: `A circular maze, seed ${options.seed ?? 1}: written by tools/maze.mjs (public/maze.js).`,
      materials: {
        [material]: { albedo: [0.62, 0.58, 0.52] },
        floor: { albedo: [0.30, 0.31, 0.34], albedo2: [0.18, 0.19, 0.21], pattern: 'checker', scale: 1 },
        sky: { kind: 'unlit', albedo: [0.07, 0.09, 0.14] },
      },
      // Bright enough at the maze to read as daylight, inverse square.
      lights: [{ pos: sun, color: [1, 0.96, 0.9].map((c) => +(c * 2.5 * (1 + sun.reduce((s, v) => s + v * v, 0))).toFixed(1)) }],
      camera: { position: eye, direction: eye.map((v) => -v / distance), distance },
      objects: { maze: maze.tree },
      root: {
        sphere: { center: [0, 0, 0], radius: R * 40 },
        inside: {
          plane: { normal: [0, 0, 1], offset: 0 },
          material: 'floor',
          outside: {
            union: [
              { use: 'maze' },
              { sphere: { center: [0, 0, 0], radius: R * 39 }, complement: true, material: 'sky' },
            ],
          },
        },
      },
    },
  };
}

function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const { maze, scene } = mazeScene(options);
  const say = (...parts) => console.error(...parts);
  say(`maze: ${maze.cells.length} cells in ${new Set(maze.cells.map((c) => c.ring)).size} rings, ` +
      `${maze.radius.toFixed(2)} in radius`);
  // Compile before writing: a scene that will not load is worse than an
  // error here.
  const built = compileScene(structuredClone(scene));
  say(`  compiles to ${built.nodes.length - 1} nodes`);
  const json = JSON.stringify(scene, null, 2) + '\n';
  if (options.out) {
    writeFileSync(options.out, json);
    say(`  written to ${options.out}`);
  } else {
    process.stdout.write(json);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`maze: ${error.message}`);
    process.exit(1);
  }
}
