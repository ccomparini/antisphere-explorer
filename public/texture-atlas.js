// A mesh's textures, pre-distorted into one atlas, so each face of its tree
// needs only an offset (a node's "textureOffset", scene-format.md).
//
// A model's UV layout is its artist's: a point on it can't say where its
// colour is in the image. But a plane node's texture coordinates are its
// frame() coordinates in units of the material's scale, plus its offset.
// So each face - a plane node and the triangles lying in it, as
// meshToTree()'s onFace reports them - gets a patch of the atlas laid out
// in its own frame coordinates, turned to lie in its tightest rectangle,
// each texel painted with the source's colour at the point it stands for
// (by that point's source triangle and its UVs), and the patches are
// packed into one square image by the texels each actually needs, so
// triangles interlock. The texture then lies
// exactly where the shader's planar texture puts it, and coplanar triangles
// from different UV islands simply share their face's patch.
//
//   const { size, rgba, scale, offsets } = buildTextureAtlas(faces, sources);
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

const turned = (p, c, s) => [c * p[0] - s * p[1], s * p[0] + c * p[1]];

// The convex hull of 2D points (monotone chain), anticlockwise.
function hull(points) {
  const ps = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    return out.slice(0, -1);
  };
  return [...half(ps), ...half(ps.slice().reverse())];
}

/**
 * The turn that lays a face's points in their tightest rectangle (one side
 * along an edge of their hull), lying flat - wider than tall - so patches
 * stack in low shelves.
 */
function flatTurn(points) {
  const h = hull(points);
  let best = { area: Infinity, turn: 0, wide: true };
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const turn = -Math.atan2(b[1] - a[1], b[0] - a[0]), c = Math.cos(turn), s = Math.sin(turn);
    const r = h.map((p) => turned(p, c, s));
    const w = Math.max(...r.map((p) => p[0])) - Math.min(...r.map((p) => p[0]));
    const t = Math.max(...r.map((p) => p[1])) - Math.min(...r.map((p) => p[1]));
    if (w * t < best.area) best = { area: w * t, turn, wide: w >= t };
  }
  return best.wide ? best.turn : best.turn + Math.PI / 2;
}

// The x extent of 2D triangle `tri` between heights y0 and y1, or null.
function xExtentInBand(tri, y0, y1) {
  let lo = Infinity, hi = -Infinity;
  const take = (x) => { if (x < lo) lo = x; if (x > hi) hi = x; };
  for (let k = 0; k < 3; k++) {
    const a = tri[k], b = tri[(k + 1) % 3];
    if (a[1] >= y0 && a[1] <= y1) take(a[0]);
    for (const y of [y0, y1]) {
      if ((a[1] - y) * (b[1] - y) < 0) take(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * A face's patch, turned by `turn`, at `texel` world units a texel: its
 * size, the frame point of its corner texel's corner (X0, Y0), and each
 * row's span - the texels the shader may read for it, rows up the face:
 * a texel's centre within a texel, each way, of the face (bilinear
 * filtering reads the four nearest), and a little more for rounding.
 */
function patchOf(face, turn, texel) {
  const c = Math.cos(turn), s = Math.sin(turn);
  const tris = face.flat.map((tri) => tri.map((p) => turned(p, c, s)));
  const all = tris.flat();
  const lo = [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1]))];
  const hi = [Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))];
  const w = Math.ceil((hi[0] - lo[0]) / texel) + 2 * BORDER, h = Math.ceil((hi[1] - lo[1]) / texel) + 2 * BORDER;
  const X0 = lo[0] - BORDER * texel, Y0 = lo[1] - BORDER * texel, reach = 1.25 * texel;
  const spans = [];
  let texels = 0;
  for (let j = 0; j < h; j++) {
    const cy = Y0 + (j + 0.5) * texel;
    let xs = null;
    for (const tri of tris) {
      const e = xExtentInBand(tri, cy - reach, cy + reach);
      if (e) xs = xs ? [Math.min(xs[0], e[0]), Math.max(xs[1], e[1])] : e;
    }
    if (!xs) { spans.push(null); continue; }
    const l = Math.max(0, Math.ceil((xs[0] - reach - X0) / texel - 0.5));
    const r = Math.min(w - 1, Math.floor((xs[1] + reach - X0) / texel - 0.5));
    spans.push(l <= r ? [l, r] : null);
    if (l <= r) texels += r - l + 1;
  }
  return { turn, w, h, X0, Y0, spans, texels };
}

/**
 * Patches packed into a square of side `size`, by their spans: in shelves,
 * tallest first, each shelf keeping the rightmost texel used in each of
 * its rows, so a patch goes as far left as its own rows allow - a
 * triangle's slope meeting its neighbour's. Each face may go either way up
 * (`options[k]`, its patch and its patch turned half round), top or bottom
 * of the shelf, whichever sits furthest left: triangles interlock in
 * pairs. A texel's margin round the edge (the sampler wraps). Each face's
 * { patch, x, y } (y its top row), or null if they don't fit.
 */
function pack(options, size) {
  const order = options.map((_, i) => i).sort((a, b) => options[b][0].h - options[a][0].h);
  const out = new Array(options.length);
  let top = 1, height = 0, right = [];
  const fit = (patch, off) => {
    let x = -Infinity;
    for (let k = 0; k < patch.h; k++) {
      const span = patch.spans[patch.h - 1 - k];                // rows down the shelf
      if (span) x = Math.max(x, right[off + k] - span[0], 1 - span[0]);
    }
    const widest = Math.max(...patch.spans.map((sp) => (sp ? sp[1] : -Infinity)));
    return x + widest <= size - 2 ? x : Infinity;
  };
  for (const k of order) {
    let best = null;
    for (const patch of options[k]) {
      if (patch.h > height) continue;
      for (const off of [0, height - patch.h]) {
        const x = fit(patch, off);
        if (x < Infinity && (!best || x < best.x)) best = { patch, off, x };
      }
    }
    if (!best) {
      // A new shelf, as tall as this patch.
      top += height;
      height = Math.max(...options[k].map((p) => p.h));
      if (top + height > size - 1) return null;
      right = new Array(height).fill(1);
      for (const patch of options[k]) {
        const x = fit(patch, 0);
        if (x < Infinity && (!best || x < best.x)) best = { patch, off: 0, x };
      }
      if (!best) return null;
    }
    const { patch, off, x } = best;
    for (let r = 0; r < patch.h; r++) {
      const span = patch.spans[patch.h - 1 - r];
      if (span) right[off + r] = Math.max(right[off + r], x + span[1] + 1);
    }
    out[k] = { patch, x, y: top + off };
  }
  return out;
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
 * node -> [du, dv, degrees], its "textureOffset"), texel (the world size
 * of a texel) }. `maxSize` caps the side, the texels made bigger to fit;
 * `density`, texels per unit, overrides the one worked out from the
 * sources (their total texel area over their total area, so the atlas
 * keeps about the detail they had).
 */
export function buildTextureAtlas(faces, sources, { maxSize = 4096, density = null } = {}) {
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
  // Each face in its own frame: its triangles, and the turn laying them flat.
  const laid = faces.map(({ node, tris }) => {
    const frame = faceFrame(node.plane);
    const flat = tris.map((tri) => tri.map(frame.at));
    return { node, tris, frame, flat, turn: flatTurn(flat.flat()) };
  });
  // An untextured model needs a texel a face, about: its colours are flat.
  if (!(density > 0)) {
    const span = Math.max(...laid.map((f) => {
      const ps = f.flat.flat();
      return Math.max(Math.max(...ps.map((p) => p[0])) - Math.min(...ps.map((p) => p[0])),
                      Math.max(...ps.map((p) => p[1])) - Math.min(...ps.map((p) => p[1])));
    }), 1e-9);
    density = 1 / span;
  }

  // Patches, at a texel size, packed: grown until they fit, the texels
  // coarsened if even maxSize won't hold them.
  let texel = 1 / density, placed, size;
  for (;;) {
    const options = laid.map((f) => [patchOf(f, f.turn, texel), patchOf(f, f.turn + Math.PI, texel)]);
    const used = options.reduce((n, [p]) => n + p.texels, 0);
    size = Math.max(4, Math.ceil(Math.sqrt(used) * 1.05) + 2, ...options.map(([p]) => Math.max(p.w, p.h) + 2));
    while (size <= maxSize && !(placed = pack(options, size))) size = Math.ceil(size * 1.03) + 1;
    if (size <= maxSize && placed) break;
    texel *= 1.25;
  }

  const rgba = new Uint8Array(size * size * 4);
  const offsets = new Map();
  const scale = texel * size;
  laid.forEach((f, k) => {
    const { patch, x: px, y: py } = placed[k], { w, h, X0, Y0, turn } = patch;
    // The patch's texel (i, j) - j up the face - is the atlas's column
    // px + i, row py + h - 1 - j (rows top to bottom, v up), and the
    // shader's frame(P) / scale, turned, plus (du, dv), lands on its
    // centre (planarTexture()).
    const du = (px - X0 / texel) / size, dv = 1 - (py + h + Y0 / texel) / size;
    offsets.set(f.node, [du - Math.floor(du), dv - Math.floor(dv), (turn * 180) / Math.PI]);
    const c = Math.cos(-turn), s = Math.sin(-turn);
    patch.spans.forEach((span, j) => {
      if (!span) return;
      for (let i = span[0]; i <= span[1]; i++) {
        // The texel's centre, back in the face's frame.
        const q = turned([X0 + (i + 0.5) * texel, Y0 + (j + 0.5) * texel], c, s);
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
          const P = [0, 1, 2].map((d) => best.w[0] * piece[0][d] + best.w[1] * piece[1][d] + best.w[2] * piece[2][d]);
          const ws = barycentric(f.frame.at(P), src.tri.map(f.frame.at)) ?? [1, 0, 0];
          const uv = [0, 1].map((d) => ws[0] * src.uv[0][d] + ws[1] * src.uv[1][d] + ws[2] * src.uv[2][d]);
          colour = sample(src.image, uv).map((v, d) => v * src.factor[d]);
        }
        const o = ((py + h - 1 - j) * size + px + i) * 4;
        rgba[o] = toSRGB(colour[0]); rgba[o + 1] = toSRGB(colour[1]); rgba[o + 2] = toSRGB(colour[2]); rgba[o + 3] = 255;
      }
    });
  });
  return { size, rgba, scale, offsets, texel };
}
