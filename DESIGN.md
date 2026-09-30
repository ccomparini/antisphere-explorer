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

## Why quadrics: bounding volume hierarchies without a separate structure

This is the core motivation. Every division is a quadric, so a bounding
volume, a space partition and a visible surface are all the same kind of
node, and one traversal handles all three. There is no separate
acceleration structure to build, keep in step, or traverse.

- A division may have nothing of its own on either side: a pure split
  between the members of a group.
- A member that straddles a split goes on both sides. The compiler already
  does this (`looseSplit()`, with the member's subtree shared through the
  memoized `wrap()`, in `public/antisphere-scene.js`), and it has to be
  handled carefully.

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
- **Provenance for compiler-invented nodes.** Today they have none, which
  was enough for picking, since a hit never lands on one. A bounding
  wrapper needs to record the member it bounds, so it moves with that
  member. A split surface needs to record its group and the members it
  separates, so it stays put and is re-validated when they move.
- **physlab** (`public/physlab/`): world objects, whose geometry becomes
  the scene, and a camera riding on one of them. It is the testbed for
  moving objects and the overlap queries.
