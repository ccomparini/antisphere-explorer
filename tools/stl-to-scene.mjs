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
import { meshToTree, treeStats, boundsOf, placeTriangles } from '../public/mesh-import.js';
import { compileScene, sceneAroundMesh } from '../public/antisphere-scene.js';
import { parseOptions } from './args.mjs';

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
  const { values, positionals } = parseOptions(argv, {
    out: { type: 'string', short: 'o' },
    fit: { type: 'number' },
    material: { type: 'string', default: 'clay' },
    name: { type: 'string', default: 'model' },
    'no-centre': { type: 'boolean' },
    'no-center': { type: 'boolean' },
    'no-floor': { type: 'boolean' },
    whole: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  }, { positionals: true });
  return {
    out: values.out, fit: values.fit, material: values.material, name: values.name, help: values.help,
    centre: !(values['no-centre'] || values['no-center']),
    floor: !values['no-floor'],
    split: !values.whole,
    file: positionals[0],
  };
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

  const placed = placeTriangles(read.triangles, options);
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

  const scene = sceneAroundMesh(model, { ...options, size, bounds: { lo, hi } });

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

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`stl-to-scene: ${error.message}`);
  process.exit(1);
}
