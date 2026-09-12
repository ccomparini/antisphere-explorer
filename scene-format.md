# Scene JSON format

A scene file describes a camera, a material palette, a set of lights, and a
CSG tree of antisphere/plane primitives. `compileScene()` in
`public/antisphere-scene.js` turns it into the flat node/material/light
tables the WGSL raycaster (`public/antisphere-raycast.wgsl`) actually reads.
See `public/scene.json` for a large worked example, and `public/scene-simple.json`
/ `public/scene-just-tower.json` for smaller ones.

Top level:

```
{
  "camera":    { ... },       // optional
  "materials": { ... },       // optional, name -> material def
  "lights":    [ ... ],       // optional, but at least one is required at render time
  "objects":   { ... },       // optional, name -> reusable subtree template
  "root":      { ... }        // required, the scene's top-level subtree
}
```

## `camera`

| field      | type              | meaning                              |
|------------|-------------------|---------------------------------------|
| `target`   | `[x, y, z]`       | point the camera orbits/looks at      |
| `yaw`      | number (radians)  | horizontal orbit angle                |
| `pitch`    | number (radians)  | vertical orbit angle                  |
| `distance` | number            | distance from `target` to the camera  |

## `materials`

Each key is a material name; the value describes how surfaces using it look
and behave. Names `partition`, `inherit`, and `bare` are reserved (left over
from the deprecated `paint` field) and can't be used as material names.

| field      | type                                          | default          | meaning |
|------------|-----------------------------------------------|------------------|---------|
| `kind`     | `"lambert"` \| `"glossy"` \| `"emissive"` \| `"unlit"` \| `"ambient"` | `"lambert"` | shading model, see below |
| `albedo`   | `[r, g, b]`                                    | `[0.7, 0.7, 0.7]`| base surface color |
| `albedo2`  | `[r, g, b]`                                    | `[0.3, 0.3, 0.3]`| secondary color, used by the `"checker"` pattern |
| `pattern`  | `"flat"` \| `"checker"`                        | `"flat"`         | how `albedo`/`albedo2` are combined across the surface |
| `scale`    | number                                          | `1`              | checker pattern tile scale |
| `solid`    | boolean                                         | `true`           | whether this material counts as solid geometry (`false` for e.g. water, glass, or a material only ever used on a purely spatial-subdivision node) |

`kind`-specific extra fields:

- `"glossy"`: `shininess` (default `32`), `specular` (default `0.6`)
- `"emissive"`: `emission` (default `1`)
- `"lambert"`, `"unlit"`: no extra fields
- `"ambient"`: no extra fields. An ambient material never shades a surface —
  naming one as a node's `material` instead moves that node's `albedo` into
  the ambient light level for everything in its `inside` subtree (see
  "Ambient regions" below), and the node itself keeps no material of its own.

Material `0` (vacuum/no material) is implicit and reserved; you never author
it directly, but a node with no `material` field resolves to it.

## `lights`

An array of:

```
{ "pos": [x, y, z], "color": [r, g, b] }
```

`color`'s magnitude is radiant power, not a 0–1 color — falloff is inverse
square, so values commonly run well above 1. At least one light is required.

## `objects`

A map of name → subtree definition (see "Subtrees" below). Each entry is
built once and shared by reference wherever it's referred to (by `"use"`, or
by giving its name as a bare string inside a `"group"`/`"union"` array) — so
reusing one collapses to a single set of nodes once the scene is flattened.
The exception is placing it with `"translate"`, which produces genuinely
different geometry and so can no longer share nodes with the original or
with other translated instances. An object may not refer to itself, directly
or through a chain of other objects.

## `root`

The scene's top-level subtree. Required. Same format as any other subtree.

## Subtrees

Anywhere a subtree is expected, one of the following is valid:

- the string `"empty"` — nothing here.
- a bare string naming an entry under `"objects"` — shorthand for
  `{ "use": "<name>" }`. Only valid as a member of a `"group"`/`"union"`
  array.
- an object with exactly one of `"use"`, `"group"`, or `"union"` (below).
- an object with a primitive (`"sphere"` or `"plane"`), plus optional
  `"inside"`/`"outside"`/material fields — an ordinary CSG node.

Any subtree object may also carry `"translate"` and/or `"bounds"` (below),
regardless of which of the forms above it uses.

### Primitives

A node (other than `"use"`/`"group"`/`"union"`) needs exactly one of:

- `"sphere"`: `{ "center": [x, y, z], "radius": number > 0 }`
- `"plane"`: `{ "normal": [x, y, z], "offset": number }` (`"offset"` defaults
  to `0`; it's the signed distance from the origin to the plane along
  `normal`)

`"complement"` (boolean, default `false`) negates the primitive, swapping
which side of it counts as inside — the standard CSG complement, A → U∖A.
For a sphere this turns it into a spherical hollow; for a plane it flips
which half-space is inside.

### `"inside"` / `"outside"`

A primitive node tests its implicit function `f(R)`; rays with `f(R) < 0`
descend into `"inside"`, everything else into `"outside"`. Both are
subtrees, and both default to `"empty"` when omitted — but an *unspecified*
`"inside"` and an *unspecified* `"outside"` mean different things:

- an omitted `"outside"` always means plain void.
- an omitted `"inside"` means "no further carving — this whole region is
  solid using this node's own `"material"`" (which may itself be non-solid,
  if that material's `"solid"` is `false`).

A bare primitive with neither field is just a simple solid shape (or hollow,
with `"complement": true`).

### `"material"` / `"paint"`

- `"material"`: the name of an entry in `"materials"`, read directly off
  this node at render time (there is no inheritance from ancestor nodes — a
  node that should be visible must name its own material). `"material":
  null` explicitly requests no material/vacuum, distinct from simply
  omitting the field only in intent, not effect — both resolve to no
  material.
- `"paint"`: deprecated alias for `"material"`; using it prints a console
  warning. Its old special values `"partition"`, `"inherit"`, and `"bare"`
  are still accepted but now all just mean "no material" (their old
  scope-inheritance behavior no longer exists).

### `"use"`

```
{ "use": "<object name>" }
```

Places a previously-defined `objects` entry inline. Commonly combined with
`"translate"` to drop multiple copies of the same object at different
positions without duplicating its definition.

### `"group"`

```
{ "group": [ <subtree-or-name>, ... ] }
```

A disjoint union: every member's solid region must be proven mutually
exterior to every other member's (via each member's own bounding sphere, or
its `"bounds"` if given). This is checked at compile time — a violated claim
throws rather than silently dropping geometry. In exchange for that
guarantee, the members are assembled into a BSP-style hierarchy (each split
also acting as a bounding-volume test) instead of a flat chain, which is
generally much cheaper to traverse than an equivalent `"union"`. A member
with no provable bound (e.g. an unbounded half-space) must be given
`"bounds"` explicitly, or the group fails to compile. Takes no `"inside"`/
`"outside"` of its own.

### `"union"`

```
{ "union": [ <subtree-or-name>, ... ] }
```

A general CSG union, correct for any pair of subtrees regardless of overlap:
every solid region of each member stays solid, and each member's empty
regions are filled in by whichever member comes after it in the array. Use
this instead of `"group"` when members might overlap or you can't (or don't
want to) prove disjointness. Takes no `"inside"`/`"outside"` of its own.

### `"translate"`

```
"translate": [x, y, z]
```

Rigidly translates every primitive in the subtree by the given world-space
offset. Valid on any subtree form. A translated subtree is genuinely
different geometry from its source, so it no longer shares nodes with the
original (or with other translated copies) once the scene is flattened.

### `"bounds"`

```
"bounds": { "center": [x, y, z], "radius": number > 0 }
```

Declares a bounding sphere for this subtree by hand, overriding whatever
bound (if any) could otherwise be inferred from its own shape. Needed for
`"group"` members whose solidity isn't already confined to one ball by their
own root primitive — most commonly a `"union"` of several primitives, or any
subtree built from unbounded half-spaces.

## Ambient regions

A node whose `"material"` names an `"ambient"`-kind material becomes a pure
spatial split rather than a visible substance: it gets no material of its
own, and its would-be albedo instead sets the ambient light level for
everything in its `"inside"` subtree. `"outside"` always keeps whatever
ambient level was already in effect above it, never adopts the node's own —
so ambient regions can be nested the same way solids can, by descending
through `"inside"`.
