# antisphere-explorer

Proof-of-concept antisphere BSP tree renderer/constructive solid geometry.

An antisphere is a sphere defined by a normal, a distance to the surface from the origin along this normal, and a curvature.  Using this definition, planes can be represented as antispheres with curvature 0, and "hollows" (an inside-facing spherical cutout) can be represented by inverting the antisphere (giving it a negative curvature).

This means that CSG operations can be performed in the traditional way, with the addition of allowing spherical space divisions.  Similarly, BSP trees implemented with this concept can be constructed in such a way that they additionally achieve some of the advantages of bounding volume hierarchies.

This is raycaster implemented using this concept.

## Testing

    npm install
    npm test

`npm test` runs every `*.test.mjs` under `public/` and `tools/`. Most of them
check the scene compiler and JS transcriptions of the shader; `gpu.test.mjs`
runs `antisphere-raycast.wgsl` itself, headless, through Dawn (the `webgpu`
package). It needs a Vulkan-capable GPU (a software one like llvmpipe works
too) and skips itself when there isn't one. `npm run test:gpu` runs just
that file.
