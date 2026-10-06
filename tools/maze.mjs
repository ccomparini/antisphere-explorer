#!/usr/bin/env node
// Write a scene with a circular maze in it (public/maze.js).
//
//   node tools/maze.mjs > maze.json
//   node tools/maze.mjs --seed 7 --rings 8 --wall-height 3 -o public/scenes/maze.json
//   node tools/maze.mjs --hall-width 4 --inner-radius 8 -o big.json
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
      --hall-width <w>      corridor width (default 2.25)
      --wall-height <h>     wall height (default 2.5)
      --wall-thickness <t>  (default 0.2)
      --inner-radius <r>    the open middle's (default 1.25 hall widths)
      --material <m>        the walls' faces (default "stone")
      --door-material <m>   the insides of the doorways (default: the walls')
      --top-material <m>    the tops of the walls (default: the walls')
      --floor-material <m>  the floor (default "floor", a checker)
  A material named here and not otherwise known is given a colour for its
  part: stone for walls, wood for doors, pale for tops, a checker for the
  floor.
`.trim();

const NAMES = {
  '--material': 'material', '--door-material': 'doorMaterial',
  '--top-material': 'topMaterial', '--floor-material': 'floorMaterial',
};

const NUMBERS = {
  '--seed': 'seed', '--rings': 'rings', '--hall-width': 'hallWidth',
  '--wall-height': 'wallHeight', '--wall-thickness': 'wallThickness',
  '--inner-radius': 'innerRadius',
};

function parseArguments(argv) {
  const options = { material: 'stone' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '-o' || arg === '--out') options.out = next();
    else if (NAMES[arg]) options[NAMES[arg]] = next();
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
// What a material named for each part looks like, if nothing else says.
const LOOKS = {
  wall: { albedo: [0.62, 0.58, 0.52] },
  door: { albedo: [0.42, 0.30, 0.20] },
  top: { albedo: [0.80, 0.78, 0.74] },
  floor: { albedo: [0.30, 0.31, 0.34], albedo2: [0.18, 0.19, 0.21], pattern: 'checker', scale: 1 },
};

export function mazeScene(options = {}) {
  const {
    material = 'stone',
    doorMaterial = material,
    topMaterial = material,
    floorMaterial = 'floor',
  } = options;
  const maze = circularMaze({ ...options, material, doorMaterial, topMaterial });
  // One definition a name: the walls' first, if parts share one.
  const materials = {};
  for (const [name, part] of [[material, 'wall'], [doorMaterial, 'door'], [topMaterial, 'top'], [floorMaterial, 'floor']]) {
    materials[name] ??= LOOKS[part];
  }
  materials.sky ??= { kind: 'unlit', albedo: [0.07, 0.09, 0.14] };
  const R = maze.radius;
  const sun = [R * 0.8, -R * 1.1, R * 2.5];
  const eye = [0, -R * 1.5, R * 1.5];
  const distance = Math.hypot(...eye);
  return {
    maze,
    scene: {
      _comment: `A circular maze, seed ${options.seed ?? 1}: written by tools/maze.mjs (public/maze.js).`,
      materials,
      // Bright enough at the maze to read as daylight, inverse square.
      lights: [{ pos: sun, color: [1, 0.96, 0.9].map((c) => +(c * 2.5 * (1 + sun.reduce((s, v) => s + v * v, 0))).toFixed(1)) }],
      camera: { position: eye, direction: eye.map((v) => -v / distance), distance },
      objects: { maze: maze.tree },
      root: {
        sphere: { center: [0, 0, 0], radius: R * 40 },
        inside: {
          plane: { normal: [0, 0, 1], offset: 0 },
          material: floorMaterial,
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
