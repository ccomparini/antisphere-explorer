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

import { spheroidSide, spheroidPrim, startsEnv } from './antisphere-scene.js';

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
 */
export function graftMover(built, mover, { reach, budget = 8, wrap = true } = {}) {
  const nodes = built.nodes.slice();
  const count = mover.prims.length;
  const copies = [];
  const reachPrim = spheroidPrim(reach);

  // A copy of the chain, its last outside handing on to `end`, wrapped in
  // the reach: the index to put where `end` was. Its nodes start no env,
  // so record none (env 0).
  function chain(end) {
    const env = 0;
    const wrapper = wrap ? nodes.length : -1;
    if (wrap) nodes.push({ prim: reachPrim, material: 0, env, inside: 0, outside: end, prov: null, lights: null });
    const first = nodes.length;
    for (let k = 0; k < count; k++) {
      nodes.push({
        prim: mover.prims[k], material: mover.materials[k], env, inside: 0,
        outside: k + 1 < count ? first + k + 1 : end,
        prov: mover.prov?.[k] ?? null, lights: null,
      });
    }
    copies.push(first);
    if (!wrap) return first;
    nodes[wrapper].inside = first;
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

  // Node i with the mover in it: the index to put where i was.
  const placed = new Map();
  function place(i) {
    if (placed.has(i)) return placed.get(i);
    if (i !== 1 && slotsOf(i) > budget) {
      const first = chain(i);                         // in front of it, once
      placed.set(i, first);
      return first;
    }
    placed.set(i, i);
    const n = { ...nodes[i] };
    nodes[i] = n;
    const s = sideOf(i);
    if (s !== 'outside') n.inside = n.inside ? place(n.inside) : chain(filler(i));
    if (s !== 'inside') n.outside = n.outside ? place(n.outside) : chain(0);
    return i;
  }
  place(1);

  return {
    built: { ...built, nodes, provenance: nodes.map((n) => n?.prov ?? null) },
    copies,
    nodes: mover.prims.map((_, k) => copies.map((first) => first + k)),
  };
}
