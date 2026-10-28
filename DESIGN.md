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
coefficients in place, with no recompile (`ASScene.setNodePrims()`: one
write of the changed nodes, no new bind group). What is at stake is the
tree's shape: each decision the compiler made from where things were is a
bet that they stay there.

- **The compiler's bets on position:** a group's dividers, placed between
  its members (`chooseDivider()`); which earlier members' outsides a later
  member is grafted into, as far as it may reach (`knock()` in
  `buildGroup()`), and the members it leaves out as hidden; copies pruned
  to an env's region (`pruneTo()`); a `"wrap"` sized to what it wraps.
  Move what they were made for and the tree is wrong. A figure compiled
  as a group shows it: compiled afresh in 32 poses of four clips, the
  mannequin's tree took 26 different shapes, 184 to 497 nodes.
- **A shape that makes no bets: a chain.** A figure's parts - spheres and
  spheroids, each self-contained - each in the outside of the one before.
  What fills a point is the first shape holding it, or nothing: the
  group's union, in any pose. Where shapes overlap, the earlier wins, and
  the order is fixed. So posing it is only its quadrics, each part's rest
  quadrics moved by its bone (`movePrim()`). The mannequin: 41 spheroids,
  41 nodes in every pose, against the group's hundreds, filling every
  sampled point as the group does and rendering pixel-identically. Its
  rays are shallower too - a ray finds a self-contained shape's inside at
  once, so pending segments don't pile up along the chain: peak stack
  depth 8-9 against the group's 10-11 (`TRACE_STACK_SIZE` is 32).
- **Movers, grafted into the static scene** (`public/movers.js`,
  `graftMover()`). The scene that doesn't move is compiled once, and a
  mover - a chain - is put into it wherever its reach may take it: a
  spheroid it never leaves (`boundingSpheroidOfPoints()` round its shapes
  in every pose of its clips). From the root, at each node, the reach is
  tested against the node's surface (`spheroidSide()`, by certificate):
  on one side only, the mover goes down that side; across it, down both.
  Where a side has no child, a copy of the chain goes in. In an absent
  outside it ends in nothing, as the outside did; in an absent inside it
  ends in a filler - the node again, childless, of its material - since an
  absent inside meant that node's own material. A chain in front of any
  subtree means "the mover, and where it isn't, what was there", so every
  copy is right in any pose within the reach. A swimmer straddling the
  floor: one copy above it, ending in nothing, and one below, ending in
  the floor. No dividers are added and nothing is left out. Moving the
  mover writes every copy's quadrics (they share a surface id, as copies
  do, and moving them alike keeps it so).
- **Each copy is wrapped in the reach:** a node of no material, its inside
  the copy, its outside straight on to what the copy ends in. A ray that
  never comes near the mover tests the one wrapper: the mannequin's copy
  below an opaque floor cost a third of the frame unwrapped (every ray into
  the floor tested 41 spheroids), and wrapped almost nothing (17 ms
  against 23, and against 65 over water).
- **A budget:** a subtree that would take more than 8 copies gets one copy
  in front of it instead - fewer nodes to write, less culling, and lit as
  the region holding that whole subtree is.
- **Lit where it is:** a hit's env is found by where the hit is
  (`envAt()`), not read from its node, so a copy needs no env of its own,
  and one in a lit room is lit by the room.
- **Why copies, not one shared chain linked into each slot:** a node has
  one outside, so a chain ends in one thing; above a floor it must end in
  nothing, below it in floor. An absent outside means empty, never
  "whatever enclosed this" - that rule is what gives cutaways - so one
  copy per distinct continuation. One link resuming what it replaced
  would be call-and-return in `trace()` (see Planned, "Movers: what is
  left").
- **The cost, measured** (the anim viewer, 800x600, on Intel): a pose by
  coefficients 0.3 ms of CPU, against 28-45 ms recompiling the group; the
  chain renders faster than the group in the same pose (60 ms against 65,
  at 1920x1080, the figure filling the frame).
- **The GPU overlap test** (`shaders/overlap.wgsls`, `public/overlap.js`)
  says when two things meet: physics' collisions, and movers meeting each
  other or the scene - which a game, not the tree, decides what to do
  about. A mover in solid geometry is simply shown there; in water, that
  is right.

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
  then tests each hit against its room's few. Built so far: a hit's env
  is found by where it is - walking down from the root as the hit lies, the
  last node starting an env (an ambient material's region, or a node
  carrying `"lights"`) that holds it (`envAt()`) - not read from its node,
  so a subtree is the same in every env and compiled once, and one linked
  into several envs is lit by the one each hit is in. An env node's own
  `env` is the one enclosing it, and every light belongs to an env - a
  node's to its own, the scene's to env 0 - so a hit is lit only by the
  lights on its chain outward. An
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
- **Movers: what is left** (Chris and Claude, from the animation work).
  - **Leaving the reach.** A mover kept within its reach is right; one
    that leaves it (a figure walking across a maze) is grafted again, a
    recompile of the static scene's slots it now reaches. The anim viewer's
    reach is every clip in place, so it never does. Regrafting, and
    choosing a reach for a moving figure (where it is, and how far it may
    go before the next), are to build.
  - **Several movers.** Each is grafted on its own; several in one scene
    is grafting each in turn, a later one into the earlier's copies too.
    How a scene says a thing moves - a key on a placed object, physlab's
    world objects - is open.
  - **A link instead of copies.** One shared chain linked into every slot,
    no copies, needs a chain that runs out to resume what it replaced.
    Two ways: a link node whose subtree resumes (call-and-return in
    `trace()`, a shader change), or a scope's fill - an absent outside
    meaning the enclosing env's fill rather than empty, the root's being
    empty, so existing scenes mean what they do, and a solid scope (a
    floor hosting a swimmer) opted into with a flag. Copies are cheap for
    a few movers; this pays for many, or large ones.
- **Models and animations** (Chris and Claude). Built: a model with a
  skeleton (`tools/import-model.mjs --skeleton`), its bones' rest pose and
  an object per bone in scene coordinates - fitted spheroids, spheroids
  along the bones, or the model's own mesh split among them; clips apart
  (`tools/import-animations.mjs`), keyframed (`public/keyframes.js`), by
  bone name; posing (`public/figure.js`); and the anim viewer
  (`public/anim-viewer/`), posing by coefficients. To come:
  - **Shape tracks:** deformation and morphing - a sphere swelling into a
    spheroid, a spheroid into a paraboloid - as a second kind of channel
    in the same clips, targeting a shape rather than a bone. A frame is
    then the shape's form at t, in its part's rest frame, moved by its
    bone at t, so a morphing hand still follows the arm. Bones stay the
    motion: a rigid motion interpolates as a rotation, which coefficients
    don't (halfway between two turned spheroids, averaged coefficients
    are another shape), a bone moves a part of any size with 7 numbers,
    and clips play on any model of the rig. Within a family, the
    authoring parameters (centre, axis, height, radius) interpolate
    cleanly; across families, coefficients do, normalized - a quadric
    times any constant is the same surface - perhaps by a point held on
    the surface and a unit gradient there. A part's reach then samples
    its shape tracks too.
  - **Retargeting:** clips hold full local rotations, right for models of
    the same rig. Rotations relative to the rest pose would let others
    play them, with the skeleton a clip was recorded on alongside it
    (`"recordedOn"`).
  - **Fitting quadrics** (Chris): geometry import choosing a quadric where
    a region of the mesh fits one within a tolerance - a forearm a
    spheroid, a finger left a mesh.
  - **Splitting by weight:** `splitByBone()` gives a triangle to its
    dominant bone (or, `--overlap`, to every bone weighing that much).
    Cutting where a blend is half one bone, half the next, and capping
    what is cut, are changes to it alone.
  - **Scene syntax** for a model playing a clip.
  - **Mesh parts are slow to compile** (`--skeleton mesh`): the mannequin's
    52 pieces compile as one group to 148,543 nodes in about 70 s (see
    "Group adds, made cheaper"). They can't chain, not being
    self-contained, so they pose by recompiling.
- **Group adds, made cheaper** (to revisit). Adding a member to a group,
  `knock()` in `buildGroup()` asks `overlap.js` to prove it clear of each
  region it passes (`regionsDisjoint()`: `separation()`,
  `smallestEigen()`), so as not to graft a copy there. For members that
  touch - a mesh's pieces, many planes each - most proofs fail after their
  full cost: about 85% of the mannequin's 70 s. One big tree (the 871,414
  triangle dragon) never asks for any. To try: the exact, cheap
  `ballClear()` for a plane before a certificate; grafting a mesh member
  without proofs (more copies, no certificates).
- **Provenance for compiler-invented nodes.** Today they have none, which
  was enough for picking, since a hit never lands on one. With movers
  grafted rather than grouped, the static scene's dividers and wrappers
  never move; a mover's wrapper (`graftMover()`) has none either, which
  is enough while the reach is fixed. One that moves with its mover would
  need to record what it bounds.
- **physlab** (`public/physlab/`): world objects, whose geometry becomes
  the scene, and a camera riding on one of them. It is the testbed for
  moving objects and the overlap queries.
