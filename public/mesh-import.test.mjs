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
import { meshToTree, treeStats, planeOfTriangle, boundsOf } from './mesh-import.js';

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

const compile = (tree) => compileScene({
  materials: { clay: {} }, lights: [],
  root: { sphere: { center: [0, 0, 0], radius: 1000 }, inside: tree },
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
  const tree = meshToTree(tet, { material: 'clay' });
  const stats = treeStats(tree);
  assert.equal(stats.nodes, 4, JSON.stringify(stats));
  assert.equal(stats.solidLeaves, 1, 'a convex solid has one inside');
  const { wrong, inside, tested } = agreesWithMesh(tet, tree);
  assert.ok(inside > 20, `only ${inside} of ${tested} points landed inside`);
  assert.equal(wrong, 0);
});

test('a box, which nesting alone could also have managed', () => {
  const mesh = boxMesh([-1,-1,-1], [1,1,1]);
  const tree = meshToTree(mesh, { material: 'clay' });
  assert.equal(treeStats(tree).nodes, 6, 'one node per face, not one per triangle');
  assert.equal(treeStats(tree).solidLeaves, 1);
  const { wrong, inside } = agreesWithMesh(mesh, tree);
  assert.ok(inside > 100);
  assert.equal(wrong, 0);
});

test('an L-prism, which it could not', () => {
  const mesh = lPrismMesh();
  const tree = meshToTree(mesh, { material: 'clay' });
  const { wrong, inside } = agreesWithMesh(mesh, tree);
  assert.ok(inside > 100, 'the arms are there');
  assert.equal(wrong, 0);
  // The whole point: more than one solid region, which no chain of nested
  // half-spaces can have.
  assert.ok(treeStats(tree).solidLeaves >= 2, 'concavity means branching');
});

test('a curved closed surface keeps its geometry', () => {
  const mesh = icosphereMesh(2);
  const tree = meshToTree(mesh, { material: 'clay' });
  const { wrong, inside, tested } = agreesWithMesh(mesh, tree);
  assert.ok(inside > 100, `${inside} of ${tested} inside`);
  assert.equal(wrong, 0, `${wrong} of ${tested} points disagree`);
});

test('a torus: curved, hollow in the middle, and split to pieces', () => {
  const mesh = torusMesh();
  const tree = meshToTree(mesh, { material: 'clay' });
  const stats = treeStats(tree);
  const { wrong, inside, tested } = agreesWithMesh(mesh, tree);
  assert.ok(inside > 100, `${inside} of ${tested} inside — is the solid there at all?`);
  assert.equal(wrong, 0, `${wrong} of ${tested} points disagree (${JSON.stringify(stats)})`);
  assert.ok(stats.solidLeaves >= 2, 'a torus is not convex');
});

test('where nothing divides, the outermost faces come first', () => {
  // A convex model has no dividing plane, so every node is a supporting one
  // and its outside is void: each turns away every ray passing wide of it.
  for (const mesh of [boxMesh([-1,-1,-1], [1,1,1]), icosphereMesh(1)]) {
    const tree = meshToTree(mesh, { material: 'clay' });
    assert.ok(!('outside' in tree), 'the root turns away everything past it');
    assert.ok(!('outside' in tree.inside), 'and so does the next');
  }
  // And they are taken outermost first, so the cheapest question is asked
  // soonest: the first plane sheds more of the model's box than the tenth.
  const tree = meshToTree(icosphereMesh(2), { material: 'clay' });
  const shed = (node) => node.plane.offset;          // unit sphere: offset is the reach
  let first = tree, tenth = tree;
  for (let i = 0; i < 10 && tenth.inside; i++) tenth = tenth.inside;
  assert.ok(shed(first) <= shed(tenth) + 1e-9,
            `first sheds ${shed(first)}, tenth ${shed(tenth)}`);
});

test('a box is its own bounding box', () => {
  const mesh = boxMesh([-1,-1,-1], [1,1,1]);
  const tree = meshToTree(mesh, { material: 'clay' });
  assert.equal(treeStats(tree).nodes, 6, 'six faces, and no separate bound');
  const { wrong, inside } = agreesWithMesh(mesh, tree);
  assert.ok(inside > 100);
  assert.equal(wrong, 0);
});

test('an empty or degenerate mesh makes no tree', () => {
  assert.equal(meshToTree([], { material: 'clay' }), null);
  const flat = [[[0,0,0],[1,0,0],[2,0,0]]];        // no area
  assert.equal(meshToTree(flat, { material: 'clay' }), null);
});
