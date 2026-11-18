// Movers grafted into a compiled scene: something that moves - a figure's
// shapes, posed - added to a static tree that was compiled without it, in a
// way that stays right wherever it goes within its reach, so that moving it
// is only rewriting its nodes' quadrics (ASScene.setNodePrims()), never a
// recompile.
//
// A mover is a chain of self-contained shapes - spheres and spheroids -
// each in the outside of the one before: what fills a point is the first
// shape holding it, whatever moves where (stage.js says why). Put in front
// of any subtree - the chain's last outside handing on to that subtree - it
// means "the mover, and where it isn't, what was there": the mover in that
// region, overriding it, in any pose. That is all a graft is.
//
// Where to put it: the mover's reach is a spheroid it is never to leave
// (the figure in every pose of its clips, or wherever a game lets it go
// before it is grafted again) - boundingSpheroidOfPoints() round it, as a
// "wrap" is. From the root down, at each node, the reach is tested against
// the node's surface (spheroidSide()):
//
//   - on one side only, the mover goes down that side alone;
//   - on both, it goes down both - into a figure half in water, half out,
//     each half's region gets a copy.
//
// Down each side to where the side has no child of its own, and a copy of
// the chain goes there: in an absent outside, ending in nothing, as the
// absent outside did; in an absent inside, ending in a filler - the node
// again, childless, of its material - since an absent inside meant that
// node's own material. A floor straddled by a swimmer: one copy above it,
// ending in nothing, and one below, ending in the floor.
//
// Each copy is wrapped in the reach: a node of the reach's spheroid, of no
// material, its inside the copy and its outside going straight on to what
// the copy ends in. A ray that never comes near the mover - most of a
// floor's - tests that one node rather than every shape (in the viewer,
// a third of the frame). The wrapper is a pure division, as a group's
// bounding spheroid is, and stands clear of the mover, which never leaves
// its reach.
//
// No dividers are added and nothing is left out: the copies are wherever
// the reach may take the mover, not where it is now, so they are right in
// every pose. A subtree that would take more than `budget` copies gets one
// copy in front of it instead - fewer nodes, less culling, and lit as the
// region holding all of that subtree is.
//
// A hit on a copy is lit by the env it is in, found by where it is
// (envAt()), so a figure in a lit room is lit by the room, and the copies
// record no env. Copies of a shape share its quadric, so they are
// one surface (packSurfaces()), as copies of a node always are, and moving
// them alike keeps them so.

import { compileScene, fromSpheroid, isPNG, isSTL, isReference, loadReferences, referencedFiles, spheroidSide, spheroidPrim, startsEnv } from './antisphere-scene.js';

/**
 * The mover `mover` ({ prims, materials, prov? }: each shape's quadric, its
 * index in built.materials, and its provenance, in chain order) grafted into
 * `built` (compileScene()'s result), for a reach `reach` (a spheroid:
 * { center, axis, height, radius }); `wrap` false leaves the copies
 * unwrapped.
 * Returns { built, copies, nodes }: the scene with the mover in it (new
 * arrays; `built` itself is left alone), each copy's first node (a copy's
 * shapes are consecutive), and, per shape, every node that is a copy of it -
 * all to move together.
 *
 * A chain is an object whose nodes each have only an outside, the next
 * shape: graftObject() of that.
 */
export function graftMover(built, mover, options = {}) {
  const count = mover.prims.length;
  const object = {
    nodes: [null, ...mover.prims.map((prim, k) => ({
      prim, material: mover.materials[k], env: 0, inside: 0, outside: k + 1 < count ? k + 2 : 0,
      prov: mover.prov?.[k] ?? null, lights: null,
    }))],
  };
  const grafted = graftObject(built, object, options);
  return {
    built: grafted.built,
    copies: grafted.copies,
    nodes: mover.prims.map((_, k) => grafted.copies.map((first) => first + k)),
  };
}

/**
 * A compiled object grafted into `built`, as a mover is: `object` is
 * compileScene()'s result for the object alone, already where it goes - or
 * any { nodes, materials?, textures? } as compiled nodes are, node 1 its
 * root. Without `materials`, its nodes' material indices are already
 * built's; with them, they are its own table's, merged into built's: an
 * entry the same as one there (name and all) is that one, others are
 * added, and textures likewise, by file.
 *
 * A copy of it in front of `end` is its nodes copied, every absent outside
 * handed on to `end` - "the object, and where it isn't, what was there" -
 * absent insides as they are, its own material. A chain is the case where
 * each outside is the next shape. Its env nodes keep their env links, into
 * the copy; its outermost, 0, stay 0 - the scene's. The lights its nodes
 * carry come with each copy, under that copy's env node. (Lights scoped so
 * reach no further out than their env: revisit with env lights generally.)
 *
 * `prov(p)` gives a copied node's provenance from the object's own (by
 * default, the object's own).
 *
 * Returns { built, copies, size }: the scene with the object in it (new
 * arrays; `built` is left alone); where each copy starts - a copy is
 * `size` consecutive nodes, the object's nodes 1.. in order, so its node k
 * is copies[c] + k - 1; and its size.
 */
export function graftObject(built, object, { reach, budget = 8, wrap = true, prov = (p) => p } = {}) {
  const nodes = built.nodes.slice();
  const size = object.nodes.length - 1;
  const copies = [];
  const reachPrim = spheroidPrim(reach);

  // The object's materials and textures as built's: an index map.
  let materials = built.materials, textures = built.textures, materialOf = (i) => i;
  if (object.materials) {
    materials = built.materials.slice();
    textures = (built.textures ?? []).slice();
    const textureOf = (object.textures ?? []).map((t) => {
      const at = textures.findIndex((u) => u.file === t.file);
      if (at >= 0) return at + 1;
      textures.push(t);
      return textures.length;
    });
    const same = new Map(materials.map((m, i) => [JSON.stringify(m), i]).reverse());
    const map = object.materials.map((m, i) => {
      if (i === 0) return 0;                                   // vacuum is vacuum
      const entry = m.texture ? { ...m, texture: textureOf[m.texture - 1] } : m;
      const key = JSON.stringify(entry);
      if (same.has(key)) return same.get(key);
      materials.push(entry);
      same.set(key, materials.length - 1);
      return materials.length - 1;
    });
    materialOf = (i) => map[i] ?? i;
  }

  const lights = built.lights.slice();

  // A copy of the object, its absent outsides handing on to `end`, wrapped
  // in the reach: the index to put where `end` was.
  function copy(end) {
    const wrapper = wrap ? nodes.length : -1;
    if (wrap) nodes.push({ prim: reachPrim, material: 0, env: 0, inside: 0, outside: end, prov: null, lights: null });
    const base = nodes.length - 1;                             // object node k is base + k
    for (let k = 1; k <= size; k++) {
      const o = object.nodes[k];
      nodes.push({
        prim: o.prim, material: materialOf(o.material), env: o.env ? base + o.env : 0,
        inside: o.inside ? base + o.inside : 0,
        outside: o.outside ? base + o.outside : end,
        prov: o.prov ? prov(o.prov) : null, lights: o.lights ?? null,
      });
      for (const lt of o.lights ?? []) lights.push({ ...lt, env: base + k });
    }
    copies.push(base + 1);
    if (!wrap) return base + 1;
    nodes[wrapper].inside = base + 1;
    return wrapper;
  }
  // What an absent inside of node i meant, as a node: i again, childless.
  // If i starts an env, so does the filler, of the same material, and i's
  // env is the one round it.
  function filler(i) {
    const n = nodes[i];
    const env = startsEnv(n, built.materials) ? i : 0;
    nodes.push({ prim: n.prim, material: n.material, env, inside: 0, outside: 0, prov: n.prov, lights: null });
    return nodes.length - 1;
  }

  // Which sides of each node the reach is on, and how many copies its
  // subtree would take: worked out once per node, which may be shared.
  const sides = new Map();
  const sideOf = (i) => sides.get(i) ?? sides.set(i, spheroidSide(nodes[i].prim, reach)).get(i);
  const slots = new Map();
  function slotsOf(i) {
    if (slots.has(i)) return slots.get(i);
    slots.set(i, 0);
    const n = nodes[i], s = sideOf(i);
    let total = 0;
    if (s !== 'outside') total += n.inside ? slotsOf(n.inside) : 1;
    if (s !== 'inside') total += n.outside ? slotsOf(n.outside) : 1;
    slots.set(i, total);
    return total;
  }

  // Node i with the object in it: the index to put where i was.
  const placed = new Map();
  function place(i) {
    if (placed.has(i)) return placed.get(i);
    if (i !== 1 && slotsOf(i) > budget) {
      const first = copy(i);                          // in front of it, once
      placed.set(i, first);
      return first;
    }
    placed.set(i, i);
    const n = { ...nodes[i] };
    nodes[i] = n;
    const s = sideOf(i);
    if (s !== 'outside') n.inside = n.inside ? place(n.inside) : copy(filler(i));
    if (s !== 'inside') n.outside = n.outside ? place(n.outside) : copy(0);
    return i;
  }
  if (size > 0) place(1);

  return {
    built: { ...built, nodes, materials, textures, lights, provenance: nodes.map((n) => n?.prov ?? null) },
    copies,
    size,
  };
}

// The files a place needs that `files` hasn't: its object's, and what that
// references in turn, so far as what is there says.
function filesWanted(p, files) {
  const wanted = new Set(), seen = new Set();
  let todo = isReference(p.ref) ? [...referencedFiles({ use: p.ref }, p.from)] : [];
  while (todo.length) {
    const next = [];
    for (const path of todo) {
      if (seen.has(path)) continue;
      seen.add(path);
      if (!(path in files)) { wanted.add(path); continue; }
      if (!isPNG(path) && !isSTL(path)) next.push(...referencedFiles(files[path], path));
    }
    todo = next;
  }
  return wanted;
}

/**
 * The scene's "place"s (built.placements, compileScene()'s) grafted in: each
 * object compiled alone - as a "use" of it with the place's material and
 * transforms would be, `spec`'s materials and objects naming as they do
 * there - and wrapped in a spheroid round it, which bounds its copies and,
 * unless the place gives a "reach", is its reach too. `options` are
 * compileScene()'s (files, path, warn).
 *
 * A place's object is read when it is placed, not with the scene
 * (referencedFiles() passes it by): one whose files aren't in
 * options.files yet is left for now, and listed in `pending` -
 * placeAllLoading() reads them and places it.
 *
 * Returns { built, placed, pending }: the scene with every placed object in
 * it; per place { path, copies, size, rest } - where each copy starts, how
 * many nodes one is, and its nodes' quadrics as placed (rest[k] is node
 * k's, from 1) - for movePlacement(); and the places waiting on files. One
 * that can't be compiled or bounded is warned of and left out.
 */
export function placeAll(built, spec, options = {}) {
  const warn = options.warn ?? ((path, msg) => console.warn(`${path}: ${msg}`));
  const placed = [], pending = [];
  for (const p of built.placements ?? []) {
    if (filesWanted(p, options.files ?? {}).size) { pending.push(p); continue; }
    // As a use where the place is: its own material and transforms, then
    // each enclosing node's transforms, innermost first - each a union of
    // one, moved - within the material it inherits (compileScene()'s
    // inherit), filling what names none.
    let root = { use: p.ref };
    for (const key of ['material', 'paint', 'scale', 'rotate', 'translate']) if (p[key] !== undefined) root[key] = p[key];
    for (const moves of p.around ?? []) root = { union: [root], ...moves };
    root = { ...root, wrap: 'spheroid' };
    let object;
    try {
      object = compileScene({ ...spec, root, lights: [] }, {
        ...options, warn: (path, msg) => warn(`${p.path} (${path})`, msg), rootFrom: p.from,
        ...(p.inherited !== undefined ? { inherit: p.inherited } : {}),
      });
    } catch (e) {
      warn(p.path, `can't be placed: ${e.message}`);
      continue;
    }
    // Node 1 is the spheroid round it - the wrap - with nothing outside it.
    const top = object.nodes[1];
    const round = top && !top.outside
      ? fromSpheroid(top.prim.axis, top.prim.k_par, top.prim.k_perp, top.prim.linear, top.prim.constant) : null;
    if (!p.reach && !round?.inverseOk) {
      warn(p.path, "can't be bounded, so has no reach to be placed in: left out");
      continue;
    }
    const reach = p.reach ?? { center: round.centre, axis: round.axis, height: round.height, radius: round.radius };
    const grafted = graftObject(built, object, {
      reach, wrap: false,
      prov: (own) => ({ owner: p.prov.owner, path: p.prov.path, placed: own }),
    });
    built = grafted.built;
    placed.push({ path: p.path, copies: grafted.copies, size: grafted.size, rest: object.nodes.map((n) => n?.prim ?? null) });
  }
  return { built, placed, pending };
}

/**
 * placeAll(), reading first what its places need and options.files hasn't
 * (loadReferences(), with options.readText and readBytes): added to
 * options.files, which is kept. A file that can't be read is warned of, and
 * what needed it left out.
 */
export async function placeAllLoading(built, spec, options = {}) {
  const files = options.files ?? {};
  for (const p of built.placements ?? []) {
    if (!filesWanted(p, files).size) continue;
    Object.assign(files, await loadReferences({ use: p.ref }, {
      from: p.from, readText: options.readText, readBytes: options.readBytes, have: files,
      ...(options.warn ? { warn: (msg) => options.warn(p.path, msg) } : {}),
    }));
  }
  const out = placeAll(built, spec, { ...options, files });
  for (const p of out.pending) (options.warn ?? ((path, msg) => console.warn(`${path}: ${msg}`)))(p.path, 'not loaded, so left out');
  return { ...out, pending: [] };
}
