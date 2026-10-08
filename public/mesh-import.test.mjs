// Tests for mesh import. Run with:
//   node --test mesh-import.test.mjs
//
// The ground truth is the mesh itself: a point is inside when a ray from it
// crosses the surface an odd number of times. Every tree is judged against
// that, at points clear of the surface, so a tree that loses geometry is
// caught rather than admired for its node count.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene } from './antisphere-scene.js';
import { meshToTree, treeStats, planeOfTriangle, boundsOf, boundingSpheroid } from './mesh-import.js';

const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

/** Möller-Trumbore, for the parity test below. */
function raySrikesTriangle(origin, dir, [a, b, c]) {
  const e1 = sub(b, a), e2 = sub(c, a), h = cross(dir, e2), det = dot(e1, h);
  if (Math.abs(det) < 1e-12) return false;
  const s = sub(origin, a), u = dot(s, h) / det;
  if (u < 0 || u > 1) return false;
  const q = cross(s, e1), v = dot(dir, q) / det;
  if (v < 0 || u + v > 1) return false;
  return dot(e2, q) / det > 1e-9;
}

/**
 * Inside the mesh? Three directions, and whether they agree.
 *
 * A single ray that grazes an edge is counted twice or not at all, and no
 * epsilon settles that reliably - but three directions disagreeing is a
 * good sign the point is too close to the surface to judge, which is also
 * exactly where a converted tree is allowed to differ.
 */
function insideMesh(triangles, point) {
  const dirs = [[0.5773, 0.5774, 0.5775], [-0.2673, 0.5345, 0.8018], [0.8018, -0.5345, 0.2673]];
  let odd = 0;
  for (const dir of dirs) {
    let hits = 0;
    for (const tri of triangles) if (raySrikesTriangle(point, dir, tri)) hits++;
    if (hits % 2 === 1) odd++;
  }
  return { inside: odd >= 2, sure: odd === 0 || odd === 3 };
}

/** Walk the compiled tree the way trace() does: is this point solid? */
function solidAt(built, R) {
  let index = 1, found = 0;
  for (let step = 0; step < 20000 && index !== 0; step++) {
    const nd = built.nodes[index];
    const p = nd.prim;
    const along = dot(p.axis, R);
    const H = p.k_perp * dot(R, R) + (p.k_par - p.k_perp) * along * along
            + 2 * dot(p.linear, R) + p.constant;
    if (H < 0) {
      if (built.materials[nd.material].solid) { if (!found) found = index; } else found = 0;
      index = nd.inside;
    } else {
      found = 0;
      index = nd.outside;
    }
  }
  return found !== 0;
}

// A converted mesh names no material, so it is placed inside a node that
// does - here the root - whose material its nodes inherit.
const compile = (tree) => compileScene({
  materials: { clay: {} }, lights: [],
  objects: { mesh: tree },
  root: { sphere: { center: [0, 0, 0], radius: 1000 }, material: 'clay', inside: { use: 'mesh' } },
});

/**
 * Compare a converted mesh against the mesh itself, at every point the
 * parity test is sure about.
 */
function agreesWithMesh(triangles, tree, { samples = 2000 } = {}) {
  const built = compile(tree);
  const { lo, hi } = boundsOf(triangles);
  const pad = Math.max(hi[0]-lo[0], hi[1]-lo[1], hi[2]-lo[2]) * 0.2;
  let tested = 0, inside = 0, wrong = 0, skipped = 0;
  for (let k = 0; k < samples; k++) {
    const p = [0, 1, 2].map((i) => lo[i] - pad + Math.random() * (hi[i] - lo[i] + 2 * pad));
    const verdict = insideMesh(triangles, p);
    if (!verdict.sure) { skipped++; continue; }
    tested++;
    if (verdict.inside) inside++;
    if (verdict.inside !== solidAt(built, p)) wrong++;
  }
  return { tested, inside, wrong, skipped };
}

// -- the shapes ---------------------------------------------------------------------

/** Faces of a box, as triangles with outward normals. */
function boxMesh(lo, hi) {
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
  const v = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
  const quads = [[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
  return quads.flatMap(([a,b,c,d]) => [[v[a],v[b],v[c]], [v[a],v[c],v[d]]]);
}

/** An L-shaped prism: the simplest thing half-space nesting cannot do. */
function lPrismMesh() {
  const cap = [[0,0],[2,0],[2,1],[1,1],[1,2],[0,2]];
  const tris = [];
  for (let i = 1; i < cap.length - 1; i++) {
    tris.push([[...cap[0],1],[...cap[i],1],[...cap[i+1],1]]);
    tris.push([[...cap[0],0],[...cap[i+1],0],[...cap[i],0]]);
  }
  for (let i = 0; i < cap.length; i++) {
    const a = cap[i], b = cap[(i+1) % cap.length];
    tris.push([[...a,0],[...b,0],[...b,1]], [[...a,0],[...b,1],[...a,1]]);
  }
  return tris;
}

function icosphereMesh(level) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [[-1,t,0],[1,t,0],[-1,-t,0],[1,-t,0],[0,-1,t],[0,1,t],[0,-1,-t],[0,1,-t],
               [t,0,-1],[t,0,1],[-t,0,-1],[-t,0,1]].map((v) => {
    const l = Math.hypot(...v); return v.map((x) => x / l);
  });
  let faces = [[0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],[1,5,9],[5,11,4],[11,10,2],[10,7,6],
               [7,1,8],[3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],[4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1]];
  for (let s = 0; s < level; s++) {
    const next = [];
    for (const [a, b, c] of faces) {
      const mid = (i, j) => {
        const m = verts[i].map((v, k) => (v + verts[j][k]) / 2);
        const l = Math.hypot(...m);
        verts.push(m.map((x) => x / l));
        return verts.length - 1;
      };
      const ab = mid(a,b), bc = mid(b,c), ca = mid(c,a);
      next.push([a,ab,ca], [b,bc,ab], [c,ca,bc], [ab,bc,ca]);
    }
    faces = next;
  }
  return faces.map(([a,b,c]) => [verts[a], verts[b], verts[c]]);
}

/** A torus: non-convex, curved, and with a hole through it. */
function torusMesh(major = 1, minor = 0.35, nu = 24, nv = 12) {
  const P = (i, j) => {
    const u = 2 * Math.PI * i / nu, v = 2 * Math.PI * j / nv;
    return [(major + minor*Math.cos(v)) * Math.cos(u),
            (major + minor*Math.cos(v)) * Math.sin(u),
            minor * Math.sin(v)];
  };
  const tris = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = P(i,j), b = P(i+1,j), c = P(i+1,j+1), d = P(i,j+1);
      tris.push([a,b,c], [a,c,d]);
    }
  }
  return tris;
}

// -- what it should do ----------------------------------------------------------------

test('a tetrahedron is four planes and one solid region', () => {
  const tet = [[[0,0,0],[0,1,0],[1,0,0]], [[0,0,0],[0,0,1],[0,1,0]],
               [[0,0,0],[1,0,0],[0,0,1]], [[1,0,0],[0,1,0],[0,0,1]]];
  const tree = meshToTree(tet, { bound: false });
  const stats = treeStats(tree);
  assert.equal(stats.nodes, 4, JSON.stringify(stats));
  assert.equal(stats.solidLeaves, 1, 'a convex solid has one inside');
  const { wrong, inside, tested } = agreesWithMesh(tet, tree);
  assert.ok(inside > 20, `only ${inside} of ${tested} points landed inside`);
  assert.equal(wrong, 0);
});

test('a box, which nesting alone could also have managed', () => {
  const mesh = boxMesh([-1,-1,-1], [1,1,1]);
  const tree = meshToTree(mesh, { bound: false });
  assert.equal(treeStats(tree).nodes, 6, 'one node per face, not one per triangle');
  assert.equal(treeStats(tree).solidLeaves, 1);
  const { wrong, inside } = agreesWithMesh(mesh, tree);
  assert.ok(inside > 100);
  assert.equal(wrong, 0);
});

test('an L-prism, which it could not', () => {
  const mesh = lPrismMesh();
  const tree = meshToTree(mesh);
  const { wrong, inside } = agreesWithMesh(mesh, tree);
  assert.ok(inside > 100, 'the arms are there');
  assert.equal(wrong, 0);
  // The whole point: more than one solid region, which no chain of nested
  // half-spaces can have.
  assert.ok(treeStats(tree).solidLeaves >= 2, 'concavity means branching');
});

test('a curved closed surface keeps its geometry', () => {
  const mesh = icosphereMesh(2);
  const tree = meshToTree(mesh);
  const { wrong, inside, tested } = agreesWithMesh(mesh, tree);
  assert.ok(inside > 100, `${inside} of ${tested} inside`);
  assert.equal(wrong, 0, `${wrong} of ${tested} points disagree`);
});

test('a torus: curved, hollow in the middle, and split to pieces', () => {
  const mesh = torusMesh();
  const tree = meshToTree(mesh);
  const stats = treeStats(tree);
  const { wrong, inside, tested } = agreesWithMesh(mesh, tree);
  assert.ok(inside > 100, `${inside} of ${tested} inside — is the solid there at all?`);
  assert.equal(wrong, 0, `${wrong} of ${tested} points disagree (${JSON.stringify(stats)})`);
  assert.ok(stats.solidLeaves >= 2, 'a torus is not convex');
});

// Vertices as an STL stores them: float32. The two halves of each of a
// torus's flat quads then disagree about their plane by ~1e-7, far more
// than a tolerance scaled to float64 allows for.
const asFloat32 = (mesh) => mesh.map((tri) => tri.map((v) => v.map(Math.fround)));

/** Planes in the tree that are, to within a hair, one above them again. */
function planesRepeated(tree) {
  let repeated = 0;
  const walk = (t, above) => {
    if (!t) return;
    const { normal: n, offset } = t.plane;
    if (above.some((a) => dot(a.normal, n) > 1 - 1e-9 && Math.abs(a.offset - offset) < 1e-5)) repeated++;
    above.push(t.plane);
    walk(t.inside, above);
    walk(t.outside, above);
    above.pop();
  };
  walk(tree, []);
  return repeated;
}

test('a float32 torus: no plane twice, and right up to its surface', () => {
  const major = 1, minor = 0.35;
  const mesh = asFloat32(torusMesh(major, minor));
  const tree = meshToTree(mesh, { bound: false });
  // A repeated plane bounds a sliver between itself and its twin, reaching
  // right across the model: rays see it as specks in the air.
  assert.equal(planesRepeated(tree), 0, 'planes repeated');

  // Near the surface, where slivers and lost faces show: within 0.03 of the
  // tube, either side.
  const built = compile(tree);
  let tested = 0, wrong = 0, seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 3000; k++) {
    const u = rnd() * 2 * Math.PI, v = rnd() * 2 * Math.PI, w = minor + (rnd() - 0.5) * 0.06;
    const p = [(major + w * Math.cos(v)) * Math.cos(u), (major + w * Math.cos(v)) * Math.sin(u), w * Math.sin(v)];
    const verdict = insideMesh(mesh, p);
    if (!verdict.sure) continue;
    tested++;
    if (verdict.inside !== solidAt(built, p)) wrong++;
  }
  assert.ok(tested > 2500, `only ${tested} points judged`);
  assert.equal(wrong, 0, `${wrong} of ${tested} points near the surface disagree`);
});

test('by default the tree is wrapped in a spheroid round every vertex, its outside empty', () => {
  for (const mesh of [torusMesh(), icosphereMesh(2), boxMesh([2, 3, 4], [3, 3.6, 6])]) {
    const tree = meshToTree(mesh);
    assert.ok(tree.spheroid && tree.inside && !('outside' in tree), Object.keys(tree).join());
    // Spatial division only: no node, the wrapper or a face, names a material.
    const named = [];
    const walk = (t) => { if (!t) return; if ('material' in t) named.push(t); walk(t.inside); walk(t.outside); };
    walk(tree);
    assert.equal(named.length, 0, 'nodes naming a material');
    // Every vertex strictly inside it.
    const { center, axis, height, radius } = tree.spheroid;
    const worst = Math.max(...mesh.flat().map((p) => {
      const q = sub(p, center), x = dot(axis, q);
      const across = Math.hypot(q[0] - x * axis[0], q[1] - x * axis[1], q[2] - x * axis[2]);
      return Math.hypot(x / (height / 2), across / radius);
    }));
    assert.ok(worst < 1, `a vertex at ${worst} of the way out`);
    const { wrong, inside } = agreesWithMesh(mesh, tree);
    assert.ok(inside > 100);
    assert.equal(wrong, 0);
  }
  // A torus is flat, so its spheroid is too: about its axis, wider than tall.
  const { axis, height, radius } = boundingSpheroid(torusMesh());
  assert.ok(Math.abs(Math.abs(axis[2]) - 1) < 1e-9, `axis ${axis}`);
  assert.ok(height < radius, `height ${height}, radius ${radius}`);
});

test('where nothing divides, the outermost faces come first', () => {
  // A convex model has no dividing plane, so every node is a supporting one
  // and its outside is void: each turns away every ray passing wide of it.
  for (const mesh of [boxMesh([-1,-1,-1], [1,1,1]), icosphereMesh(1)]) {
    const tree = meshToTree(mesh, { bound: false });
    assert.ok(!('outside' in tree), 'the root turns away everything past it');
    assert.ok(!('outside' in tree.inside), 'and so does the next');
  }
  // And they are taken outermost first, so the cheapest question is asked
  // soonest: the first plane sheds more of the model's box than the tenth.
  const tree = meshToTree(icosphereMesh(2), { bound: false });
  const shed = (node) => node.plane.offset;          // unit sphere: offset is the reach
  let first = tree, tenth = tree;
  for (let i = 0; i < 10 && tenth.inside; i++) tenth = tenth.inside;
  assert.ok(shed(first) <= shed(tenth) + 1e-9,
            `first sheds ${shed(first)}, tenth ${shed(tenth)}`);
});

test('a box is its own bounding box', () => {
  const mesh = boxMesh([-1,-1,-1], [1,1,1]);
  const tree = meshToTree(mesh, { bound: false });
  assert.equal(treeStats(tree).nodes, 6, 'six faces, and no separate bound');
  const { wrong, inside } = agreesWithMesh(mesh, tree);
  assert.ok(inside > 100);
  assert.equal(wrong, 0);
});

test('an empty or degenerate mesh makes no tree', () => {
  assert.equal(meshToTree([]), null);
  const flat = [[[0,0,0],[1,0,0],[2,0,0]]];        // no area
  assert.equal(meshToTree(flat), null);
});

// -- passing triangles whole instead of cutting them -------------------------------

test('whole triangles give the same tree where nothing needs cutting', () => {
  // On these, a straddling triangle handed to both children reaches both,
  // and the result is exact - which is the appeal of never cutting.
  for (const mesh of [boxMesh([-1,-1,-1], [1,1,1]), lPrismMesh(), icosphereMesh(1)]) {
    const whole = meshToTree(mesh, { split: false, maxDepth: 300 });
    const { wrong, inside } = agreesWithMesh(mesh, whole, { samples: 800 });
    assert.ok(inside > 40, 'the solid is there');
    assert.equal(wrong, 0);
  }
});

test('whole triangles overfill a torus, which is why cutting is the default', () => {
  // A triangle passed to a child it does not actually reach can still be
  // chosen as that child's splitting plane, and then the region behind a
  // boundary that isn't there reads as solid. No holes - the error is
  // always extra material, bulging outside the surface.
  const mesh = torusMesh(1, 0.35, 12, 8);
  const whole = meshToTree(mesh, { split: false, maxDepth: 300 });
  // Rare now - ~0.2% of points - so enough samples to be sure of meeting it.
  const loose = agreesWithMesh(mesh, whole, { samples: 8000 });
  const cut = agreesWithMesh(mesh, meshToTree(mesh), { samples: 800 });
  assert.equal(cut.wrong, 0, 'cutting is exact');
  assert.ok(loose.wrong > 0,
            'if this ever passes, passing triangles whole has been made sound - ' +
            'check why, and make it the default');
});
