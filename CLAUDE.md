# Working on antisphere-explorer

A ray caster, CSG and (soon) physics built on one kind of node: a quadric
that divides space. What the model is, why, and where it is going:

@DESIGN.md

Read it before design work; it is the one source of truth for the model.
The code and the docs in this repo outrank anything remembered from earlier
sessions.

## Workflow

- One named branch per piece of work, off `origin/main`, pushed to
  `origin/<branch>`. Never commit or push to `main`: Chris merges, usually
  fast-forward when the branch's commits stand on their own.
- Commit in steps that each pass `npm test` and have been checked; say in
  the message how (byte-identical output, pixel hash, benchmark numbers).
- Before a change that could alter rendering, compare against a baseline:
  a pixel hash of a render of `public/scenes/scene.json`, and
  `node tools/bench-render.mjs 1920x1080` for speed.

## Commands

    npm install              once; `npm ci` to install exactly the lockfile
    npm test                 unit tests, plus GPU tests when a GPU is there
    npm run shaders          build shaders/*.wgsls into public/gen/
    npm run shaders:watch    rebuild on change
    node tools/bench-render.mjs [scene.json] [WxH ...]
    node tools/bench-compare.mjs [-r rev ...] scene ...
                             scenes x revisions, one table, with work counts
    node tools/shader-stats.mjs [file.wgsl] [entry ...] [--dump DIR]

Shader sources are `shaders/*.wgsls`; `public/gen/` is generated but
committed (see the README). The JS never spells out a struct offset: use
the classes in `public/gen/layouts.js`.

## Environment

A rootless podman container with the host GPU passed through (an Intel
Raptor Lake iGPU, Mesa's Vulkan driver). WebGPU runs headless in Node
through Dawn (the `webgpu` package); there is no browser. Scripts must keep
the object `webgpu.create()` returns referenced (e.g. on
`navigator.gpu`): if it is garbage collected mid-run, Dawn crashes.

## Documentation conventions

Markdown, with LaTeX for maths:

- **Vectors**: lowercase with an arrow, e.g. `v⃗`
- **Aggregate objects** (a node as a whole, as opposed to a vector
  component of it): bold, no arrow
- **Aligned equation systems**: `align` / `aligned`
