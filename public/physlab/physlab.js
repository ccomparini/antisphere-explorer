// physlab: somewhere to try physics against an antisphere scene, and so to
// exercise the GPU overlap queries. For now it only renders its scene.
//
// Distances are in meters.

import { ASContext } from '../as-context.js';
import '../as-renderer.js';           // registers the renderer ASContext.createRenderer makes
import { ASCamera } from '../as-camera.js';

// A small, very dense planetoid, 1 km across, centred at the origin: one
// sphere, the scene's only node. The camera starts on its surface, 10
// degrees off the north pole (the checker's longitudes pinch at the pole),
// where the camera's world-Z "up" is close to the surface's.
const PLANETOID = {
  camera: { target: [0, -86.8, 492.4], yaw: 0.6, pitch: 0.35, distance: 40 },
  materials: {
    // Sphere surface coordinates are longitude and latitude in radians,
    // times scale: 50 makes squares of 0.02 rad, about 10 m here.
    rock: { albedo: [0.46, 0.43, 0.39], albedo2: [0.31, 0.29, 0.27],
            pattern: 'checker', scale: 50 },
  },
  // A distant sun. Light falls off as color / (1 + d^2), so at about 7 km
  // it takes a color in the tens of millions to light the ground.
  lights: [{ pos: [3000, -4000, 5000], color: [3.6e7, 3.3e7, 2.9e7] }],
  objects: {},
  root: { sphere: { center: [0, 0, 0], radius: 500 }, material: 'rock' },
};

const canvas = document.getElementById('c');

main().catch((e) => {
  const err = document.getElementById('err');
  err.textContent = e.message;
  err.hidden = false;
  err.style.display = 'grid';
  canvas.style.display = 'none';
  throw e;
});

async function main() {
  // The page is one directory below public/, like the editor.
  const gpu = await ASContext.create({
    computeUrl: '../gen/antisphere-raycast.wgsl',
    blitUrl:    '../gen/blit.wgsl',
    overlapUrl: '../gen/overlap.wgsl',
  });
  const scene = gpu.createScene(PLANETOID);
  const view = gpu.createRenderer(canvas, { scene, camera: new ASCamera() });
  view.useSceneCamera();
  gpu.start();
}
