# antisphere-explorer

Proof-of-concept antisphere BSP tree renderer/constructive solid geometry.

An antisphere is a sphere defined by a normal, a distance to the surface from the origin along this normal, and a curvature.  Using this definition, planes can be represented as antispheres with curvature 0, and "hollows" (an inside-facing spherical cutout) can be represented by inverting the antisphere (giving it a negative curvature).

This means that CSG operations can be performed in the traditional way, with the addition of allowing spherical space divisions.  Similarly, BSP trees implemented with this concept can be constructed in such a way that they additionally achieve some of the advantages of bounding volume hierarchies.

This is raycaster implemented using this concept.

The model as it stands now (nodes are general quadrics of revolution these
days), and where it is going, is in [DESIGN.md](DESIGN.md).

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

The page doesn't read `shaders/`: it loads plain WGSL from `public/gen/`,
which the build writes (and which is committed, so the page serves as-is):

    npm run shaders            build once
    npm run shaders:watch      rebuild whenever shaders/ changes

`shaders/build.json` lists the outputs. The build also writes
`public/gen/layouts.js`, a class for every struct a shader shares with JS
through a uniform or storage buffer, laid out by WGSL's rules, so the JS
never spells out an offset. Compile errors are reported at their line in
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
