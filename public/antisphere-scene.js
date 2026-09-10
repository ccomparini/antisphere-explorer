// ---------------------------------------------------------------------------
// Antisphere representation
//
//   A node stores five numbers: (n.xyz, a, k)
//     n  unit normal at the near diametric point P0
//     a  signed distance from origin to P0 along n   (P0 = a*n)
//     k  signed curvature, k = 1/(a+b) = 1/(2r)
//
//   Implicit function:
//     f(R) = k(R.R) + (1 - 2ak)(R.n) - a + k a^2
//   f(R) < 0 means inside. For k > 0, f = k*(|R-C|^2 - r^2).
//   For k = 0 it collapses to R.n - a, the plane equation.
//
//   center C = (a - 1/(2k)) n,  radius r = 1/(2k)
//   Negating all five numbers gives the exact complement (f -> -f).
// ---------------------------------------------------------------------------

function sphere(center, radius) {
  const originDist = Math.hypot(center[0], center[1], center[2]);
  const unit = originDist > 1e-9
    ? center.map((v) => v / originDist) : [0, 0, 1];
  // P0 is the far intersection of the line through the origin, where the
  // outward normal is `unit`.
  return {
    surface_normal: unit,
    p0_dist: originDist + radius,
    curvature: 1 / (2 * radius),
  };
}

function plane(normal, offset) {
  const len = Math.hypot(normal[0], normal[1], normal[2]);
  return {
    surface_normal: normal.map((v) => v / len),
    p0_dist: offset / len,
    curvature: 0,
  };
}

// CSG complement: negate all five stored numbers.
function complement(prim) {
  return {
    surface_normal: prim.surface_normal.map((v) => -v),
    p0_dist: -prim.p0_dist,
    curvature: -prim.curvature,
  };
}

// ---------------------------------------------------------------------------
// Materials
//
// One table, indexed from both places:
//
//   Leaf substrate   what the region is made of. Index 0 is vacuum, which is
//                    how an empty leaf is spelled.
//   Node paint       the material of the surface that node generates, and the
//                    material in scope for the region f < 0 beneath it. It
//                    does not reach the outside child: to scope the far side,
//                    complement the node, which costs nothing.
//
// At a hit the material resolves in this order: the paint of the node whose
// surface was crossed, then the paint in scope from enclosing nodes, then the
// leaf substrate. So a carving node can differ from the body it carves, which
// is the whole point of having both.
//
// Node paint takes two sentinel values, plus any real material index:
//
//   INHERIT    takes whatever material is in scope. Mirrors how Node.env's
//              0 already means "inherit": no material of its own, so
//              nothing here overrides it. The builder is free to insert,
//              hoist, or drop INHERIT nodes without changing appearance,
//              which is also what PARTITION used to name; the two were
//              always identical at render time, so there is now just one.
//   BARE       clears the scope, revealing the leaf substrate underneath,
//              regardless of what an ancestor painted. Kept distinct from
//              INHERIT because scenes lean on it heavily (a carving node
//              painted BARE exposes its own substrate on either side, e.g.
//              scene.json's "bitten" object), and nothing else reproduces
//              that effect: INHERIT-style scope-threading only ever runs on
//              a node's inside, never its outside.
//
// Surface parameterization always comes from the node that was crossed, never
// from the material, so a node's own (n, a, k) supplies the frame: a tangent
// basis for planes, a center for spheres.
// ---------------------------------------------------------------------------

const INHERIT   =  0;
// Same value as INHERIT; kept as a separate name where it documents builder
// intent (a synthesized spatial split, not an authored material choice).
const PARTITION = INHERIT;
const BARE      = -1;

const PATTERNS = { flat: 0, checker: 1 };

// Each kind names a shading function in the shader. Adding one means a
// function and a switch arm there, plus an entry here and its parameters.
const KINDS = {
  lambert:  { id: 0, params: () => [0, 0] },
  glossy:   { id: 1, params: (d) => [d.shininess ?? 32, d.specular ?? 0.6] },
  emissive: { id: 2, params: (d) => [d.emission ?? 1, 0] },
  unlit:    { id: 3, params: () => [0, 0] },
  // An ambient container never shades. Naming one as a node's paint turns
  // that node into a pure partition whose albedo becomes the ambient level
  // for everything in its inside subtree.
  ambient:  { id: 4, params: () => [0, 0] },
};
const KIND_AMBIENT = 4;
const PAINT_WORDS = { partition: PARTITION, inherit: INHERIT, bare: BARE };

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

// A node: test f(R); f < 0 descends into `inside`, otherwise `outside`.
function node(prim, inside, outside, paint = INHERIT, env = 0) {
  return { prim, inside, outside, paint, env };
}

const EMPTY = 'empty';
const solid = (mat) => ({ leaf: mat });
const isLeaf = (t) => t === EMPTY || t.leaf !== undefined;

// Union: everything solid in `t` stays solid; every empty region of `t`
// is handed to `other`. Correct for any pair, and the shared subtree is
// deduplicated when the tree is flattened.
//
// Note that this drops `other` *inside* t's material scope, so a substituted
// object inherits t's paint unless it repaints itself.
function union(t, other) {
  if (t === EMPTY) return other;
  if (isLeaf(t)) return t;
  return node(t.prim, union(t.inside, other), union(t.outside, other), t.paint, t.env);
}

// Rigid translation of a primitive by a world-space offset. n and a are
// defined relative to the global origin (see the module comment up top),
// so translating anything - not just a sphere's center - changes both:
// recover the center implied by (n, a, k), move it, then re-derive (n, a)
// from the new center, keeping the same sign of (a - r) so a small move
// can't flip which side of the primitive counts as "inside". Curvature -
// the sphere's size, sign included - never changes under a translation.
function translatePrim(prim, t) {
  const { surface_normal: n, p0_dist: a, curvature: k } = prim;
  if (k === 0) {
    // A plane's normal doesn't move; only its offset does, by however far
    // along that normal the translation goes.
    const shift = n[0] * t[0] + n[1] * t[1] + n[2] * t[2];
    return { surface_normal: n, p0_dist: a + shift, curvature: k };
  }
  const r = 1 / (2 * k);
  const sign = (a - r) < 0 ? -1 : 1;
  const c = n.map((v) => v * (a - r));
  const c2 = c.map((v, i) => v + t[i]);
  const mag = Math.hypot(c2[0], c2[1], c2[2]);
  const n2 = mag > 1e-9 ? c2.map((v) => sign * v / mag) : n;
  return { surface_normal: n2, p0_dist: sign * mag + r, curvature: k };
}

// Rigid translation of a whole subtree: every node's own primitive moves,
// recursively, since each one's (n, a, k) is in the same global frame (see
// translatePrim). This is what "translate" (see tree()) rides on to place
// an object authored once under "objects" wherever it's needed, instead
// of copying and hand-editing every number in it per instance. A
// translated copy is genuinely different geometry from the original, so
// unlike a plain "use" it can't share nodes with it once flattened.
function translateTree(t, offset) {
  if (isLeaf(t)) return t;
  return node(translatePrim(t.prim, offset),
              translateTree(t.inside, offset),
              translateTree(t.outside, offset),
              t.paint, t.env);
}

// Resolves paint inheritance once, here, instead of once per ray in
// antisphere-raycast.wgsl's trace(). Walks the authored tree with the same
// two rules trace() currently applies at runtime:
//
//   - Descending into a node's *inside* threads its own paint forward as
//     the scope for whatever's below it, unless that paint is INHERIT (in
//     which case the incoming scope keeps threading through unchanged).
//   - A leaf directly under a node - on *either* side, inside or outside -
//     resolves against that node's own paint first (BARE or a material
//     wins outright; INHERIT falls back to the threaded scope), matching
//     the "entry" override trace() applies regardless of which side. This
//     is the mechanism BARE actually depends on: ordinary scope-threading
//     alone only ever updates on the inside, so BARE's carving effect on a
//     node's outside leaf (e.g. scene.json's "bitten" object) would be
//     lost without it.
//
// Memoized by (subtree, scope) so a named object reused under the same
// scope still collapses to one baked subtree - only reuse under genuinely
// different scopes duplicates it, which is required for correctness: the
// same subtree can resolve to different materials in different contexts.
function resolveInheritance(tree, rootScope) {
  const memo = new Map();   // scope -> (subtree -> baked), keyed outer-first

  // A leaf's baked material: `entryPaint` is already fully resolved by the
  // time it gets here (it's either a node's own paint, or - when that
  // paint is INHERIT - whatever scope was already threaded in, per `here`
  // below), so it alone decides: a real material wins outright, otherwise
  // the leaf keeps its own substrate. Vacuum is never painted either way.
  const bakeLeaf = (leaf, entryPaint) => (leaf === 0 ? leaf : (entryPaint > 0 ? entryPaint : leaf));

  const resolve = (t, scope) => {
    if (t === EMPTY) return EMPTY;
    let byScope = memo.get(scope);
    if (!byScope) { byScope = new Map(); memo.set(scope, byScope); }
    if (byScope.has(t)) return byScope.get(t);
    let out;
    if (t.leaf !== undefined) {
      out = solid(bakeLeaf(t.leaf, INHERIT));   // a bare leaf has no owning node: pure inherit
    } else {
      const here = t.paint !== INHERIT ? t.paint : scope;
      const child = (c, childScope) =>
        (c !== EMPTY && c.leaf !== undefined) ? solid(bakeLeaf(c.leaf, here)) : resolve(c, childScope);
      out = node(t.prim, child(t.inside, here), child(t.outside, scope), INHERIT, t.env);
    }
    byScope.set(t, out);
    return out;
  };
  return resolve(tree, rootScope);
}

// Leaves are encoded in the child index: child < 0 means a leaf whose
// substrate is (-1 - child), so EMPTY is -1 and vacuum is material 0.
function flatten(tree) {
  const out = [], memo = new Map();
  const walk = (t) => {
    if (t === EMPTY) return -1;
    if (t.leaf !== undefined) return -1 - t.leaf;
    if (memo.has(t)) return memo.get(t);
    const idx = out.length;
    out.push(null);
    memo.set(t, idx);
    out[idx] = { prim: t.prim, paint: t.paint, env: t.env ?? 0,
                 inside: walk(t.inside), outside: walk(t.outside) };
    return idx;
  };
  walk(tree);
  return out;
}

// ---------------------------------------------------------------------------
// Bounds
//
// The bounding sphere of a subtree's solid region, used by "group" to check
// the author's disjointness claim and to build the early-out tests. A node's
// own five numbers already describe a ball whenever that side of it is
// bounded: the inside for k > 0, the outside for k < 0. A half-space bounds
// neither side.
//
// Returns NO_SOLID, UNBOUNDED, or { c, r }.
// ---------------------------------------------------------------------------

const NO_SOLID = null;
const UNBOUNDED = 'unbounded';

const dist3 = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);

function regionBall(prim, insideSide) {
  if (prim.curvature === 0) return null;
  if (insideSide !== (prim.curvature > 0)) return null;
  const r = 0.5 / prim.curvature;
  return { c: prim.surface_normal.map((v) => v * (prim.p0_dist - r)), r: Math.abs(r) };
}

// Bounding sphere of the intersection of two balls. Exact for containment,
// and for the lens case takes the ball around the lens's axial extent and
// widest cross-section.
function ballMeet(A, B) {
  const d = dist3(A.c, B.c);
  if (d >= A.r + B.r) return NO_SOLID;
  if (d + A.r <= B.r) return A;
  if (d + B.r <= A.r) return B;
  const x = (d*d - B.r*B.r + A.r*A.r) / (2*d);       // A.c to the radical plane
  const rho2 = Math.max(0, A.r*A.r - x*x);           // widest cross-section
  const lo = Math.max(-A.r, d - B.r), hi = Math.min(A.r, d + B.r);
  const xm = 0.5 * (lo + hi);
  const u = A.c.map((v, i) => (B.c[i] - v) / d);
  return {
    c: A.c.map((v, i) => v + u[i] * xm),
    r: Math.max(0.5 * (hi - lo), Math.sqrt(rho2 + (x - xm) ** 2)),
  };
}

function ballJoin(A, B) {
  const d = dist3(A.c, B.c);
  if (d + A.r <= B.r) return B;
  if (d + B.r <= A.r) return A;
  const R = 0.5 * (d + A.r + B.r);
  const t = (R - A.r) / d;
  return { c: A.c.map((v, i) => v + (B.c[i] - v) * t), r: R };
}

function boundOf(t, declared, memo) {
  if (declared.has(t)) return declared.get(t);
  if (memo.has(t)) return memo.get(t);
  let out;
  if (t === EMPTY) {
    out = NO_SOLID;
  } else if (t.leaf !== undefined) {
    out = t.leaf === 0 ? NO_SOLID : UNBOUNDED;      // a solid leaf is unbounded
  } else {
    memo.set(t, UNBOUNDED);                          // conservative cycle guard
    const clip = (b, ball) => {
      if (b === NO_SOLID) return NO_SOLID;
      if (!ball) return b;
      return b === UNBOUNDED ? ball : ballMeet(b, ball);
    };
    const bi = clip(boundOf(t.inside,  declared, memo), regionBall(t.prim, true));
    const bo = clip(boundOf(t.outside, declared, memo), regionBall(t.prim, false));
    if (bi === UNBOUNDED || bo === UNBOUNDED) out = UNBOUNDED;
    else if (bi === NO_SOLID) out = bo;
    else if (bo === NO_SOLID) out = bi;
    else out = ballJoin(bi, bo);
  }
  memo.set(t, out);
  return out;
}

// ---------------------------------------------------------------------------
// Scene compiler
//
// Turns scene.json into flat node, material, and light tables. Named entries
// under "objects" are built once and shared by reference, so a subtree used
// in several places collapses to one set of nodes when flattened - unless
// it's placed with "translate", which moves it (see translateTree) and so
// can no longer share nodes with the original or with other instances.
// ---------------------------------------------------------------------------

export function compileScene(spec) {
  const at = (path, msg) => { throw new Error(`scene.json ${path}: ${msg}`); };

  // Material 0 is vacuum and is never shaded.
  const table = [{ albedo: [0, 0, 0], albedo2: [0, 0, 0],
                   pattern: 0, scale: 1, kind: 0, params: [0, 0] }];
  const matIndex = new Map();
  for (const [name, def] of Object.entries(spec.materials || {})) {
    if (PAINT_WORDS[name] !== undefined) at(`materials.${name}`, 'name is reserved');
    const pattern = PATTERNS[def.pattern ?? 'flat'];
    if (pattern === undefined) at(`materials.${name}`, `unknown pattern "${def.pattern}"`);
    const kind = KINDS[def.kind ?? 'lambert'];
    if (!kind) {
      at(`materials.${name}`, `unknown kind "${def.kind}". Known kinds: ` +
                              Object.keys(KINDS).join(', '));
    }
    table.push({
      albedo:  def.albedo  ?? [0.7, 0.7, 0.7],
      albedo2: def.albedo2 ?? [0.3, 0.3, 0.3],
      scale:   def.scale   ?? 1,
      kind:    kind.id,
      params:  kind.params(def),
      pattern,
    });
    matIndex.set(name, table.length - 1);
  }

  const lightList = (spec.lights || []).map((lt, i) => {
    if (!lt.pos || !lt.color) at(`lights[${i}]`, 'needs pos and color');
    return { pos: lt.pos, color: lt.color };
  });

  function substrate(name, path) {
    const m = matIndex.get(name);
    if (m === undefined) at(path, `unknown material "${name}"`);
    return m;
  }

  // Returns { paint, env }. An ambient material moves into the environment
  // slot and leaves the node a pure partition.
  function paintOf(def, path) {
    if (def.paint === undefined) return { paint: INHERIT, env: 0 };
    if (PAINT_WORDS[def.paint] !== undefined) {
      return { paint: PAINT_WORDS[def.paint], env: 0 };
    }
    const m = substrate(def.paint, `${path}.paint`);
    if (table[m].kind === KIND_AMBIENT) return { paint: PARTITION, env: m };
    return { paint: m, env: 0 };
  }

  function primOf(def, path) {
    let p;
    if (def.sphere) {
      const { center, radius } = def.sphere;
      if (!center || !(radius > 0)) at(`${path}.sphere`, 'needs center and positive radius');
      p = sphere(center, radius);
    } else if (def.plane) {
      const { normal, offset } = def.plane;
      if (!normal) at(`${path}.plane`, 'needs normal');
      p = plane(normal, offset ?? 0);
    } else {
      at(path, 'needs a sphere or plane');
    }
    return def.complement ? complement(p) : p;
  }

  // Named objects are memoized so repeated use shares one subtree.
  const built = new Map();
  const declared = new Map();     // subtree -> author-declared bounding ball
  const boundMemo = new Map();

  function named(name, path) {
    if (built.has(name)) return built.get(name);
    const def = (spec.objects || {})[name];
    if (!def) at(path, `unknown object "${name}"`);
    built.set(name, null);                       // cycle guard
    const t = tree(def, `objects.${name}`);
    built.set(name, t);
    return t;
  }

  function operand(d, path) {
    if (d === EMPTY) return EMPTY;
    return typeof d === 'string' ? named(d, path) : tree(d, path);
  }

  // Split candidates: planes along the axes and the four body diagonals, plus
  // spheres about the centroid. Each is tried at every gap between members
  // sorted along that projection.
  const SPLIT_DIRS = [[1,0,0], [0,1,0], [0,0,1], [1,1,1], [1,1,-1], [1,-1,1], [-1,1,1]]
    .map((d) => { const L = Math.hypot(...d); return d.map((v) => v / L); });

  // A split that separates every member without cutting any of them. Prefers
  // the most even one. `pref` is the running max of x+r from the low side,
  // `suf` the running min of x-r from the high side; a gap is clean when they
  // do not cross.
  function cleanSplit(items, project, makePrim) {
    const n = items.length;
    const arr = items.map((it, i) => ({ i, x: project(it.ball), r: it.ball.r }))
                     .sort((a, b) => a.x - b.x);
    const pref = new Array(n), suf = new Array(n);
    let m = -Infinity;
    for (let k = 0; k < n; k++) { m = Math.max(m, arr[k].x + arr[k].r); pref[k] = m; }
    m = Infinity;
    for (let k = n - 1; k >= 0; k--) { m = Math.min(m, arr[k].x - arr[k].r); suf[k] = m; }

    let cut = null;
    for (let k = 1; k < n; k++) {
      if (pref[k - 1] > suf[k]) continue;            // this gap would cut a member
      const bal = Math.abs(k - n / 2);
      if (!cut || bal < cut.bal) cut = { bal, k, t: 0.5 * (pref[k - 1] + suf[k]) };
    }
    if (!cut) return null;
    const prim = makePrim(cut.t);
    if (!prim) return null;
    return { prim, bal: cut.bal,
             inside:  arr.slice(0, cut.k).map((a) => items[a.i]),
             outside: arr.slice(cut.k).map((a) => items[a.i]) };
  }

  // Fallback when nothing separates cleanly: split at the median and put any
  // member the surface crosses into *both* children. Subtree sharing makes
  // that one extra reference rather than a copy. Requires strict progress on
  // both sides so the recursion terminates.
  function looseSplit(items, project, makePrim) {
    const xs = items.map((it) => project(it.ball)).sort((a, b) => a - b);
    const t = xs[Math.floor(xs.length / 2)];
    const prim = makePrim(t);
    if (!prim) return null;
    const inside = [], outside = [];
    for (const it of items) {
      const x = project(it.ball), r = it.ball.r;
      if (x + r <= t) inside.push(it);
      else if (x - r >= t) outside.push(it);
      else { inside.push(it); outside.push(it); }
    }
    if (inside.length >= items.length || outside.length >= items.length) return null;
    return { prim, inside, outside, cost: Math.max(inside.length, outside.length) };
  }

  function chooseSplit(items) {
    const mid = [0, 1, 2].map((ax) =>
      items.reduce((s, it) => s + it.ball.c[ax], 0) / items.length);

    const tries = SPLIT_DIRS.map((d) => [
      (b) => b.c[0] * d[0] + b.c[1] * d[1] + b.c[2] * d[2],
      (t) => plane(d, t),
    ]);
    tries.push([(b) => dist3(b.c, mid), (t) => (t > 1e-6 ? sphere(mid, t) : null)]);

    let best = null;
    for (const [proj, mk] of tries) {
      const s = cleanSplit(items, proj, mk);
      if (s && (!best || s.bal < best.bal)) best = s;
    }
    if (best) return best;
    for (const [proj, mk] of tries) {
      const s = looseSplit(items, proj, mk);
      if (s && (!best || s.cost < best.cost)) best = s;
    }
    return best;
  }

  // A subtree whose root already confines all of its solid to one ball needs
  // no separate bounding test: the root node is the test.
  const selfBounded = (t) =>
    t !== EMPTY && t.leaf === undefined && t.outside === EMPTY && t.prim.curvature > 0;

  // Memoized, so a member landing in two children stays one subtree.
  function wrap(it) {
    if (!it.wrapped) {
      it.wrapped = selfBounded(it.tree)
        ? it.tree
        : node(sphere(it.ball.c, it.ball.r), it.tree, EMPTY, PARTITION);
    }
    return it.wrapped;
  }

  function partition(items) {
    if (!items.length) return EMPTY;
    if (items.length === 1) return wrap(items[0]);
    const s = chooseSplit(items);
    if (!s) {                                      // no split makes progress
      let acc = EMPTY;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        acc = selfBounded(it.tree)
          ? node(it.tree.prim, it.tree.inside, acc, it.tree.paint, it.tree.env)
          : node(sphere(it.ball.c, it.ball.r), it.tree, acc, PARTITION);
      }
      return acc;
    }
    return node(s.prim, partition(s.inside), partition(s.outside), PARTITION);
  }

  // "group" is a union plus an assertion: the members' bounding spheres are
  // mutually exterior. That claim is what lets a partition surface separate
  // them, giving a hierarchy instead of a linear chain. Because one node type
  // serves as both splitting surface and bounding volume, the result is a BSP
  // tree and a bounding volume hierarchy at the same time.
  function buildGroup(def, path) {
    if (!Array.isArray(def.group)) {
      at(path, 'group takes an array of subtrees, or names of entries under "objects"');
    }
    if (def.inside !== undefined || def.outside !== undefined) {
      at(path, 'group is a whole subtree, so it takes no inside or outside');
    }

    const parts = [];
    def.group.forEach((d, i) => {
      const p = `${path}.group[${i}]`;
      const label = typeof d === 'string' ? `"${d}"` : p;
      const t = operand(d, p);
      if (t === null) at(p, `object ${label} refers to itself`);
      const b = boundOf(t, declared, boundMemo);
      if (b === NO_SOLID) return;                  // contributes nothing
      if (b === UNBOUNDED) {
        at(p, `${label} has no bounding sphere, so it cannot be a group member. ` +
              'Give it "bounds": { "center": [x, y, z], "radius": r }, or use union instead');
      }
      // Nudge outward so a surface lying exactly on its own bound is not
      // split by the test.
      parts.push({ label, tree: t, ball: { c: b.c, r: b.r * (1 + 1e-4) + 1e-6 } });
    });

    // A violated claim would silently drop geometry, so check it.
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const A = parts[i].ball, B = parts[j].ball;
        if (dist3(A.c, B.c) < A.r + B.r) {
          at(path, `${parts[i].label} and ${parts[j].label} are not mutually ` +
                   'exterior, so they cannot be grouped. Use union instead');
        }
      }
    }

    return partition(parts);
  }

  function tree(def, path) {
    if (def === 'empty') return EMPTY;
    if (typeof def === 'string') at(path, `expected a subtree, got "${def}"`);

    let out;
    if (def.solid !== undefined) {
      out = solid(substrate(def.solid, path));
    } else if (def.use !== undefined) {
      out = named(def.use, path);
      if (out === null) at(path, `object "${def.use}" refers to itself`);
    } else if (def.group !== undefined) {
      out = buildGroup(def, path);
    } else if (def.union !== undefined) {
      if (!Array.isArray(def.union)) {
        at(path, 'union takes an array of subtrees, each with its own inside ' +
                 'and outside, or names of entries under "objects"');
      }
      if (def.inside !== undefined || def.outside !== undefined) {
        at(path, 'union is a whole subtree, so it takes no inside or outside');
      }
      if (!def.union.length) at(path, 'union needs at least one operand');
      out = def.union
        .map((d, i) => operand(d, `${path}.union[${i}]`))
        .reduce((acc, p) => union(acc, p));
    } else {
      if (def.inside === undefined || def.outside === undefined) {
        at(path, 'node needs both inside and outside');
      }
      const { paint, env } = paintOf(def, path);
      out = node(primOf(def, path),
                 tree(def.inside,  `${path}.inside`),
                 tree(def.outside, `${path}.outside`),
                 paint, env);
    }

    // Positions a subtree in world space by translating every primitive in
    // it - see translateTree(). Works on any of the branches above, so an
    // object built once under "objects" can be dropped wherever it's
    // needed via { "use": "name", "translate": [x, y, z] }, instead of
    // being copied and hand-edited per instance.
    if (def.translate !== undefined) {
      if (!Array.isArray(def.translate) || def.translate.length !== 3) {
        at(`${path}.translate`, 'needs a [x, y, z] offset');
      }
      out = translateTree(out, def.translate);
    }

    if (def.bounds) {
      const { center, radius } = def.bounds;
      if (!center || !(radius > 0)) at(`${path}.bounds`, 'needs center and positive radius');
      declared.set(out, { c: center, r: radius });
    }
    return out;
  }

  if (!spec.root) at('root', 'missing');
  return {
    nodes: flatten(resolveInheritance(tree(spec.root, 'root'), INHERIT)),
    materials: table,
    lights: lightList,
    camera: spec.camera || null,
  };
}

// 48 bytes per material:
//   u32 kind | u32 pattern | vec2 params | vec3 albedo | f32 scale | vec3 albedo2 | pad
// Ordered so the two scalars and the vec2 fill the 16 bytes ahead of the first
// vec3, which has to start on a 16-byte boundary anyway.
export function packMaterials(list) {
  const buf = new ArrayBuffer(list.length * 48);
  const f = new Float32Array(buf), u = new Uint32Array(buf);
  list.forEach((m, j) => {
    const o = j * 12;
    u[o + 0] = m.kind;
    u[o + 1] = m.pattern;
    f[o + 2] = m.params[0];  f[o + 3]  = m.params[1];
    f[o + 4] = m.albedo[0];  f[o + 5]  = m.albedo[1];  f[o + 6]  = m.albedo[2];
    f[o + 7] = m.scale;
    f[o + 8] = m.albedo2[0]; f[o + 9]  = m.albedo2[1]; f[o + 10] = m.albedo2[2];
    f[o + 11] = 0;
  });
  return buf;
}

// 32 bytes per node: vec3 n | f32 a | f32 k | i32 inside | i32 outside |
//                    i32 (env << 16 | paint)
export function packNodes(list) {
  const buf = new ArrayBuffer(list.length * 32);
  const f = new Float32Array(buf), i = new Int32Array(buf);
  list.forEach((nd, j) => {
    const o = j * 8;
    f[o + 0] = nd.prim.surface_normal[0];
    f[o + 1] = nd.prim.surface_normal[1];
    f[o + 2] = nd.prim.surface_normal[2];
    f[o + 3] = nd.prim.p0_dist;
    f[o + 4] = nd.prim.curvature;
    i[o + 5] = nd.inside;
    i[o + 6] = nd.outside;
    // Low half surface paint, high half environment index. Keeps a node at
    // 32 bytes, which matters more than the two shifts it costs the shader.
    i[o + 7] = ((nd.env & 0xFFFF) << 16) | (nd.paint & 0xFFFF);
  });
  return buf;
}

// ---------------------------------------------------------------------------
// Lights
//
// Each light is a world position and an RGB color whose magnitude is its
// radiant power. Falloff is inverse square, so these run well above 1.
// The buffer must hold at least one entry.
// ---------------------------------------------------------------------------

// 32 bytes per light: vec3 pos | pad | vec3 color | pad
export function packLights(list) {
  const buf = new ArrayBuffer(list.length * 32);
  const f = new Float32Array(buf);
  list.forEach((lt, j) => {
    const o = j * 8;
    f[o + 0] = lt.pos[0];
    f[o + 1] = lt.pos[1];
    f[o + 2] = lt.pos[2];
    f[o + 4] = lt.color[0];
    f[o + 5] = lt.color[1];
    f[o + 6] = lt.color[2];
  });
  return buf;
}
