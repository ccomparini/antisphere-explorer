// Tests for atlas.js: a textured cube, every triangle its own UV island,
// pre-distorted into an atlas. Run with:
//   node --test public/atlas.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAtlas, faceFrame, sample } from './atlas.js';
import { meshToTree } from './mesh-import.js';
import { texturedCube } from './gltf-fixture.mjs';

// A smooth image, so resampling it changes little, but no two places alike.
function gradient(W, H) {
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgba.set([40 + (200 * x) / W, 40 + (200 * y) / H, 120, 255], (y * W + x) * 4);
  return { width: W, height: H, rgba };
}

function cubeAtlas(options = {}) {
  const image = gradient(48, 36);
  const { triangles, uvs } = texturedCube(new Uint8Array(0));
  const faces = [];
  meshToTree(triangles, { onFace: (node, tris) => faces.push({ node, tris }) });
  const sources = triangles.map((tri, i) => ({ tri, uv: uvs[i], image, factor: [1, 1, 1] }));
  return { image, triangles, uvs, faces, atlas: buildAtlas(faces, sources, options) };
}

test('the atlas: at points of every triangle, what frame(P) / scale, turned and slid by the face\'s offset, finds is the source at its UV', () => {
  const { image, triangles, uvs, faces, atlas } = cubeAtlas({ density: 200 });
  assert.equal(faces.length, 6, 'a face node a side');
  const picture = { width: atlas.size, height: atlas.size, rgba: atlas.rgba };
  let worst = 0;
  triangles.forEach((tri, k) => {
    const face = faces.find((f) => f.tris.some((t) => t.source === k));
    const frame = faceFrame(face.node.plane), [du, dv, degrees] = atlas.offsets.get(face.node);
    const c = Math.cos((degrees * Math.PI) / 180), s = Math.sin((degrees * Math.PI) / 180);
    for (const w of [[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.1, 0.8, 0.1], [0.15, 0.15, 0.7]]) {
      const P = [0, 1, 2].map((c) => w[0] * tri[0][c] + w[1] * tri[1][c] + w[2] * tri[2][c]);
      const uv = [0, 1].map((c) => w[0] * uvs[k][0][c] + w[1] * uvs[k][1][c] + w[2] * uvs[k][2][c]);
      const [fx, fy] = frame.at(P);
      const f = [fx / atlas.scale, fy / atlas.scale];
      const got = sample(picture, [c * f[0] - s * f[1] + du, s * f[0] + c * f[1] + dv]), want = sample(image, uv);
      worst = Math.max(worst, ...got.map((v, c) => Math.abs(v - want[c])));
    }
  });
  // In linear light; an island mixed up would be off by 0.1 or more.
  assert.ok(worst < 0.01, `worst difference ${worst}`);
});

test('the atlas: capped in size, its texels coarsened to fit; a factor tints it; untextured faces their factor', () => {
  const capped = cubeAtlas({ density: 2000, maxSize: 256 }).atlas;
  assert.ok(capped.size <= 256, `size ${capped.size}`);
  assert.ok(capped.texel > 1 / 2000);
  const { triangles } = texturedCube(new Uint8Array(0));
  const faces = [];
  meshToTree(triangles, { onFace: (node, tris) => faces.push({ node, tris }) });
  const flat = buildAtlas(faces, triangles.map((tri) => ({ tri, uv: null, image: null, factor: [0.5, 0.25, 1] })));
  const want = [0.5, 0.25, 1].map((x) => Math.round(255 * x ** (1 / 2.2)));
  for (let p = 0; p < flat.size * flat.size; p++) {
    const px = [...flat.rgba.subarray(4 * p, 4 * p + 3)];
    if (flat.rgba[4 * p + 3]) assert.deepEqual(px, want, `texel ${p}`);
  }
});
