// Tests for a node's "textureOffset": a planar texture slid on its node,
// staying on the surface however the node is placed. Run with:
//   node --test public/texture-offset.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene, planeFrame, rotationRows } from './antisphere-scene.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };

// A 1x1 image will do: only the coordinates are looked at.
const FILES = { '/t/one.png': { width: 1, height: 1, rgba: new Uint8Array([200, 100, 50, 255]) } };

/** A floor-like plane, textured, offset, placed by `place`. */
function compiled(normal, place = {}, warn = () => {}, textureOffset = [0.25, 0.1]) {
  const spec = {
    materials: { tiles: { texture: '@one.png', scale: 2 } }, lights: [],
    objects: { slab: { plane: { normal, offset: 0.4 }, material: 'tiles', textureOffset } },
    root: { sphere: { center: [0, 0, 0], radius: 100 }, material: null, inside: { use: 'slab', ...place } },
  };
  const built = compileScene(spec, { files: FILES, path: '/t/s.json', warn });
  const nd = built.nodes.find((n) => built.materials[n.material]?.texture);
  return { nd, m: built.materials[nd.material] };
}

/** A point's texture coordinates, as the shader works them out. */
function uvAt({ nd, m }, P) {
  const { t, b } = planeFrame(nd.prim);
  const f = [dot(P, t) / m.scale, dot(P, b) / m.scale];
  const [du, dv, s] = m.patternParams, c = Math.sqrt(1 - s * s);
  return [c * f[0] - s * f[1] + du, s * f[0] + c * f[1] + dv];
}

// Points on the plane as written: n . P = 0.4.
const pointsOn = (normal) => {
  const n = unit(normal), { t, b } = planeFrame({ linear: n.map((v) => v / 2) });
  return [[0, 0], [0.7, -0.4], [-2.5, 3.1]].map(([x, y]) => [0, 1, 2].map((i) => 0.4 * n[i] + x * t[i] + y * b[i]));
};

const near = (got, want, say) =>
  assert.ok(Math.hypot(got[0] - want[0], got[1] - want[1]) < 1e-9, `${say}: ${got}, not ${want}`);

test('textureOffset, unplaced: frame(P) / scale + the offset, no turn', () => {
  const unplaced = compiled([0, 0, 1]);
  assert.deepEqual(unplaced.m.patternParams, [0.25, 0.1, 0]);
  for (const P of pointsOn([0, 0, 1])) {
    const { t, b } = planeFrame({ linear: [0, 0, 0.5] });
    near(uvAt(unplaced, P), [dot(P, t) / 2 + 0.25, dot(P, b) / 2 + 0.1], `at ${P}`);
  }
});

test('textureOffset with a turn: frame(P) / scale turned that many degrees, then slid', () => {
  const turned = compiled([0, 0, 1], {}, () => {}, [0.25, 0.1, 30]);
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  for (const P of pointsOn([0, 0, 1])) {
    const { t, b } = planeFrame({ linear: [0, 0, 0.5] });
    const f = [dot(P, t) / 2, dot(P, b) / 2];
    near(uvAt(turned, P), [c * f[0] - s * f[1] + 0.25, s * f[0] + c * f[1] + 0.1], `at ${P}`);
  }
});

test('textureOffset: the texture stays on the surface, the node scaled, turned and moved', () => {
  const rows = rotationRows([1, 1, 0.3], 37 * Math.PI / 180);
  const placings = {
    translate: [{ translate: [1, -2, 3] }, (P) => P.map((v, i) => v + [1, -2, 3][i])],
    rotate: [{ rotate: { axis: [1, 1, 0.3], degrees: 37 } }, (P) => rows.map((r) => dot(r, P))],
    scale: [{ scale: 1.5 }, (P) => P.map((v) => 1.5 * v)],
    'past a quarter turn': [{ rotate: { axis: [0.2, -0.3, 1], degrees: 150 } },
                            (P) => rotationRows([0.2, -0.3, 1], 150 * Math.PI / 180).map((r) => dot(r, P))],
    all: [{ scale: 1.5, rotate: { axis: [1, 1, 0.3], degrees: 37 }, translate: [1, -2, 3] },
          (P) => rows.map((r) => dot(r, P.map((v) => 1.5 * v))).map((v, i) => v + [1, -2, 3][i])],
  };
  // Normals either side of frame()'s change of helper axis (|n.z| > 0.9);
  // the texture as written turned or not, a turn of its own composing with
  // the placing.
  for (const normal of [[0, 0, 1], [0.3, 0.5, 0.8]]) {
    for (const offset of [[0.25, 0.1], [0.25, 0.1, 130]]) {
      const unplaced = compiled(normal, {}, () => {}, offset);
      for (const [name, [place, move]] of Object.entries(placings)) {
        const warned = [];
        const placed = compiled(normal, place, (where, msg) => warned.push(msg), offset);
        assert.deepEqual(warned, [], `${name}: nothing to warn of`);
        for (const P of pointsOn(normal)) near(uvAt(placed, move(P)), uvAt(unplaced, P), `${name}, normal ${normal}, offset ${offset}, at ${P}`);
      }
    }
  }
});

test('textureOffset that isn\'t [du, dv]: warned of, and ignored', () => {
  const warned = [];
  const built = compileScene({
    materials: { tiles: { texture: '@one.png' } }, lights: [],
    root: { plane: { normal: [0, 0, 1], offset: 0 }, material: 'tiles', textureOffset: [1, 'x'] },
  }, { files: FILES, path: '/t/s.json', warn: (where, msg) => warned.push(`${where}: ${msg}`) });
  assert.match(warned.join('\n'), /root\.textureOffset: must be \[du, dv\] or \[du, dv, degrees\]/);
  assert.ok(built.materials.filter((m) => m.texture).every((m) => m.patternParams.every((v) => v === 0)), 'no offset');
});

test('textureOffset on a plane turned inside out: warned of, its texture following unmirrored', () => {
  const warned = [];
  compiled([0, 0, 1], { complement: true }, (where, msg) => warned.push(msg));
  assert.match(warned.join('\n'), /turned inside out/);
});
