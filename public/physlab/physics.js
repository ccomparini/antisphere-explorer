// physlab's physics, host side: what the compute passes in
// shaders/physics.wgsls work on, and (as it grows) running them.
//
// A solid is a compiled geometry subtree: its nodes, and its interior paths
// - each a conjunction of regions (node, sign), from interiorPaths() in
// overlap.js. Two solids touch where a path of one and a path of the other
// share a point; pathContact() in the shader finds it.

import { compileScene, packNodes } from '../antisphere-scene.js';
import { interiorPaths } from '../overlap.js';
import { Path, Region } from '../gen/layouts.js';

/** A geometry subtree (scene-format.md) as a solid: { nodes, paths }. */
export function compileSolid(geometry, materials) {
  const built = compileScene({ materials, lights: [], root: geometry });
  const solid = (i) => !!built.materials[built.nodes[i].material].solid;
  return { nodes: built.nodes, paths: interiorPaths(built.nodes, 1, solid) };
}

/**
 * Several solids in one set of buffers: their nodes one after another,
 * their paths' regions pointing into that, and for each solid where its
 * paths and nodes start and how many there are.
 *
 * @returns {{ nodes: ArrayBuffer, regions: ArrayBuffer, paths: ArrayBuffer,
 *             ranges: { firstPath, pathCount, firstNode, nodeCount }[] }}
 */
export function packSolids(solids) {
  const nodes = [], regions = [], paths = [], ranges = [];
  for (const s of solids) {
    const firstNode = nodes.length, firstPath = paths.length;
    nodes.push(...s.nodes);
    for (const path of s.paths) {
      paths.push({ first: regions.length, count: path.length });
      for (const { node, sign } of path) regions.push({ node: firstNode + node, sign });
    }
    ranges.push({ firstPath, pathCount: s.paths.length, firstNode, nodeCount: s.nodes.length });
  }
  const regionViews = Region.allocate(Math.max(1, regions.length));
  regions.forEach((r, i) => Region.write(regionViews, i, r));
  const pathViews = Path.allocate(Math.max(1, paths.length));
  paths.forEach((p, i) => Path.write(pathViews, i, p));
  return { nodes: packNodes(nodes), regions: regionViews.buffer, paths: pathViews.buffer, ranges };
}
