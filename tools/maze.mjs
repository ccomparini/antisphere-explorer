#!/usr/bin/env node
// Write a scene with a circular maze in it (public/maze.js).
//
//   node tools/maze.mjs -o public/scenes/my-maze.json
//   node tools/maze.mjs --seed 7 --rings 8 --wall-height 3 -o public/scenes/maze.json
//   node tools/maze.mjs --library lib/materials.json --material stone -o public/scenes/maze.json
//   node tools/maze.mjs --hall-width 4 --inner-radius 8 --no-check > big.json
//
// The scene has a floor, a sky, a light and a camera looking down over the
// maze. Its materials come from libraries: it names them, and defines none
// itself. Each is named after a prefix - maze-default (the walls, their
// doorways and tops, unless told otherwise), maze-floor, maze-sky - so a
// maze placed in another scene, or one using another library, keeps its
// own. By default the library is lib/maze_defaults.json, which defines
// those, and maze-dusk and maze-night for --material-ambient. Before
// writing, it reads the libraries and compiles the scene, so a material
// nothing defines, or a library not found, is an error here; --no-check
// writes it anyway. Reports on stderr, writes the scene on stdout unless
// told where.

const VERSION_MAJ = 0;
const VERSION_MIN = 9;

import { readFileSync, writeFileSync } from 'node:fs';
import { circularMaze } from '../public/maze.js';
import { compileScene, loadReferences } from '../public/antisphere-scene.js';
import { parseOptions, commandLine } from './args.mjs';

const USAGE = `
maze - write a scene with a circular maze in it

  node tools/maze.mjs [options]

  -o, --out <file>          write here instead of stdout
      --no-check            write the scene without reading its libraries
                            or compiling it first
      --seed <n>            which maze (default 1)
      --rings <n>           corridors round the hub (default 5)
      --hall-width <w>      corridor width (default 2.25)
      --wall-height <h>     wall height (default 2.5)
      --wall-thickness <t>  (default 0.2)
      --inner-radius <r>    the open middle's (default 1.25 hall widths)
      --torches <share>     of the cells with a torch, 0 to 1 (default 0)
      --torches-global      the torches as the scene's own lights, lighting
                            everything, rather than each its own cell
      --sun <brightness>    the sun's light, 0 for none (default 1)

  Materials, each named exactly:
      --material-default <m>, --material <m>
                            the walls' faces, doorways and tops, unless
                            given their own (default <prefix>-default)
      --material-wall <m>   the walls' faces
      --material-door <m>   the insides of the doorways
      --material-top <m>    the tops of the walls
      --material-floor <m>  the floor (default <prefix>-floor)
      --material-sky <m>    the sky (default <prefix>-sky)
      --material-ambient <m>
                            the ambient light, an "ambient" material:
                            maze-dusk or maze-night in the defaults
                            (default: the renderer's own, as by day)
      --prefix <p>          what the default names start with: <p>-default,
                            <p>-floor, <p>-sky (default "maze"; empty, the
                            part's name alone)
      --library <path>      a library of the materials the scene names,
                            "@path" in its "materials" (default
                            lib/maze_defaults.json). Relative to where the
                            scene is written (stdout: here). Repeatable;
                            later ones win.
  A night scene is --sun 0.1 --material-ambient maze-night, say.
`.trim();

const OPTIONS = {
  out: { type: 'string', short: 'o' },
  seed: { type: 'number' }, rings: { type: 'number' }, 'hall-width': { type: 'number' },
  'wall-height': { type: 'number' }, 'wall-thickness': { type: 'number' },
  'inner-radius': { type: 'number' }, torches: { type: 'number' }, sun: { type: 'number' },
  'material-ambient': { type: 'string' }, 'material-sky': { type: 'string' },
  prefix: { type: 'string', default: 'maze' },
  'material-default': { type: 'string' }, material: { type: 'string' },
  'material-wall': { type: 'string' }, 'material-door': { type: 'string' },
  'material-top': { type: 'string' }, 'material-floor': { type: 'string' },
  'torches-global': { type: 'boolean' },
  library: { type: 'string', multiple: true },
  'no-check': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

// mazeScene()'s options: each named as its option is, camel-cased.
function parseArguments(argv) {
  const { values } = parseOptions(argv, OPTIONS);
  const options = {};
  for (const [name, value] of Object.entries(values)) {
    options[name.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
  }
  // --material is --material-default.
  if (options.material !== undefined) {
    if (options.materialDefault !== undefined && options.materialDefault !== options.material) {
      throw new Error('--material is --material-default: give one');
    }
    options.materialDefault = options.material;
    delete options.material;
  }
  if (options.torchesGlobal) options.scopeTorches = false;
  delete options.torchesGlobal;
  if (options.library) options.libraries = options.library;
  options.check = !options.noCheck;
  delete options.library;
  delete options.noCheck;
  return options;
}

/** The scene round a maze: floor, sky, a light and a camera, sized to it. */
// options.libraries: the libraries the scene's materials come from, as
// paths for "@path" references.
// Each material is named after options.prefix (<prefix>-default),
// unless options names it outright (materialWall: 'brass'). The walls'
// faces, doorways and tops share materialDefault unless given their own,
// so by default their faces merge where they meet.
export function mazeScene(options = {}) {
  const prefix = options.prefix ?? 'maze';
  const named = (part) => (prefix ? `${prefix}-${part}` : part);
  const {
    materialDefault = named('default'),
    materialWall: material = materialDefault,
    materialDoor: doorMaterial = materialDefault,
    materialTop: topMaterial = materialDefault,
    materialFloor: floorMaterial = named('floor'),
    sun: daylight = 1,
    materialSky = named('sky'),
    materialAmbient: ambient = null,
    libraries = ['lib/maze_defaults.json'],
  } = options;
  const maze = circularMaze({ ...options, material, doorMaterial, topMaterial, floorMaterial });
  const references = libraries.map((path) => `@${path}`);
  const R = maze.radius;
  const sun = [R * 0.8, -R * 1.1, R * 2.5];
  const eye = [0, -R * .95, Math.min(Math.max(maze.height + .5, R * 1.5), maze.height*6)];
  const distance = Math.hypot(...eye);
  return {
    maze,
    scene: {
      _comment: `A circular maze, seed ${options.seed ?? 1}: written by tools/maze.mjs (public/maze.js).`,
      _meta: {
        generatedBy: commandLine(),
        generatorVersionMaj: VERSION_MAJ,
        generatorVersionMin: VERSION_MIN,
      },
      materials: references.length === 1 ? references[0] : references,
      // Bright enough at the maze to read as daylight, inverse square.
      // The maze's torches are on its nodes, lighting their own cells - or,
      // unscoped, here with the sun, lighting everything.
      lights: [
        { pos: sun, color: [1, 0.96, 0.9].map((c) => +(c * daylight * 2.5 * (1 + sun.reduce((s, v) => s + v * v, 0))).toFixed(1)) },
        ...(options.scopeTorches === false ? maze.torches.map(({ pos, color }) => ({ pos, color })) : []),
      ],
      camera: { position: eye, direction: eye.map((v) => -v / distance), distance },
      objects: { maze: maze.tree },
      // The maze first: within it, its own floor, so a torch lights the
      // floor of its cell; around it, the floor beyond.
      root: {
        sphere: { center: [0, 0, 0], radius: R * 40 },
        // The ambient light everywhere within, unless something says otherwise.
        ...(ambient ? { material: ambient } : {}),
        inside: {
          union: [
            { use: 'maze' },
            {
              plane: { normal: [0, 0, 1], offset: 0 },
              material: floorMaterial,
              outside: { sphere: { center: [0, 0, 0], radius: R * 39 }, complement: true, material: materialSky },
            },
          ],
        },
      },
    },
  };
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const { maze, scene } = mazeScene(options);
  const say = (...parts) => console.error(...parts);
  say(`maze: ${maze.cells.length} cells in ${new Set(maze.cells.map((c) => c.ring)).size} rings, ` +
      `${maze.radius.toFixed(2)} in radius`);
  // Compile before writing, with the libraries as the scene will read them
  // (relative to it): a scene that will not load is worse than an error
  // here - unless told to write it anyway.
  if (options.check) {
    const path = options.out ?? 'maze.json';
    try {
      const files = await loadReferences(scene, {
        from: path, readText: async (file) => readFileSync(file, 'utf8'), readBytes: async (file) => readFileSync(file),
      });
      const built = compileScene(structuredClone(scene), { files, path });
      say(`  compiles to ${built.nodes.length - 1} nodes`);
    } catch (error) {
      throw new Error(`${error.message} (--no-check writes it anyway)`);
    }
  }
  const json = JSON.stringify(scene, null, 2) + '\n';
  if (options.out) {
    writeFileSync(options.out, json);
    say(`  written to ${options.out}`);
  } else {
    process.stdout.write(json);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`maze: ${error.message}`);
    process.exit(1);
  });
}
