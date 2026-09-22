# Scene JSON format

A scene file describes a camera, a material palette, a set of lights, and a
CSG tree of quadric primitives. `compileScene()` in
`public/antisphere-scene.js` turns it into the flat node/material/light
tables the WGSL raycaster (`public/antisphere-raycast.wgsl`) actually reads.
See `public/scene.json` for a large worked example, and `public/scene-simple.json`
/ `public/scene-just-tower.json` for smaller ones.

## Coordinates

All positions, normals and offsets are in a right-handed coordinate system
with **+z up**; +x and +y span the ground plane. Lengths are in scene units
with no implied real-world scale, so a scene is free to treat one unit as a
metre, a kilometre, or a pixel, as long as it does so consistently — the only
place absolute magnitude matters is light `color`, whose inverse-square
falloff is expressed in those same units.

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
and behave. The name `inherit` is reserved (left over from the deprecated
`paint` field) and can't be used as a material name.

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
it directly, but it is what a node resolves to when no material is named
anywhere above it.

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
An object may not refer to itself, directly or through a chain of other
objects.

Two things break that sharing, both deliberately:

- Placing a subtree with a **transform** (`"translate"`, `"rotate"`,
  `"scale"`) produces genuinely different geometry, which can no longer
  share nodes with the original or with other transformed copies.
- An **instance** — an object whose whole body is a `"use"` of another
  object — gets nodes of its own even when it isn't transformed, so that a
  ray hit can say which instance was struck rather than only which prototype.
  Two instances of the same prototype in the same place are the same
  geometry twice over, and the compiler warns about it.

That second point is what makes an object key an identity: every selectable
thing in the editor is a named object, and a hit maps back to the nearest
named object that owns the node it struck.

## `root`

The scene's top-level subtree. Required. Same format as any other subtree.

## Subtrees

Anywhere a subtree is expected, one of the following is valid:

- the string `"empty"` — nothing here.
- a bare string naming an entry under `"objects"` — shorthand for
  `{ "use": "<name>" }`. Only valid as a member of a `"group"`/`"union"`
  array.
- an object with exactly one of `"use"`, `"group"`, or `"union"` (below).
- an object with exactly one primitive (below), plus optional
  `"inside"`/`"outside"`/material fields — an ordinary CSG node.

Any subtree object may also carry `"translate"`, `"rotate"`, `"scale"`
and/or `"bounds"` (below), regardless of which of the forms above it uses.

### Primitives

A node (other than `"use"`/`"group"`/`"union"`) needs exactly one of the
shapes below. Naming none, or more than one, is an error.

Every one of them is a quadric of revolution: a surface with an axis, a
curvature along that axis and another around it. Internally a node stores
nine numbers — `n` (unit axis), `k_par`, `k_perp`, `c`, `d` — with the
implicit function

```
H(R) = k_perp (R·R) + (k_par - k_perp)(R·n)² + 2 c·R + d
```

and, as ever, `H(R) < 0` is inside. Sphere and plane are the isotropic case
of that (`k_par == k_perp`), and behave exactly as they always did; the rest
of the family is what having an axis buys.

| shape | fields | notes |
|-------|--------|-------|
| `"sphere"` | `center`, `radius` > 0 | |
| `"plane"` | `normal`, `offset` (default `0`) | signed distance from the origin along `normal`; see below |
| `"spheroid"` | `center`, `axis`, `semiAxial` > 0, `semiRadial` > 0 | ellipsoid of revolution: `semiAxial` along the axis, `semiRadial` around it. Equal values give a sphere |
| `"cylinder"` | `center`, `axis`, `radius` > 0 | infinite right circular cylinder; `center` is any point on the axis |
| `"slab"` | `center`, `axis`, `thickness` > 0 | the solid between two parallel planes perpendicular to `axis` |
| `"cone"` | `apex`, `axis`, `slope` > 0 | double cone; `slope` is radius gained per unit along the axis, so `1` is 45° |
| `"paraboloid"` | `vertex`, `axis`, `focal` > 0 | opens along `+axis`; the surface is \|R⊥\|² = 4·`focal`·x |
| `"hyperboloid"` | `center`, `axis`, `radius` > 0, `semiAxial` > 0, `sheets` (`1` or `2`, default `1`) | one sheet has a waist of `radius` about the axis; two sheets open away from `center` along it |
| `"quadric"` | `axis`, `k_par`, `k_perp`, `c`, `d` | the nine numbers directly, for anything the named shapes don't cover |

`"quadric"` is the way to write shapes with no name of their own — a
parabolic cylinder, say (`k_par` > 0, `k_perp` = 0, and a `c` with a
component perpendicular to the axis). All-zero parameters have no surface at
all and are rejected rather than silently rendering nothing.

`"complement"` (boolean, default `false`) negates the primitive, swapping
which side of it counts as inside — the standard CSG complement, A → U∖A.
For a sphere this turns it into a spherical hollow; for a plane it flips
which half-space is inside; for a cone it turns the two cups into everything
around them.

#### Which side of a plane is "inside"

A plane's implicit function is `f(R) = normal · R - offset`, and `"inside"`
is where `f(R) < 0` — the half-space the normal points *away* from. This
catches people out reliably, so, concretely:

```
{ "normal": [0, 0, 1], "offset": 0 }      // inside is z < 0, the ground down
{ "normal": [0, 0, -1], "offset": 0 }     // inside is z > 0, everything up
{ "normal": [0, 0, 1], "offset": 2 }      // inside is z < 2
{ "normal": [0, 0, 1], "offset": -1 }     // inside is z < -1
```

So a floor occupying everything below `z = 0` is the first of these, and the
same plane with `"complement": true` is the second. To build a box, intersect
half-spaces by nesting each plane in the previous one's `"inside"`, with the
normals pointing outwards from the solid. A slab needs no nesting: it is a
primitive in its own right.

#### Which side of the others is "inside"

For the bounded shapes, inside means what you'd expect: within the sphere or
spheroid, between the slab's two faces, within the cylinder's tube. The
unbounded ones are worth stating plainly:

- **cone**: inside is the two cups, the region *around* the axis within the
  half-angle — including both halves, since the apex joins them. A single
  cup is a cone intersected with a half-space, i.e. a plane in its `inside`.
- **paraboloid**: inside is the cupped region the surface encloses, opening
  along `+axis` from the vertex.
- **hyperboloid, one sheet**: inside is the region around the axis, inside
  the waist.
- **hyperboloid, two sheets**: inside is the two cupped regions; the gap
  between them is outside.

### `"inside"` / `"outside"`

A primitive node tests its implicit function `H(R)`; rays with `H(R) < 0`
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

- `"material"`: the name of an entry in `"materials"`. If omitted, the node
  inherits its nearest ancestor's material by descending through
  `"inside"` — the same rule described in "Ambient regions" below applies
  here too: an `"outside"` subtree always keeps whatever material was
  already in scope above it, never the node it hangs off of. Naming a
  material explicitly (even one already in scope) opts back out of
  inheriting further, which is what lets one CSG object show several
  materials on its different surfaces. `"material": null` explicitly
  requests vacuum/no material, likewise opting out of inheritance rather
  than picking up the surrounding scope — distinct from simply omitting
  the field, which inherits. A node with nothing named anywhere above it
  resolves to vacuum, which is how a pure spatial partition is written.
- `"paint"`: deprecated alias for `"material"`; using it prints a console
  warning. Its old value `"inherit"` now just means the same as omitting a
  material, which already inherits by default.

### `"use"`

```
{ "use": "<object name>" }
```

Places a previously-defined `objects` entry inline. Commonly combined with a
transform to drop copies of the same object in different places, at
different sizes and pointing different ways, without duplicating its
definition.

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
with no provable bound must be given `"bounds"` explicitly, or the group
fails to compile. Takes no `"inside"`/`"outside"` of its own.

**Only a sphere or a spheroid bounds anything by itself.** Everything else in
the table above runs off along its axis — a cylinder, cone, paraboloid,
hyperboloid or slab is unbounded, as is any half-space.

That's about the primitive alone, though, not about the subtree. A bound is
worked out from the whole subtree, so an unbounded shape carved down by
something bounded is bounded: a cone with a sphere in its `"inside"` is the
part of the cone within that sphere, and the sphere's ball bounds it. The
members that actually need help are the ones with nothing bounded anywhere
in them — a bare cone, a slab, a `"union"` of unbounded pieces. Give those
`"bounds"` explicitly, or use `"union"` instead of `"group"`.

### `"union"`

```
{ "union": [ <subtree-or-name>, ... ] }
```

A general CSG union, correct for any pair of subtrees regardless of overlap:
every solid region of each member stays solid, and each member's empty
regions are filled in by whichever member comes after it in the array. Use
this instead of `"group"` when members might overlap or you can't (or don't
want to) prove disjointness. Takes no `"inside"`/`"outside"` of its own.

## Transforms

`"translate"`, `"rotate"` and `"scale"` are valid on any subtree form, and
transform every primitive in the subtree. A transformed subtree is genuinely
different geometry from its source, so it no longer shares nodes with the
original (or with other transformed copies) once the scene is flattened.

### `"translate"`

```
"translate": [x, y, z]
```

Rigidly translates the subtree by the given world-space offset.

### `"rotate"`

```
"rotate": { "axis": [x, y, z], "degrees": 90 }
"rotate": { "axis": [0, 0, 1], "radians": 1.5708, "pivot": [x, y, z] }
```

Turns the subtree about `axis` — which need not be unit length, but must
have a direction — by exactly one of `degrees` or `radians`. Rotation is
right-handed: `+90°` about `[0, 0, 1]` takes `+x` to `+y`. `pivot` is the
point turned about, defaulting to the origin; give it the object's own
centre to turn something where it stands.

### `"scale"`

```
"scale": 2
"scale": { "factor": 0.5, "pivot": [x, y, z] }
```

Uniform scale about `pivot` (default the origin) by a positive factor.
Scaling is uniform only: a subtree's primitives may point any way they like,
and scaling one axis differently would take most of them outside the family
of shapes a node can hold. To make a sphere into a spheroid, author a
`"spheroid"`.

Note that scale is about a point, so `"scale": 2` on an object away from the
origin moves it as well as enlarging it — usually not what's wanted. Either
give a `pivot`, or scale before translating (see below).

### Order

When a node carries more than one, they apply as **scale, then rotate, then
translate** — "make it this big, point it this way, put it here":

```
{ "use": "bar", "scale": 2, "rotate": { "axis": [1, 0, 0], "degrees": 90 },
  "translate": [0, 0, 3] }
```

Any other order is written by nesting, since each level transforms whatever
the level below it produced:

```
{ "union": [ { "use": "bar", "translate": [0, 0, 5] } ], "scale": 2 }
```

translates first, then scales the result — which lands somewhere else
entirely.

### `"bounds"`

```
"bounds": { "center": [x, y, z], "radius": number > 0 }
```

Declares a bounding sphere for this subtree by hand, overriding whatever
bound (if any) could otherwise be inferred from its own shape. Needed for
`"group"` members whose solidity isn't already confined to one ball by their
own root primitive — most commonly a `"union"` of several primitives, or any
subtree whose root is one of the unbounded shapes.

Bounds are in world space, so they describe the subtree *after* its own
transforms have been applied.

## Ambient regions

A node whose `"material"` names an `"ambient"`-kind material becomes a pure
spatial split rather than a visible substance: it gets no material of its
own, and its would-be albedo instead sets the ambient light level for
everything in its `"inside"` subtree. `"outside"` always keeps whatever
ambient level was already in effect above it, never adopts the node's own —
so ambient regions can be nested the same way solids can, by descending
through `"inside"`.

## A note on duplicate keys

JSON resolves duplicate keys silently, keeping the last one. This format puts
many optional siblings in a single object, so writing two primitives in one
node —

```
{ "sphere": { ... }, "sphere": { ... } }     // the first one is gone
```

— loses geometry with no error from the parser and no complaint from the
compiler. If a piece of geometry goes missing without a diagnostic, check
for a repeated key before looking anywhere else. (Two *different* shapes in
one node is caught and reported; it's only the repeated key that JSON
swallows before the compiler ever sees it.)
