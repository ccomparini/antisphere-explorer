// Tests for the converter. Run with:
//   node --test tools/stl-to-scene.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSTL } from '../public/stl.js';
import { compileScene } from '../public/antisphere-scene.js';

const script = fileURLToPath(new URL('./stl-to-scene.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'stl-'));

/** A box as triangles, which is enough to exercise the whole path. */
function boxSTL(size = 2) {
  const h = size / 2;
  const v = [[-h,-h,-h],[h,-h,-h],[h,h,-h],[-h,h,-h],[-h,-h,h],[h,-h,h],[h,h,h],[-h,h,h]];
  const quads = [[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
  return quads.flatMap(([a,b,c,d]) => [[v[a],v[b],v[c]], [v[a],v[c],v[d]]]);
}

const run = (args) => execFileSync('node', [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('a box becomes a scene that compiles', () => {
  const file = join(scratch, 'box.stl');
  writeFileSync(file, Buffer.from(writeSTL(boxSTL())));
  const scene = JSON.parse(run([file]));

  assert.ok(scene.objects.model, 'the model is an object, so it can be selected');
  assert.ok(scene.camera, 'and there is somewhere to look from');
  const built = compileScene(scene);
  assert.ok(built.nodes.length > 6);
  // Made of a material named for the file - an STL is only geometry - which
  // the scene defines; and there is a floor to stand on.
  assert.equal(scene.objects.model.material, 'box');
  assert.ok(Object.keys(scene.materials).includes('box'));
  assert.ok(Object.keys(scene.materials).includes('floor'));
});

test('--fit scales it, and it stands on the floor', () => {
  const file = join(scratch, 'box2.stl');
  writeFileSync(file, Buffer.from(writeSTL(boxSTL(7))));       // 7 units across
  const scene = JSON.parse(run([file, '--fit', '2']));
  const built = compileScene(scene);

  const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
  const H = (p, R) => {
    const t = dot(p.axis, R);
    return p.k_perp * dot(R, R) + (p.k_par - p.k_perp) * t * t + 2 * dot(p.linear, R) + p.constant;
  };
  const materialAt = (R) => {
    let i = 1, f = 0;
    for (let s = 0; s < 5000 && i !== 0; s++) {
      const nd = built.nodes[i];
      if (H(nd.prim, R) < 0) {
        if (built.materials[nd.material].solid) { if (!f) f = i; } else f = 0;
        i = nd.inside;
      } else { f = 0; i = nd.outside; }
    }
    return f ? built.nodes[f].material : 0;
  };
  const box = Object.keys(scene.materials).indexOf('box2') + 1;
  assert.ok(box > 0, 'made of box2, named for the file');
  assert.equal(materialAt([0, 0, 1]), box, 'solid a unit up: the box is 2 across, on the floor');
  assert.equal(materialAt([0, 0, 2.5]), 0, 'and empty above it');
});

test('--no-floor gives just the model', () => {
  const file = join(scratch, 'box3.stl');
  writeFileSync(file, Buffer.from(writeSTL(boxSTL())));
  const scene = JSON.parse(run([file, '--no-floor']));
  assert.equal(scene.materials.floor, undefined);
  assert.ok(compileScene(scene).nodes.length > 6);
});

test('an open surface is converted, with a warning', () => {
  const file = join(scratch, 'open.stl');
  writeFileSync(file, Buffer.from(writeSTL(boxSTL().slice(0, 10))));   // a face short
  const output = execFileSync('node', [script, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(JSON.parse(output).objects.model, 'it still produces something');
});

test('no arguments prints how to use it', () => {
  assert.throws(() => execFileSync('node', [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
                /status 1|Command failed/);
});

test('--material names what it is made of instead', () => {
  const file = join(scratch, 'box4.stl');
  writeFileSync(file, Buffer.from(writeSTL(boxSTL())));
  const scene = JSON.parse(run([file, '--material', 'brass']));
  assert.equal(scene.objects.model.material, 'brass');
  assert.ok(scene.materials.brass && !scene.materials.box4);
});
