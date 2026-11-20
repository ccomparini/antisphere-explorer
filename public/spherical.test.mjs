// Tests for spherical patterns as compiled: a material projected
// spherically, its pattern and level, and each node's frame - turned with
// the node, and by "textureRotate" (scene-format.md, "projection"). Run with:
//   node --test public/spherical.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene } from './antisphere-scene.js';
import { PATTERN_SPHERE_BANDS, PATTERN_SPHERE_CELLS, PATTERN_SPHERE_NOISE } from './gen/layouts.js';

const compile = (spec, warned = []) =>
  compileScene({ lights: [], ...spec }, { path: 'scenes/s.json', warn: (path, msg) => warned.push(`${path}: ${msg}`) });
const ball = (extra = {}) => ({ sphere: { center: [0, 0, 0], radius: 1 }, material: 'globe', ...extra });
const near = (a, b, tol = 1e-12) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
// The frame of node i's material: its quaternion, sign made positive in w.
const frameOf = (built, i) => {
  const q = built.materials[built.nodes[i].material].frame ?? [0, 0, 0, 1];
  return q[3] < 0 ? q.map((v) => -v) : q;
};
const S = Math.SQRT1_2;

test('a spherical material: its pattern and level; slips warned of, and drawn in its albedo', () => {
  const warned = [];
  const built = compile({ materials: {
    globe: { projection: 'spherical', pattern: 'bands', level: 7 },
    cells: { projection: 'spherical' },
    noisy: { projection: 'spherical', pattern: 'noise' },
    checky: { projection: 'spherical', pattern: 'checker' },
    deep: { projection: 'spherical', pattern: 'bands', level: 40 },
    flatBands: { pattern: 'bands' },
  }, root: ball() }, warned);
  const m = (name) => built.materials.find((x) => x.name === name);
  assert.equal(m('globe').pattern, PATTERN_SPHERE_BANDS);
  assert.equal(m('globe').level, 7);
  assert.equal(m('cells').pattern, PATTERN_SPHERE_CELLS, 'cells by default');
  assert.equal(m('cells').level, 5, 'level 5 by default');
  assert.equal(m('noisy').pattern, PATTERN_SPHERE_NOISE, 'noise, projected spherically');
  assert.equal(m('checky').pattern, 0);
  assert.equal(m('deep').level, 5);
  assert.equal(m('flatBands').pattern, 0);
  for (const said of [/checky\.pattern: projected spherically, the patterns are cells, noise, bands/,
                      /deep\.level: is a whole number, 0 to 10, not 40: 5/,
                      /flatBands\.pattern: "bands" is a spherical pattern: give it "projection": "spherical"/]) {
    assert.ok(warned.some((w) => said.test(w)), `${said}: ${warned.join('; ')}`);
  }
});

test('its frame: the world\'s as written; turned with the node; turned by textureRotate; the two composed', () => {
  const materials = { globe: { projection: 'spherical', pattern: 'bands' } };
  const quarter = { axis: [1, 0, 0], degrees: 90 };
  assert.ok(near(frameOf(compile({ materials, root: ball() }), 1), [0, 0, 0, 1]));
  assert.ok(near(frameOf(compile({ materials, root: ball({ rotate: quarter }) }), 1), [S, 0, 0, S], 1e-12), 'turned with it');
  assert.ok(near(frameOf(compile({ materials, root: ball({ textureRotate: quarter }) }), 1), [S, 0, 0, S], 1e-12), 'by textureRotate');
  // Turned back by textureRotate as much as the node turns: as written.
  const undone = compile({ materials, root: ball({ rotate: quarter, textureRotate: { axis: [1, 0, 0], degrees: -90 } }) });
  assert.ok(near(frameOf(undone, 1), [0, 0, 0, 1], 1e-12), `${frameOf(undone, 1)}`);
  // Moved and scaled, not turned: the frame is the world's still.
  const moved = compile({ materials, root: ball({ translate: [3, 4, 5], scale: 2 }) });
  assert.ok(near(frameOf(moved, 1), [0, 0, 0, 1], 1e-12));
  // An object used turned: its spheres' frames turn with it.
  const used = compile({ materials, objects: { b: ball() }, root: { use: 'b', rotate: { axis: [0, 0, 1], degrees: 90 } } });
  assert.ok(near(frameOf(used, 1), [0, 0, S, S], 1e-12));
});

test('nodes framed alike share a copy; a spheroid has one too; a plane has no centre, and is warned of', () => {
  const materials = { globe: { projection: 'spherical' }, stone: {} };
  const warned = [];
  const built = compile({ materials, root: { group: [
    ball({ sphere: { center: [-3, 0, 0], radius: 1 } }),
    ball({ sphere: { center: [3, 0, 0], radius: 1 } }),
    { spheroid: { center: [0, 3, 0], axis: [0, 0, 1], height: 1, radius: 2 }, material: 'globe' },
    { plane: { normal: [0, 0, 1], offset: -5 }, material: 'globe', textureRotate: { axis: [0, 0, 1], degrees: 10 } },
  ] } }, warned);
  const globes = built.nodes.map((n, i) => [n, i]).filter(([n]) => built.materials[n.material]?.name === 'globe');
  const framed = new Set(globes.filter(([n]) => built.materials[n.material].pattern === PATTERN_SPHERE_CELLS).map(([n]) => n.material));
  assert.equal(framed.size, 1, 'the two balls and the spheroid, framed alike: one copy');
  assert.ok(globes.some(([n]) => built.materials[n.material].pattern === 0), 'the plane: drawn in its albedo');
  assert.ok(warned.some((w) => /textureRotate: turns a spherical pattern, on a sphere or spheroid: this is neither - ignored/.test(w)), warned.join('; '));
  assert.ok(warned.some((w) => /1 node\(s\) with a spherical pattern have no centre to project from/.test(w)), warned.join('; '));
});

test('a spherical texture is not drawn yet: warned of and left out, its pattern drawn', () => {
  const warned = [];
  const built = compile({ materials: { globe: { projection: 'spherical', pattern: 'bands', texture: 'earth.png' } }, root: ball() }, warned);
  assert.ok(warned.some((w) => /globe\.texture: a spherical texture is not drawn yet/.test(w)), warned.join('; '));
  const m = built.materials[built.nodes[1].material];
  assert.equal(m.texture, 0);
  assert.equal(m.pattern, PATTERN_SPHERE_BANDS);
});
