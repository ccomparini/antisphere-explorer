# antisphere-explorer

Proof-of-concept antisphere BSP tree renderer/constructive solid geometry.

An antisphere is a sphere defined by a normal, a distance to the surface from the origin along this normal, and a curvature.  Using this definition, planes can be represented as antispheres with curvature 0, and "hollows" (an inside-facing spherical cutout) can be represented by inverting the antisphere (giving it a negative curvature).

This means that CSG operations can be performed in the traditional way, with the addition of allowing spherical space divisions.  Similarly, BSP trees implemented with this concept can be constructed in such a way that they additionally achieve some of the advantages of bounding volume hierarchies.

This is raycaster implemented using this concept.

The model as it stands now (nodes are general quadrics of revolution these
days), and where it is going, is in [DESIGN.md](DESIGN.md). What a scene
file says is in [scene-format.md](scene-format.md), and what it compiles to,
for the shaders and anything else reading it, in
[compiled-format.md](compiled-format.md).

## Viewing

`antisphere-raycast.html` shows `scenes/scene.json`, or another scene:

    antisphere-raycast.html?scene=tori.json
    antisphere-raycast.html?scene=https://example.com/models/scene.json
    antisphere-raycast.html?scene=https://example.com/models/teapot.stl

A name is a file in `public/scenes/`; a full URL loads from anywhere that
allows it (the server must permit cross-origin requests), along with what
that scene references (`"@parts/bolt.json#/objects/bolt"`, see
scene-format.md, References), from beside it there. An `.stl`, here or
there, is shown on its own, scaled to 2 across on a floor with a sky and
lights. Anything ending in `.gz` (`scene.json.gz`, `model.stl.gz`) is
unzipped as it loads.

## Shaders

The shader sources live in `shaders/` as `.wgsls` files ("WGSL source"):
WGSL plus a few C-style directives, each on a line of its own. They are not
valid WGSL themselves, hence the extension.

    #import "node.wgsls"       another file, relative to this one; included
                               once, ahead of the files that import it
    #if NAME / #elif / #else / #endif
                               conditional lines; NAME is set per output in
                               shaders/build.json (!, &&, || and parentheses work)
    #error "message"           stop the build
    #warning "message"         print a warning and carry on

Resources (`var<uniform>`, `var<storage, ...>`, textures, samplers) are
declared with no `@group` or `@binding`; the build numbers them, per output:

    var<storage, read> nodes : array<Node>;

Since `#import` is a plain include, hand-numbered bindings had to agree across
every file an output pulls in. JS binds by name instead, with `bindGroup()`
in `public/bind-group.js`, which supplies just the resources the pipeline's
entry points use.

The page doesn't read `shaders/`: it loads plain WGSL from `public/gen/`,
which the build writes (and which is committed, so the page serves as-is):

    npm run shaders            build once
    npm run shaders:watch      rebuild whenever shaders/ changes

`shaders/build.json` lists the outputs. The build also writes
`public/gen/layouts.js`, a class for every struct a shader shares with JS
through a uniform or storage buffer, laid out by WGSL's rules, so the JS
never spells out an offset, and `BINDINGS`: each output's resources by
name, with the binding the build gave each and the ones each entry point
uses (worked out from its calls; see `tools/shader-build/bindings.js`).
It also exports every scalar `const` the shaders declare at module scope -
`MATERIAL_SOLID`, the `KIND_` ids, the `DEBUG_` views - so a flag or an id
is written once, in WGSL, and the JS imports it; one name given two values
by two outputs fails the build.
Compile errors are reported at their line in
`shaders/`. With the watcher running, R in the page reloads the shaders; a
change to a shared struct also changes `layouts.js`, which needs a full page
reload.

Editors won't know `.wgsls` is WGSL until told. In VS Code, add
`"files.associations": { "*.wgsls": "wgsl" }` to your settings; in vim,
`autocmd BufRead,BufNewFile *.wgsls set filetype=wgsl`.

## Testing

    npm install
    npm test

`npm test` runs every `*.test.mjs` under `public/` and `tools/`. Most of them
check the scene compiler and JS transcriptions of the shader; `gpu.test.mjs`
runs the shaders themselves, headless, through Dawn (the `webgpu` package),
and checks every generated struct layout against the one Dawn actually uses.
It needs a Vulkan-capable GPU (a software one like llvmpipe works too) and
skips itself when there isn't one. `npm run test:gpu` runs just that file.

Alternately:

    node --test '**/*.test.mjs'

finds and runs all the test files below the current directory.

## Benchmarking

Three tools, all headless through Dawn like the GPU tests. Each one's full
documentation is the comment at the top of its file.

### Comparing revisions: `tools/bench-compare.mjs`

The one to reach for when a change might cost time. It renders scenes on
several revisions and prints one table:

    node tools/bench-compare.mjs -r origin/main -r . public/scenes/scene.json public/scenes/maze.json

- `-r <rev>` names a git revision (repeatable). `.` is the working tree, and
  is the default. The first revision is the baseline the others show a
  percentage against. Every other revision is checked out in a temporary
  worktree and measured with its own compiler, shaders and renderer.
- A scene can be a file path, which every revision renders as it stands, or
  a name under `public/scenes`, read from each revision's own tree. To
  measure code, keep the scene fixed: give a path, or copy the scene outside
  the repo if the revisions change it.
- `-n` sets the runs per measurement (default 3; the median is reported),
  `-s WxH` the size (default 1920x1080), and `-t` a time limit per run.

What the columns mean:

| column | meaning |
|---|---|
| `compute ms` | the GPU's compute pass, from timestamps: the number to watch |
| `traversal`, `shading`, `shadows` | what each stage adds, by switching the later stages off (the ablation ladder) |
| `frame ms` | wall-clock time per frame, pipelined |
| `visits/px`, `shadow rays/px`, `depth` | work per pixel, counted by the shader itself |

The work counts are the same on every run and every machine. So if the
times move and the work counts don't, the change is in the generated code,
not in the work done.

It takes a while: each scene on each revision is 3 runs, each in a fresh
process. Two revisions over six scenes is about 7 minutes on the Intel iGPU
here, and three revisions over six scenes about 15. Run it in the
background and save the output to a file.

Scenes that cover the renderer well:

- `scene.json`: the default view; heavy on shadow rays
- `maze.json`: many walls, few lights; mostly traversal
- `candle.json`, `candle-no-env.json`: lights scoped by env, and without
- `scene-ambient.json`: 1400 nodes; mostly traversal
- `scene-gallery.json`: every kind of quadric
- `mirrors.json`, `mirror-hall.json`, `glass-hall.json`: reflection and
  refraction (on the `reflection`, `refraction` and `glass-depth`
  branches until they are merged)

### One revision: `tools/bench-render.mjs`

    node tools/bench-render.mjs [scene.json] [WxH ...]

Times the default view, or a given scene, at one or more sizes. It reports
the compute and blit passes, the ablation ladder, and frame times both one
at a time and pipelined.

### What the compiler made: `tools/shader-stats.mjs`

    node tools/shader-stats.mjs [--dump DIR]

For each entry point, the compiled shader's instructions, register spills
and fills, scratch-array traffic and loops, from Mesa's Intel compiler. Each
count is "total (in loops)", and the in-loop count matters most. These are
static counts: useful for before-and-after comparisons, and for asking why
a change cost time, but not timings. `--dump DIR` keeps the compiler's full
output for each entry point. It works only with Mesa's Intel driver.

### Checking a change

A shader change is usually checked like this, and the commit message says
what was found:

1. `npm test`.
2. Renders compared pixel for pixel with the baseline, where nothing should
   change visibly.
3. `shader-stats` before and after.
4. `bench-compare` against `origin/main` (and the previous step, if the
   work is in several), on the scenes above.

Code generation varies a lot between GPUs. The Intel iGPU here and an Apple
M1 have disagreed about the same change, so a change that matters is timed
on both.
