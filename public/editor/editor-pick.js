// Picking: from a point on a pane to something selectable.
//
// Pure functions, so they can be tested without a GPU. editor.js casts the
// ray with ASScene.pick() and hands the hit to selectionForHit().

import { ROOT } from './scene-document.js';

const ROOT_OWNER = '@root';     // antisphere-scene.js's name for the root subtree

/**
 * The ray through a point on a pane, matching the shader's own camera
 * model: ndc from the pixel, then forward + right*x + up*y scaled by the
 * half-angle and aspect.
 *
 * @param {ASCamera} camera   needs basis() and fovY
 * @param {DOMRect} rect      the canvas's bounding rectangle
 */
export function rayThroughPixel(camera, rect, clientX, clientY) {
  const { eye, forward, right, up } = camera.basis();
  const x = ((clientX - rect.left) / rect.width) * 2 - 1;
  const y = 1 - ((clientY - rect.top) / rect.height) * 2;
  const tanHalf = Math.tan(0.5 * camera.fovY);
  const aspect = rect.width / rect.height;
  const d = forward.map((f, i) => f + right[i] * x * aspect * tanHalf + up[i] * y * tanHalf);
  const len = Math.hypot(d[0], d[1], d[2]);
  return { origin: eye.slice(), direction: d.map((v) => v / len) };
}

/**
 * What a hit on `node` should select, or null if it isn't something the
 * user authored. A plain click selects the whole object; `deep` (a double
 * click) drills into the node itself. The root isn't an object, so a hit
 * there always selects the node.
 */
export function selectionForHit(provenance, node, { deep = false } = {}) {
  const prov = provenance?.[node];
  if (!prov) return null;
  if (prov.owner === ROOT_OWNER) return { owner: ROOT, path: prov.path };
  return { owner: prov.owner, path: deep ? prov.path : '' };
}
