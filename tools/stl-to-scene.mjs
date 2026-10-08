#!/usr/bin/env node
// Turn an STL into a scene.
//
//   node tools/stl-to-scene.mjs model.stl > scene.json
//   node tools/stl-to-scene.mjs model.stl --fit 4 --material brass -o scene.json
//
// Reports what it found on stderr - triangles, open edges, node count - and
// writes the scene on stdout, so it pipes. The scene it writes is complete:
// a floor, a sky, three lights and a camera framing the model, so it can be
// opened in the editor and looked at rather than assembled first.

import { readFileSync, writeFileSync } from 'node:fs';
import { readSTL } from '../public/stl.js';
import { meshToTree, treeStats, boundsOf } from '../public/mesh-import.js';
import { compileScene, sceneAroundMesh } from '../public/antisphere-scene.js';

const USAGE = `
stl-to-scene - convert an STL into an antisphere scene

  node tools/stl-to-scene.mjs <file.stl> [options]

  -o, --out <file>     write here instead of stdout
      --fit <size>     scale the model so its longest side is this
      --material <m>   what the scene makes it of (default "clay")
      --name <n>       the object's name in the scene (default "model")
      --no-centre      leave the model where the file put it
      --no-floor       just the model, no floor, sky or camera
      --whole          pass straddling triangles whole instead of cutting
                       them (faster, and wrong on some closed meshes)
`.trim();

function parseArguments(argv) {
  const options = { material: 'clay', name: 'model', centre: true, floor: true, split: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '-o' || arg === '--out') options.out = next();
    else if (arg === '--fit') options.fit = Number(next());
    else if (arg === '--material') options.material = next();
    else if (arg === '--name') options.name = next();
    else if (arg === '--no-centre' || arg === '--no-center') options.centre = false;
    else if (arg === '--no-floor') options.floor = false;
    else if (arg === '--whole') options.split = false;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else rest.push(arg);
  }
  options.file = rest[0];
  return options;
}

/** Move the model over the origin and scale it, since STL has no units. */
function place(triangles, { centre, fit }) {
  const { lo, hi } = boundsOf(triangles);
  const size = [0, 1, 2].map((i) => hi[i] - lo[i]);
  const scale = fit ? fit / Math.max(...size) : 1;
  // Centred in x and y, standing on z = 0: where a floor expects it.
  const shift = centre
    ? [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]]
    : [0, 0, 0];
  if (!centre && scale === 1) return triangles;
  return triangles.map((tri) =>
    tri.map((v) => [0, 1, 2].map((i) => (v[i] + shift[i]) * scale)));
}

function main(argv) {
  const options = parseArguments(argv);
  if (options.help || !options.file) {
    console.log(USAGE);
    process.exit(options.file ? 0 : 1);
  }

  const read = readSTL(readFileSync(options.file));
  const say = (...parts) => console.error(...parts);
  say(`${options.file}: ${read.triangles.length} triangles`
      + (read.degenerate ? `, ${read.degenerate} with no area (skipped)` : '')
      + (read.flipped ? `, ${read.flipped} wound backwards (corrected)` : ''));
  if (read.openEdges) {
    say(`  warning: ${read.openEdges} open edges - this surface does not close, so`);
    say('  "inside" is not well defined and the conversion will guess at it');
  }
  if (!read.triangles.length) {
    say('  nothing to convert');
    process.exit(1);
  }

  const placed = place(read.triangles, options);
  const { lo, hi } = boundsOf(placed);
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);

  const started = Date.now();
  const model = meshToTree(placed, { split: options.split });
  if (!model) {
    say('  the mesh produced no geometry');
    process.exit(1);
  }
  const stats = treeStats(model);
  say(`  ${stats.nodes} nodes, depth ${stats.depth}, ${stats.solidLeaves} solid regions`
      + ` (${((Date.now() - started) / 1000).toFixed(1)}s)`);

  const scene = sceneAroundMesh(model, { ...options, size });

  // Compile before writing: a scene that will not load is worse than an
  // error here, because the error there will be about a file nobody wrote
  // by hand.
  try {
    const built = compileScene(structuredClone(scene));
    say(`  compiles to ${built.nodes.length - 1} nodes`);
  } catch (error) {
    say(`  the scene does not compile: ${error.message}`);
    process.exit(1);
  }

  const json = JSON.stringify(scene, null, 2) + '\n';
  if (options.out) {
    writeFileSync(options.out, json);
    say(`  written to ${options.out}`);
  } else {
    process.stdout.write(json);
  }
}

main(process.argv.slice(2));
