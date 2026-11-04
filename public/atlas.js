// A mesh's textures, pre-distorted into one atlas, so each face of its tree
// needs only an offset (a node's "textureOffset", scene-format.md).
//
// A model's UV layout is its artist's: a point on it can't say where its
// colour is in the image. But a plane node's texture coordinates are its
// frame() coordinates in units of the material's scale, plus its offset.
// So each face - a plane node and the triangles lying in it, as
// meshToTree()'s onFace reports them - gets a patch of the atlas laid out
// in its own frame coordinates, each texel painted with the source's colour
// at the point it stands for (by that point's source triangle and its UVs),
// and the patches are packed into one square image. The texture then lies
// exactly where the shader's planar texture puts it, and coplanar triangles
// from different UV islands simply share their face's patch.
//
//   const { size, rgba, scale, offsets } = buildAtlas(faces, sources);
//
// Colours are mixed as light (sRGB made linear, as the shader does: power
// 2.2), times each material's factor, and written back as sRGB.

import { planeFrame } from './antisphere-scene.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const BORDER = 1;                           // texels round each patch, for bilinear filtering

/** A face's frame coordinates, as the shader's frame() has them: (P . t, P . b). */
export function faceFrame(plane) {
  const n = plane.normal, l = Math.hypot(...n);
  // A plane node's linear term is half its unit normal (planeFrame()).
  const { t, b } = planeFrame({ linear: n.map((v) => v / (2 * l)) });
  return { t, b, at: (p) => [dot(p, t), dot(p, b)] };
}

// Barycentric coordinates of point q in 2D triangle [a, b, c], or null if
// it is degenerate.
function barycentric(q, [a, b, c]) {
  const v0 = [b[0] - a[0], b[1] - a[1]], v1 = [c[0] - a[0], c[1] - a[1]], v2 = [q[0] - a[0], q[1] - a[1]];
  const det = v0[0] * v1[1] - v1[0] * v0[1];
  if (!(Math.abs(det) > 0)) return null;
  const y = (v2[0] * v1[1] - v1[0] * v2[1]) / det, z = (v0[0] * v2[1] - v2[0] * v0[1]) / det;
  return [1 - y - z, y, z];
}

// The point of 2D triangle `tri` nearest q, and its squared distance.
function nearestIn(q, tri) {
  const w = barycentric(q, tri);
  if (w && w.every((x) => x >= 0)) return { w, d2: 0 };
  let best = null;
  for (let i = 0; i < 3; i++) {
    const a = tri[i], b = tri[(i + 1) % 3];
    const ab = [b[0] - a[0], b[1] - a[1]], len2 = ab[0] * ab[0] + ab[1] * ab[1];
    const s = len2 > 0 ? Math.min(1, Math.max(0, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]) / len2)) : 0;
    const p = [a[0] + s * ab[0], a[1] + s * ab[1]], d2 = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
    if (!best || d2 < best.d2) { const wb = [0, 0, 0]; wb[i] = 1 - s; wb[(i + 1) % 3] = s; best = { w: wb, d2 }; }
  }
  return best;
}

const toLinear = (c) => (c / 255) ** 2.2;
const toSRGB = (x) => Math.round(255 * Math.min(1, Math.max(0, x)) ** (1 / 2.2));

/** An image's colour at uv (v up), bilinear, repeating, as light: as the shader's planarTexture(). */
export function sample(image, [u, v]) {
  const { width: W, height: H, rgba } = image;
  const x = (u - Math.floor(u)) * W - 0.5, y = (1 - (v - Math.floor(v))) * H - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const at = (i, j) => {
    const o = ((((j % H) + H) % H) * W + (((i % W) + W) % W)) * 4;
    return [toLinear(rgba[o]), toLinear(rgba[o + 1]), toLinear(rgba[o + 2])];
  };
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
  return [0, 1, 2].map((k) => (a[k] * (1 - fx) + b[k] * fx) * (1 - fy) + (c[k] * (1 - fx) + d[k] * fx) * fy);
}

// Rectangles packed into a square of side `size`, in shelves, tallest
// first, a texel's margin round the edge (the sampler wraps): each one's
// corner, or null if they don't fit.
function pack(rects, size) {
  const order = rects.map((_, i) => i).sort((a, b) => rects[b].h - rects[a].h);
  const at = new Array(rects.length);
  let x = 1, y = 1, shelf = 0;
  for (const i of order) {
    const { w, h } = rects[i];
    if (x + w > size - 1) { x = 1; y += shelf; shelf = 0; }
    if (x + w > size - 1 || y + h > size - 1) return null;
    at[i] = [x, y];
    x += w;
    shelf = Math.max(shelf, h);
  }
  return at;
}

/**
 * The atlas for a mesh's faces.
 *
 * `faces`: [{ node, tris }], each a plane node ({ plane: { normal, offset } })
 * and the triangles in it, each with `source`, an index into `sources`.
 * `sources[i]`: { tri (its corners, as the mesh had them), uv (its corners'
 * UVs, v up, or null), image ({ width, height, rgba }, sRGB, or null),
 * factor ([r, g, b], linear) }.
 *
 * Returns { size (the square atlas's side, in texels), rgba, scale (the
 * world size of the whole atlas: the material's "scale"), offsets (a Map,
 * node -> [du, dv], its "textureOffset"), texel (the world size of a
 * texel) }. `maxSize` caps the side, the texels made bigger to fit;
 * `density`, texels per unit, overrides the one worked out from the
 * sources (their total texel area over their total area, so the atlas
 * keeps about the detail they had).
 */
export function buildAtlas(faces, sources, { maxSize = 4096, density = null } = {}) {
  faces = faces.filter((f) => f.tris.length);
  // Texels per unit, from the textured sources.
  if (density === null) {
    let texels = 0, area = 0;
    for (const s of sources) {
      if (!s.image || !s.uv) continue;
      const [a, b, c] = s.tri, [p, q, r] = s.uv;
      const e1 = a.map((v, i) => b[i] - v), e2 = a.map((v, i) => c[i] - v);
      const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      area += Math.hypot(...cr) / 2;
      texels += Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2 * s.image.width * s.image.height;
    }
    density = area > 0 && texels > 0 ? Math.sqrt(texels / area) : 0;
  }
  // Each face in its own frame: its triangles, and their bounds.
  const laid = faces.map(({ node, tris }) => {
    const frame = faceFrame(node.plane);
    const flat = tris.map((tri) => tri.map(frame.at));
    const xs = flat.flat().map((p) => p[0]), ys = flat.flat().map((p) => p[1]);
    return { node, tris, frame, flat, lo: [Math.min(...xs), Math.min(...ys)], hi: [Math.max(...xs), Math.max(...ys)] };
  });
  // An untextured model needs a texel a face, about: its colours are flat.
  if (!(density > 0)) {
    const span = Math.max(...laid.map((f) => Math.max(f.hi[0] - f.lo[0], f.hi[1] - f.lo[1])), 1e-9);
    density = 1 / span;
  }

  // Patches, at a texel size, packed: grown until they fit, the texels
  // coarsened if even maxSize won't hold them.
  let texel = 1 / density, rects, at, size;
  for (;;) {
    rects = laid.map((f) => ({
      w: Math.ceil((f.hi[0] - f.lo[0]) / texel) + 2 * BORDER,
      h: Math.ceil((f.hi[1] - f.lo[1]) / texel) + 2 * BORDER,
    }));
    const area = rects.reduce((n, r) => n + r.w * r.h, 0);
    size = Math.max(4, Math.ceil(Math.sqrt(area) * 1.1) + 2, ...rects.map((r) => Math.max(r.w, r.h) + 2));
    while (size <= maxSize && !(at = pack(rects, size))) size = Math.ceil(size * 1.05) + 1;
    if (size <= maxSize && at) break;
    texel *= 1.25;
  }

  const rgba = new Uint8Array(size * size * 4);
  const offsets = new Map();
  const scale = texel * size;
  laid.forEach((f, k) => {
    const { w, h } = rects[k], [px, py] = at[k];
    const X0 = f.lo[0] - BORDER * texel, Y0 = f.lo[1] - BORDER * texel;
    // The patch's texel (i, j) - j up the face - is the atlas's column
    // px + i, row py + h - 1 - j (rows top to bottom, v up), and the
    // shader's (P . t / scale + du, P . b / scale + dv) lands on its
    // centre (planarTexture()).
    const du = (px - X0 / texel) / size, dv = 1 - (py + h + Y0 / texel) / size;
    offsets.set(f.node, [du - Math.floor(du), dv - Math.floor(dv)]);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const q = [X0 + (i + 0.5) * texel, Y0 + (j + 0.5) * texel];
        // The face's triangle holding it, or nearest it.
        let best = null;
        for (let t = 0; t < f.flat.length; t++) {
          const near = nearestIn(q, f.flat[t]);
          if (near && (!best || near.d2 < best.d2)) best = { ...near, t };
          if (best?.d2 === 0) break;
        }
        const src = sources[f.tris[best.t].source];
        let colour = src.factor;
        if (src.image && src.uv) {
          // The point, by the piece's barycentrics; its UV, by the source
          // triangle's (the piece lies within it, in its plane).
          const piece = f.tris[best.t];
          const P = [0, 1, 2].map((c) => best.w[0] * piece[0][c] + best.w[1] * piece[1][c] + best.w[2] * piece[2][c]);
          const ws = barycentric(f.frame.at(P), src.tri.map(f.frame.at)) ?? [1, 0, 0];
          const uv = [0, 1].map((c) => ws[0] * src.uv[0][c] + ws[1] * src.uv[1][c] + ws[2] * src.uv[2][c]);
          colour = sample(src.image, uv).map((x, c) => x * src.factor[c]);
        }
        const o = ((py + h - 1 - j) * size + px + i) * 4;
        rgba[o] = toSRGB(colour[0]); rgba[o + 1] = toSRGB(colour[1]); rgba[o + 2] = toSRGB(colour[2]); rgba[o + 3] = 255;
      }
    }
  });
  return { size, rgba, scale, offsets, texel };
}
