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
- Inside an env one of its members starts - a candle's lit sphere - a
  later member is grafted pruned to the env's region (`pruneTo()`): what
  goes there is a copy anyway, with the env's own env values, so it takes
  only the parts of the member that reach the region. A candle in a big
  maze costs about a hundred nodes, not a second maze. Lights can then be
  objects, placed first in a group: a light, an env round it, and whatever
  follows lit where it lies within it.

## Moving objects

A rigid motion changes only a node's coefficients (its quadric), not the
tree's structure. So moving an object can mean rewriting its nodes'
coefficients in place, with no recompile. What is at stake is the tree's
shape: each decision the compiler made from where things were when it
compiled is a bet that they stay there.

- **Where things are, as the compiler bets on it:**
  - a group's dividers, placed between its members' balls
    (`chooseDivider()`);
  - which earlier members' outsides a later member is grafted into, as far
    as it may reach (`knock()` in `buildGroup()`);
  - the copies pruned to a region, an env's (`pruneTo()`), from the
    member's actual geometry;
  - a `"wrap"`, sized to what it wraps.

  Each holds while something stays within some region, and a move that
  breaks one leaves the tree wrong: part of an object missing beyond a
  divider, or in a region it was never grafted into.
- **Within an object that moves**, the answer is a shape that makes no
  such bets, so moving or posing it only rewrites coefficients. A rigid
  object is one already: it moves as a whole, and its tree with it. A
  figure, whose parts move against each other, is not, compiled as a
  group: compiled afresh at each frame of its walk, the mannequin's tree
  came out different at 39 of the 40 steps (197 to 261 nodes) - its
  dividers and grafts chosen for each pose, and with 41 limbs swinging,
  surely crossed. Its parts as a chain - each part's outside the next -
  never changed (41 nodes), but a chain is a stack of
  pending segments for every part a ray crosses, and `trace()` has
  `TRACE_STACK_SIZE` (32) of them: that is why `buildGroup()` divides
  chains longer than `MAX_CHAIN` (4). So a figure wants a shallow shape
  that holds in every pose: spheres about its joints, each centred on a
  joint with the reach of everything below it as its radius, which holds
  its limb however the joint turns - pelvis, spine, shoulder, elbow,
  hand.
- **Between moving objects and the scene**, the scene that doesn't move
  is compiled once, and what moves is linked into it where it is (see
  Planned, "Movers linked into the static tree"): nodes near the root -
  a maze - are static, and things move from region to region within it.
- The GPU overlap test (`shaders/overlap.wgsls`, `public/overlap.js`)
  says when two things meet: physics' collisions, and movers meeting
  each other where they share a region.

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
  is. The stop mask above says which materials end each. Built so far,
  for camera rays: mirrors (`reflective`) and glass (`iorGlass`,
  `iorWater`) - main()'s loop round its one trace() call site,
  MAX_BOUNCES deep, which only traces and bends, shading the last hit
  after it. A ray in glass traces in trace()'s extend mode, whose t1 is
  where the material ends; the surface it leaves by is found by walking
  down to that point (surfaceAt()), since the last node it was inside need
  not be the face (a slab bounded by a sphere inside it). What follows the
  glass comes back from trace() too, so glass into water bends by the
  ratio of their indices (IOR_RATIO, by the two IOR codes) and goes on
  inside; each medium colours the ray by the distance through it.
- **Lights scoped by env.** An env node is a scope, and its lights belong
  to it: a hit is lit only by the lights of its env and those enclosing it,
  each shadow ray traced from that env node rather than the root (a node's
  inside subtree is all of its inside region, so this is exact for a ray
  that stays inside). A shadow ray that leaves its scope is blocked - that
  is the scoping: torches light their own room. A maze with many torches
  then tests each hit against its room's few. Built so far: a node's `env`
  is the index of the node starting its env (an ambient material's region,
  or a node carrying `"lights"`), an env node's own `env` the one enclosing
  it, and every light belongs to an env - a node's to its own, the scene's
  to env 0 - so a hit is lit only by the lights on its chain outward. An
  outer env's light - the sky's sun - reaches into a room through a
  window, as a torch inside cannot reach out. A light's shadow rays start
  inside its env - trace() takes a starting node, here the env node tagged
  as its inside - so a light sees only what its env holds, and is
  shadowed by that alone (a room's subtree, not the scene's). How a scope
  looks right is the scene author's to decide. A hit's lights are found
  by walking its env chain: the lights are stored in order of env, so each
  env's are a run, found by binary search - a hit pays for the lights on
  its chain, not the scene's. A glow region (a `"glowRegion"` material) is
  an env lit from within: its light is at its node's centre, fading to
  nothing at the node's surface by the node's own implicit function, worked
  out from the node at every hit, so moving or resizing the node changes
  it. Ambient light passes between envs by each one's `transmit`: an env's
  level is its own plus that fraction of the level around it, baked at
  compile time into a copy of the env node's material; only what varies
  from point to point - a glow region's `fill`, its glow unshadowed - is
  added per hit, in the same walk as the lights.
- **Cheap shadows** (Chris's idea), for very complex scenes or slow GPUs:
  shadows that are less accurate but keep the cues they give. A trace flag,
  `MATERIAL_CHEAP_SHADOW` (scene key `cheapShadow`), set on a node near an
  object's root - most naturally its `"wrap"` node, which is otherwise
  vacuum, so nothing looks different. Shadow rays get one more mask, as
  `stop_flags` is one: entering a region with that bit is a hit at once,
  without descending, so the object casts a shadow the shape of its
  wrapper (a blob for the tori, holes not included). The rule that makes
  it work: only a region the ray *enters* along its path counts, never one
  it starts in - a point on the object starts its shadow ray inside its
  own wrapper, so it still traverses the real geometry, and the object
  shadows itself exactly; only other things get the cheap blob. Camera
  rays pass 0. A third value of the camera's `shadows` (off, on, cheap)
  could switch it as a quality setting, so one scene serves both.
- **Only the materials a scene uses** (to revisit). Scenes start their
  materials with `"@lib/materials.json"`, and compileScene() packs every
  material it is given, so each scene carries the whole library's entries
  (about 80) in its table, most of them unused. No cost measured so far
  (scene.json and glass-hall render as fast as before), but packing only
  what some node names - or not reading what nothing needs - would keep the
  table to the scene. A library scoped to what its scenes need stays the
  author's responsibility either way.
- **Libraries in the scene format** (Chris's idea, not yet designed). A
  scene's `"library"`: a .json imported whole, what it holds going where
  it belongs - its `"materials"` into the scene's materials, and in time
  its objects (parts like `public/scenes/parts/bolt.json`) into the
  scene's objects - in place of a reference per section
  (`"materials": ["@lib/materials.json", ...]`). tools/maze.mjs's
  `--library` is named for it.
- **Play on past mistakes** (Chris: "more like a concert than surgery" -
  a player who stops at a wrong note spoils the concert, one who plays on
  may go unnoticed). An authoring slip should be warned of, with a
  fallback, not stop the scene. Done for the commonest: a material no one
  defines (a magenta stand-in, named), an object no one defines (left
  out), and a referenced file that can't be read (left out, with what
  refers to it). The rest of the compiler's hard errors - about 70: a
  malformed shape, a bad transform, an unknown kind or pattern - are to be
  gone through the same way, each given a fallback (the node left out, the
  transform ignored, the default taken), and their tests turned from
  "throws" to "warns and falls back". A tool's check (`--no-check`) keeps
  failing on any of them.
- **Portals.** A "material" on a surface - a doorway's cut - that passes rays
  into another region, not necessarily connected: light through a doorway,
  or a magic portal. A continued ray again, into the other region's subtree.
- **Movers linked into the static tree** (Chris and Claude, from the
  figure work). The scene that doesn't move is compiled once; each thing
  that moves - a figure walking, a ball thrown - is compiled on its own,
  a mover, and linked into the static tree where it is:
  - **Slots.** The static tree's empty places are its absent outsides,
    and the absent insides of regions that aren't solid (an env's air):
    0s in some static node's child. Each frame, a mover's ball is walked
    down the static tree - wholly inside a node, in; wholly outside, out;
    across it, both - to the slots it touches, and the mover's root is
    linked there; where it has left, unlinked. A mover across a static
    divider is linked on both sides of it, so the static tree never has
    to separate anything from a mover: it is never added to, and only
    those slots' pointers change. A slot within something solid is never
    linked into: the earlier claim stands, as in a group.
  - **The mover list.** The compiled scene keeps its movers, by name -
    the provenance owner, the object placed (`mannequin`): provenance
    maps a node to its object, the list an object to its nodes. Each
    entry holds the mover's block of nodes, contiguous, so that moving it
    is one buffer write; its copies (below); the slots linked to it (node
    and side), so a move relinks only what changed; and its bound - a
    ball in its own frame, a figure's root joint sphere - and its
    transform. A figure's block is subdivided by part (provenance path),
    so posing it rewrites each part's slice, while the figure links and
    moves as one. How a scene says a thing moves - a key on a placed
    object, physlab's world objects - is open.
  - **Envs.** Every node carries its env, baked; a mover in a torch-lit
    room needs the room's on all its nodes. So a mover has a copy for
    each env it touches - usually one, two in a doorway - each carrying
    that env, made or re-baked as it crosses.
  - **Several movers in one slot** would chain, into `MAX_CHAIN` and the
    stack; so an occupied slot gets a small tree of its own movers,
    rebuilt each frame - a few movers, cheap. The static tree above,
    small moving trees hung from its empty leaves.
  - **Pruning** (`pruneTo()`) is an economy, not needed for correctness:
    a mover linked whole into a slot is reached only by rays in that
    slot's region.
  - **In place.** Moving a mover rewrites every copy of its nodes (the
    `surfaces` ids already group copies); the node buffer keeps spare
    room for copies and links, compacted now and then by a rebuild.

  Measured, before any of it was built: a ball walked from the hub of
  `maze.json` to its exit through the doorways, 142 m in 5 cm steps,
  touched 1 or 2 slots at a time - a figure-sized one (r 0.95) and a
  thrown one (r 0.1) alike - and the set of them changed 37 times and 47
  times, at doorways and turns. In the same maze lit by torches (18 envs)
  the figure-sized ball touched 1 to 4 slots, in up to 4 envs, changing
  102 times. The cost to know: a mover large enough to be in many slots
  at once costs for each of them.
- **Models and animations** (Chris and Claude). Built so far: a model
  with a skeleton (`tools/import-model.mjs` on a skinned glTF): its bones'
  rest pose (`public/skin.js`), and an object per bone in the rest pose,
  in scene coordinates - the model's own mesh split among its bones
  (default), fitted spheroids, or spheroids along the bones. Clips apart
  (`tools/import-animations.mjs`), keyframed (`public/keyframes.js`), by
  bone name, every bone the source moves. `public/figure.js` poses a model
  by a clip as a scene subtree, each part turned and moved as its bone has
  from rest. To come:
  - **Fitting quadrics** (Chris): geometry import choosing a quadric
    where a region of the mesh fits one within a tolerance - a forearm a
    spheroid, a finger left a mesh - for static models as for parts.
  - **Splitting by weight:** `splitByBone()` gives a triangle to its
    dominant bone (or, `--overlap`, to every bone weighing that much).
    Cutting where a blend is half one bone, half the next, and capping
    what is cut (an open piece's solid runs on to its bounding
    spheroid), are changes to it alone.
  - **Retargeting:** clips hold full local rotations, right for models of
    the same rig. Rotations relative to the rest pose would let others
    play them; the skeleton a clip was recorded on would come with it
    then, as `"recordedOn"` (`"skeleton"` means a model's own).
  - **Scene syntax** for a model playing a clip.
  - **Cost.** Posed by recompiling, mesh parts are far too slow: the
    mannequin's 52 pieces, 19,687 nodes, compile as one group to 148,543
    nodes in about 70 s - neighbouring pieces' bounding spheroids overlap,
    so the group grafts each into many empty leaves of the others - and
    each turned piece costs over a second more. Its fitted spheroids
    compile in a fraction of a second. Movers (above), each piece linked
    where it reaches and moved in place, are the way out for mesh parts.
- **Provenance for compiler-invented nodes.** Today they have none, which
  was enough for picking, since a hit never lands on one. With movers
  linked rather than grouped (above), the static scene's dividers and
  wrappers never move; what still needs it is a mover's own: a wrapper
  recording what it bounds, so it moves with it.
- **physlab** (`public/physlab/`): world objects, whose geometry becomes
  the scene, and a camera riding on one of them. It is the testbed for
  moving objects and the overlap queries.
