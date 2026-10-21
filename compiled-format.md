# Compiled scene format

What a scene becomes once compiled, at the two levels at which things read it:

1. **The compiled scene:** what `compileScene()` in `public/antisphere-scene.js`
   returns - plain JS objects: a flat array of nodes, a material table,
   lights and a few scene-wide settings. The editor's picking, physlab's
   physics, the overlap test and the tests read this.
2. **The GPU buffers:** what `ASScene` (`public/as-context.js`) packs that
   into - four storage buffers of fixed-size structs, which the shaders read.

The authored form is in `scene-format.md`; the model the tree encodes (nodes
divide space, materials fill it) is in `DESIGN.md`; the quadrics themselves
are in `hyperconic.md`.

**Where the truth lives.** The struct layouts are declared once, in
`shaders/node.wgsls` and `shaders/antisphere-raycast.wgsls`, and
`tools/build-shaders.mjs` generates the JS classes that write them
(`public/gen/layouts.js`: `Node`, `Material`, `Light`, with each field's
offset in `FIELDS`). The tables below were taken from them; if they ever
disagree, `layouts.js` is right.

## Compiling

```js
import { compileScene, loadReferences } from './antisphere-scene.js';

const files = await loadReferences(spec, { from: 'scenes/maze.json', readText, readBytes });
const built = compileScene(spec, { files, path: 'scenes/maze.json' });
```

| option  | what |
|---|---|
| `files` | what the scene references, path → content, as `loadReferences()` fetches it. A reference not in it is an error |
| `path`  | the scene's own path, which its references are relative to |
| `warn`  | `(path, message)`, told each warning instead of the console: a slip the scene plays on past (`scene-format.md`, "When something is missing") |
| `quiet` | no warnings on the console |

Before anything is flattened, the compiler expands references, resolves
`"tangentTo"` and `"drop"`, applies every transform to the quadrics
themselves, divides groups (`chooseDivider()`, `buildGroup()`), adds wrappers
and bounds, and bakes each node's material and env (`bakeScopes()`). So
nothing in the compiled scene refers to an object by name, carries a
transform, or inherits anything: each node says exactly what it is.

The spec it was given is not changed.

## The compiled scene

`compileScene()` returns:

| field        | what |
|---|---|
| `nodes`      | the tree, flattened: an array of nodes, `nodes[1]` the root |
| `provenance` | `provenance[i]`: where node `i` came from in the spec, or `null` |
| `materials`  | the material table; a node's `material` indexes it |
| `lights`     | every light, the scene's and its nodes', ordered by env |
| `topLights`  | how many of `lights`, at the front, are the scene's own |
| `camera`     | the spec's `"camera"`, as written, or `null` |
| `gravity`    | `parseGravity()`'s reading of `"gravity"` |
| `spawn`      | `parseSpawn()`'s reading of `"spawn"`, or `null` |
| `overlaps`   | the group members that may overlap |

### `nodes`

Each node is a quadric that divides space in two, and the indices of what
lies on each side of it:

```js
{ prim: { axis, k_par, k_perp, linear, constant },
  inside, outside,      // node indices; 0 is "no node" (see below)
  material,             // index into materials
  env,                  // node index of the env it is in, or 0
  prov,                 // as provenance[i]
  lights }              // the lights it carries, or null
```

**Node 0 is reserved.** It is never a real node: an `inside` or `outside` of
0 means "no child", and its own fields are zeros. **The root is node 1.**

**The tree may share.** A subtree used in several places - a `"use"`, the
members a group's divisions both reach - is one set of nodes, reached by
several parents, so the array is a directed acyclic graph rather than a tree.
A child always has a larger index than the node it was first reached from.

#### The quadric, `prim`

$$
H(\vec r) = k_\perp \vec r\cdot\vec r + (k_\parallel - k_\perp) (\vec r\cdot\vec n)^2
          + 2 \vec c\cdot\vec r + d
$$

with $\vec n$ = `axis` (a unit vector), $k_\parallel$ = `k_par`, $k_\perp$ = `k_perp`,
$\vec c$ = `linear` and $d$ = `constant`, $\vec r$ in world coordinates. A
point is **inside** the node where $H(\vec r) < 0$: strictly, so the surface
$H = 0$ belongs to neither side (`DESIGN.md`, "Why inside is H < 0").
`quadricAt()` and `gradientAt()` in `public/quadric.js` evaluate $H$ and
$\nabla H$.

The compiler scales each primitive so that $|\nabla H| = 1$ on its surface:
near it, $H$ is about the signed distance to it. For example:

| primitive | $k_\parallel$, $k_\perp$ | $\vec c$ | $d$ |
|---|---|---|---|
| sphere, centre $\vec q$, radius $r$ | $\frac{1}{2r}$, $\frac{1}{2r}$ | $-\frac{1}{2r}\vec q$ | $\frac{1}{2r}(\vec q\cdot\vec q - r^2)$ |
| plane, normal $\vec n$, offset $a$ | $0$, $0$ | $\frac{1}{2}\vec n$ | $-a$ |
| cylinder through the origin, radius $r$ | $0$, $\frac{1}{2r}$ | $\vec 0$ | $-\frac{r}{2}$ |

so a sphere's inside is its ball, and a plane's inside the half-space behind
its normal. The other shapes, and what transforms and complement do to the
coefficients, are in `hyperconic.md`. A complemented node has every
coefficient but the axis negated.

#### Reading the tree

What fills a point $\vec p$: start at node 1, and at each node

- if $H(\vec p) < 0$, go to `inside` - or, if that is 0, stop: the point is
  in this node's `material`;
- otherwise go to `outside` - or, if that is 0, stop: the point is in empty
  space (material 0).

An absent outside child means **empty**, not "whatever encloses this node":
that is what allows cutaways (`DESIGN.md`). A ray's walk, `trace()` in
`shaders/antisphere-raycast.wgsls`, is the same test along an interval of the
ray instead of at a point; `interiorPaths()` in `public/overlap.js` and the CSG
operators follow the same rules.

#### `material`, `env`, `prov`, `lights`

- **`material`** is an index into `materials`, resolved: inheritance, `null`
  and the compiler's own divisions have all been baked (`bakeScopes()`), so
  it is the material of the region this node's inside is, where nothing
  further divides it. 0 is vacuum.
- **`env`** is the index of the node that starts the env this node is in - a
  node naming an ambient or glow-region material, or carrying lights - or 0.
  An env node's own `env` is the env enclosing it, so following `env` walks
  outward to 0. A hit is lit by the lights of its env and of those enclosing
  it.
- **`prov`** is where the node came from: see `provenance`.
- **`lights`** are the lights a node carries in the spec (`"lights"` on a
  subtree), as compiled: they are also in the scene's `lights`, so a reader
  needn't look here.

### `provenance`

`provenance[i]` is `nodes[i].prov`: `{ owner, path }` for a node authored in
the spec, or `null` for node 0 and for the nodes the compiler made up - group
divisions and bounding wrappers, never a surface a ray stops on.

- **`owner`** is the key in `"objects"` of the object the node belongs to, or
  `"@root"` for the root subtree. An object brought in by reference is keyed
  by the file it came from (`scenes/parts/bolt.json#/objects/shaft`). An
  instance - an object whose body is just `{ use, translate }` - owns nodes of
  its own, so a hit names the instance, not only its prototype.
- **`path`** is the literal keys from that object's body down to the node,
  joined with `/`: `"inside/outside"`, `"union/2/inside"`. It is the same
  addressing the editor's `SceneDocument` uses for selections.

### `materials`

Index 0 is vacuum. Each entry:

| field     | what |
|---|---|
| `name`    | the name it was defined under (absent for 0 and for the compiler's own); for display only |
| `kind`    | the shading function: `KIND_LAMBERT` 0, `GLOSSY` 1, `EMISSIVE` 2, `UNLIT` 3, `AMBIENT` 4, `GLOW_REGION` 5 |
| `params`  | `[x, y]`, the kind's own: glossy `[shininess, specular]`, emissive `[emission, 0]`, ambient `[transmit, 0]`, glow region `[transmit, fill]` |
| `albedo`  | `[r, g, b]`; for an ambient material its level, for a glow region the light at its centre |
| `albedo2` | the pattern's second colour |
| `pattern` | `PATTERN_` flat 0, `CHECKER` 1, `NOISE` 2, `INDUSTRIALCARPET` 3 |
| `scale`   | the pattern's tile size |
| `opacity` | for glass and water: after distance $s$ through it, light is filtered by $\mathrm{albedo}^{s\cdot\mathrm{opacity}}$ |
| `flags`   | the trace flags, the `MATERIAL_` bits below; 0 for an ambient or glow region unless the spec sets some |
| `ambient` | on the compiler's copies only (below): the env's ambient level |

Every material in the spec is in the table, used or not (`DESIGN.md`,
Planned). After them come materials the compiler adds:

- **an env's level.** An env node's material is a copy of the material it
  names, with `ambient` set to the level there - its own plus `transmit`
  times the level around it - one copy per level it comes to.
- **a pass-through region.** A node carrying lights but naming no material
  gets an ambient material of level 0 and `transmit` 1, so lighting a region
  leaves its ambient level alone.

`isSolid(m)` says whether a material has `MATERIAL_SOLID`.

### `lights`

Each light is `{ pos, color, pos_w, env }`, homogeneous:

- `pos_w` 1, a point light at `pos`, `color` its radiant power (inverse square
  falloff, so values well above 1);
- `pos_w` 0, a directional light, `pos` the unit direction towards it (the
  opposite of the way its light travels), `color` its irradiance.

`env` is the env it lights: 0 for the scene's own, which come first
(`topLights` of them, in the spec's order); then each node's, under that
node. The list is in order of env, which the shader relies on: it finds an
env's lights by binary search (`firstLightOf()`). A lit subtree used in
several places gives its lights once per copy, each under its own copy's
env.

### `camera`, `gravity`, `spawn`, `overlaps`

- **`camera`** is the spec's `"camera"` unchanged (`ASCamera.setFromSpec()`
  reads it), or `null`.
- **`gravity`** is always present: `{ kind: 'uniform', down, strength }`
  (`down` unit; the default is $-\vec z$ at 9.81), or `{ kind: 'central',
  center, strength, radius, gm }`, with $gm$ = strength × radius².
- **`spawn`** is `{ at, facing }`, or `null`.
- **`overlaps`** lists, per group, the pairs of members its divisions could
  not prove apart: `{ group, members: [i, j] }`, `group` the group's path,
  `i < j` indices into its member array. Physics tests these pairs.

## On the GPU

`ASScene` packs the compiled scene into four storage buffers, each an array
of one struct. These are the four packing functions in `antisphere-scene.js`:

| buffer      | struct, stride   | packed by | binding in the raycast shader |
|---|---|---|---|
| nodes       | `Node`, 64 bytes  | `packNodes(nodes, materials)` | `nodes` |
| surfaces    | `u32`, 4 bytes    | `packSurfaces(nodes)` | `surfaces` |
| lights      | `Light`, 32 bytes | `packLights(lights)` | `lights` |
| materials   | `Material`, 64 bytes | `packMaterials(materials)` | `materials` |

Index $i$ in each array is entry $i$ of the compiled scene's list. All values
are 32-bit, little-endian.

### `Node`

| offset | field | type | from the compiled node |
|---|---|---|---|
| 0  | `axis`            | `vec3<f32>` | $\vec n$ |
| 12 | `curvature_perp`  | `f32`       | $k_\perp$ |
| 16 | `linear`          | `vec3<f32>` | $\vec l = 2\vec c_a$, about the anchor (below) |
| 28 | `curvature_delta` | `f32`       | $\delta = k_\parallel - k_\perp$ |
| 32 | `const_term`      | `f32`       | $d_a = H(\vec a)$, about the anchor |
| 36 | `inside`          | `u32`       | as compiled |
| 40 | `outside`         | `u32`       | as compiled |
| 44 | `material_id`     | `u32`       | the material's index, with its `flags` above it (below) |
| 48 | `anchor`          | `vec3<f32>` | $\vec a$, from `anchorOf()` |
| 60 | `env`             | `u32`       | as compiled |

**Rearranged, not changed.** The GPU's nine numbers are the forms the
shader's formulas want: $\delta$ is zero exactly when the axis doesn't matter
(a sphere or a plane), and $\vec l$ is what both $H$ and $\nabla H$ take.
$k_\parallel = k_\perp + \delta$ and $\vec c_a = \vec l / 2$, so nothing is
lost.

**About the anchor.** In f32, a quadric 500 m from the origin, expanded about
the origin, has terms of $250000 k$ cancelling to the small $H$ near its
surface, leaving few correct digits. So the GPU's coefficients are about the
node's anchor $\vec a$, a point near its own surface - a sphere's,
spheroid's or hyperboloid's centre, a cone's apex, a paraboloid's vertex, a
point of a cylinder's axis or a slab's middle plane; the origin for a plane,
or for anything within twice its size of the origin:

$$
\begin{aligned}
\vec u &= \vec p - \vec a \\
H(\vec p) &= k_\perp \vec u\cdot\vec u + \delta (\vec u\cdot\vec n)^2 + \vec l\cdot\vec u + d_a \\
\vec c_a &= \mathbf{K}\vec a + \vec c, \qquad \mathbf{K} = k_\perp \mathbf{I} + \delta \vec n \vec n^{\mathsf T} \\
d_a &= H(\vec a)
\end{aligned}
$$

where $\vec c_a$ and $d_a$ are the linear and constant terms about the anchor, worked
out in f64 by `packNodes()`.

**`material_id`.** The low 27 bits index the material; the high bits are its
trace flags, so `trace()` reads what a ray does in a region without looking
the material up. They come from the material's `flags`; without a material
table (`packNodes(nodes)`, as physics packs), only the index.

| bits  | mask | flag | scene key |
|---|---|---|---|
| 31    | `0x80000000` | `MATERIAL_SOLID`: there, physically (walk camera, physics, `castRays()`) | `solid` |
| 30    | `0x40000000` | `MATERIAL_OPTICAL`: camera and shadow rays stop there | `optical` |
| 28–29 | `0x30000000` | `MATERIAL_IOR`: glass `0x20000000` (1.5), water `0x10000000` (1.333), both (2.42) | `iorGlass`, `iorWater` |
| 27    | `0x08000000` | `MATERIAL_REFLECTIVE`: a mirror | `reflective` |
| 0–26  | `0x07ffffff` | `MATERIAL_INDEX`: the material's index | |

A material that is neither an ambient nor a glow region has `SOLID` and
`OPTICAL` by default; each scene key sets or clears its own bit.

### `surfaces`

One `u32` per node: an id shared by every node that is the same surface - the
copies the compiler makes of a node, and its complement - from 1, with 0 for
node 0. A ray that starts on a surface (a shadow ray from a hit, a reflected
or refracted ray) is given that surface's id, and `trace()` never counts its
start on any node with that id: no offset, no tolerance (`DESIGN.md`,
Planned, "Rays that continue from a hit").

### `Material`

| offset | field | type | from the compiled material |
|---|---|---|---|
| 0  | `kind`    | `u32`       | `kind` |
| 4  | `pattern` | `u32`       | `pattern` |
| 8  | `params`  | `vec2<f32>` | `params` |
| 16 | `albedo`  | `vec3<f32>` | `albedo` |
| 28 | `scale`   | `f32`       | `scale` |
| 32 | `albedo2` | `vec3<f32>` | `albedo2` |
| 44 | `opacity` | `f32`       | `opacity`, default 1 |
| 48 | `ambient` | `vec3<f32>` | `ambient`, default 0 |

`flags` and `name` aren't here: the flags travel in each node's
`material_id`.

### `Light`

| offset | field | type |
|---|---|---|
| 0  | `pos`   | `vec3<f32>` |
| 12 | `env`   | `u32` |
| 16 | `color` | `vec3<f32>` |
| 28 | `pos_w` | `f32` |

An empty list is packed as one black light, since a storage buffer can't be
empty.

## An example

```json
{
  "materials": {
    "stone": {
      "albedo": [ 0.6, 0.6, 0.6 ]
    }
  },
  "lights": [
    {
      "pos": [ 0, 0, 5 ],
      "color": [ 10, 10, 10 ]
    }
  ],
  "root": {
    "sphere": {
      "center": [ 0, 0, 0 ],
      "radius": 10
    },
    "inside": {
      "sphere": {
        "center": [ 0, 0, 1 ],
        "radius": 1
      },
      "material": "stone"
    }
  }
}
```

compiles to:

| node | `prim` ($\vec n$; $k_\parallel$, $k_\perp$; $\vec c$; $d$) | `inside` | `outside` | `material` | `prov` |
|---|---|---|---|---|---|
| 0 | zeros | 0 | 0 | 0 | `null` |
| 1 | $\vec z$; 0.05, 0.05; $\vec 0$; −5 | 2 | 0 | 0 | `@root`, `""` |
| 2 | $\vec z$; 0.5, 0.5; $(0, 0, -0.5)$; 0 | 0 | 0 | 1 | `@root`, `"inside"` |

- **Inside the small ball** - node 1's inside, then node 2's, which has no
  inside child - is stone.
- **Inside the big ball but outside the small one** is node 2's absent
  outside: empty.
- **Beyond the big ball** is node 1's absent outside: empty.

The materials are `[vacuum, stone]`, stone's `flags` `0xC0000000` (`SOLID |
OPTICAL`). The one light is `{ pos: [0, 0, 5], color: [10, 10, 10], pos_w: 1,
env: 0 }`, and `topLights` is 1.

Packed, node 2 is `axis` $\vec z$, `curvature_perp` 0.5, `curvature_delta` 0,
`linear` $(0, 0, -1)$, `const_term` 0, `anchor` the origin (its centre is
within twice its size of it), and `material_id` `0xC0000001`. `surfaces` is
`[0, 1, 2]`.
