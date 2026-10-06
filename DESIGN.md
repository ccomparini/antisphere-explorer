# Design: nodes divide space, materials fill it

"Antisphere" is historical: nodes are now general quadrics of revolution
(see `hyperconic.md`), and the name may change. This is the model the rest
of the code is built on, and the direction it is going.

## The model

- **One kind of node.** Every node is a quadric that splits space in two:
  its inside, where H(R) < 0, and its outside. Complement negates every
  coefficient but the axis.
- **Nodes divide space; materials say what is in it.** Solidity, and later
  opacity and the like, are properties of a material, never of a node.
- **Inside:** a node's material fills its inside, unless nodes within that
  inside say something more specific. An absent inside child means "this
  node's own material".
- **Outside:** a node always defers its outside to another node, its
  outside child. An absent outside child means **empty**, not "whatever
  encloses this node". This is deliberate, because it is what allows
  cutaways. Everything that reads a tree follows this rule:
  - `trace()` in `shaders/antisphere-raycast.wgsls`;
  - the CSG operators in `public/antisphere-scene.js`, and their tests in
    `public/antisphere-csg.test.mjs`;
  - `interiorPaths()` in `public/overlap.js`, which decides which regions
    count as solid for overlap tests.

### Why inside is H < 0, not H ≤ 0

The surface itself (H = 0) is deliberately not inside. This is settled; the
reasons:

- **Rays lying in a surface** (a camera exactly level with a floor plane, a
  ray along a cylinder's straight lines) have H = 0 their whole length. With
  ≤ they would count as inside all the way and give spurious hits.
  `trace()` relies on "a ray lying in a surface never enters it".
- **Complement stays symmetric.** Negating H makes the complement's inside
  H > 0, so the surface belongs to neither side rather than to both.
- **Touching is not overlapping.** Insides are open sets, so two solids
  resting against each other share no inside, and the overlap test says
  apart. Resting contact in physics and exact placement in an editor both
  depend on this.

A solid still includes its surface in the usual solid-modelling sense
(regularized sets: the closure of the interior): the surface is where it is
seen and touched, but it has no volume, so it never decides an overlap.
Anything that classifies a point must use the same strict test.

### Spelling a solid's faces

The nodes are an alphabet: what matters is that the scenes wanted can be
spelled, not that every combination of nodes means something. One rule of
spelling, so that `trace()` reports the face a ray actually struck:

- **Every face of a solid is the surface of a node carrying the solid's
  material, entered on its inside.** A ray crossing that surface starts the
  hit at that node, at its own root.
- **The empty space in front of each face is an outside (or a non-solid
  inside) of the solid's own nodes.** Entering it clears anything found too
  early higher up, so the hit restarts at the face. A pure division
  (`material: null`) therefore stands in empty space, never on a face:
  crossing it hands the region beyond a starting point its own nodes did not
  make, and the hit is reported against whichever solid node comes first
  below - the right distance, the wrong surface (normal, shadow start,
  physlab's beam).

So a hole in a solid is a node complemented, carrying the solid's material
(its inside the solid, its outside the hole); a top is a node of its own;
and a bounding volume or a partition stands clear of what it holds, as the
spheroid round an imported mesh does. `public/maze.js` spells its walls this
way. A ray that starts inside a solid crosses no face, and names none.

## Why quadrics: bounding volume hierarchies without a separate structure

This is the core motivation. Every division is a quadric, so a bounding
volume, a space partition and a visible surface are all the same kind of
node, and one traversal handles all three. There is no separate
acceleration structure to build, keep in step, or traverse.

- A division may have nothing of its own on either side: a pure split
  between the members of a group.
- A member that straddles a split goes on both sides. The compiler does
  this in `group` (`chooseDivider()` and `buildGroup()` in
  `public/antisphere-scene.js`), sharing the member's subtree, and it has
  to be handled carefully.
- A member's own surfaces are divisions too: `group` grafts each member
  only into the absent outsides of the members before it that it may
  reach, so a ball beyond one face of an octahedron hangs off that face
  alone. These trees are about divisions, not solidity: a region is
  claimed by an absent inside whatever its material, and a node filled with
  `null` divides space exactly as one filled with stone.

## Moving objects

A rigid motion changes only a node's coefficients (its quadric), not the
tree's structure. So moving an object can mean rewriting its nodes'
coefficients in place, with no recompile.

- The structure stays valid as long as the separations it assumes still
  hold, such as a group's splits between its members.
- The GPU overlap test (`shaders/overlap.wgsls`, `public/overlap.js`) is
  how that gets checked. A rebuild is needed only when a separation fails,
  meaning there is an overlap.
- The same overlap tests are what physics uses to detect collisions, so
  one check serves both.

## Planned (agreed, not yet built)

- **Material properties as bitfields** (solid, opaque, ...), with `trace()`
  given a mask of which bits stop the ray. A camera ray and a physics query
  can then treat glass differently, for example.
- **Rays that continue from a hit.** A shadow ray already starts exactly on
  the surface the camera ray hit (`trace()`'s `fromSurface` in
  `shaders/antisphere-raycast.wgsls`): every node that is that surface -
  its copies and complements, one id in `surfaces` - takes H = 0 at the
  start, so the crossing where the ray is never counts, the next one does
  (a crater's wall still shades its floor), and which side the ray is on
  goes by its direction: no offset, no tolerance. Reflection, refraction
  and transparency are the same thing, a new ray from the hit, turned back
  (staying on its side) or going on through (inside); straight-through
  transparency can instead resume the same trace past the hit, from the
  segments on its stack. Several continuations from one hit are a bounded
  per-pixel queue of weighted rays, run in a loop as trace()'s own stack
  is. The stop mask above says which materials end each.
- **Lights scoped by env.** An env node is a scope, and its lights belong
  to it: a hit is lit only by the lights of its env and those enclosing it,
  each shadow ray traced from that env node rather than the root (a node's
  inside subtree is all of its inside region, so this is exact for a ray
  that stays inside). A shadow ray that leaves its scope is blocked - that
  is the scoping: torches light their own room. A maze with many torches
  then tests each hit against its room's few. A node's `env` is already the
  index of the node starting its env (an ambient material's region), and
  an env node's own `env` the one enclosing it: the scope's geometry, and
  the chain outward that a hit's lights would be matched against. An outer
  env's light - the sky's sun - can then reach into a room through a
  window, as a torch inside cannot reach out.
- **Portals.** A "material" on a surface - a doorway's cut - that passes rays
  into another region, not necessarily connected: light through a doorway,
  or a magic portal. A continued ray again, into the other region's subtree.
- **Provenance for compiler-invented nodes.** Today they have none, which
  was enough for picking, since a hit never lands on one. A bounding
  wrapper needs to record the member it bounds, so it moves with that
  member. A split surface needs to record its group and the members it
  separates, so it stays put and is re-validated when they move.
- **physlab** (`public/physlab/`): world objects, whose geometry becomes
  the scene, and a camera riding on one of them. It is the testbed for
  moving objects and the overlap queries.
