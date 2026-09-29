// physlab: somewhere to try physics against an antisphere scene, and so to
// exercise the GPU overlap queries. For now it renders a world of objects
// through a camera riding on one of them.
//
// Distances are in meters.

import { ASContext } from '../as-context.js';
import '../as-renderer.js';           // registers the renderer ASContext.createRenderer makes
import { World, WorldObject } from './world.js';
import { AttachedCamera } from './camera.js';
import { fromAxisAngle, fromBasis, multiply } from './quat.js';

// Not objects (yet): what the objects are made of, and what lights them.
const SURROUNDINGS = {
  materials: {
    // Sphere surface coordinates are longitude and latitude in radians,
    // times scale: 50 makes squares of 0.02 rad, about 10 m here.
    rock: { albedo: [0.46, 0.43, 0.39], albedo2: [0.31, 0.29, 0.27],
            pattern: 'checker', scale: 50 },
  },
  // A distant sun. Light falls off as color / (1 + d^2), so at about 7 km
  // it takes a color in the tens of millions to light the ground.
  lights: [{ pos: [3000, -4000, 5000], color: [3.6e7, 3.3e7, 2.9e7] }],
};

const RADIUS = 500;

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function buildWorld() {
  const world = new World();

  // A small, very dense planetoid, 1 km across, at the origin.
  const planetoid = world.add(new WorldObject('planetoid', {
    geometry: { sphere: { center: [0, 0, 0], radius: RADIUS }, material: 'rock' },
  }));

  // Something to carry the camera, with no geometry of its own: 20 m up,
  // 10 degrees off the north pole (the checker's longitudes pinch at the
  // pole). Its +Z points straight up from the ground, its +Y east, and it
  // leans forward a little so the ground is in view.
  const lat = (80 * Math.PI) / 180;
  const up = [0, -Math.cos(lat), Math.sin(lat)];
  const east = [1, 0, 0];
  const standing = fromBasis(cross(east, up), east, up);            // x = y cross z
  const mount = world.add(new WorldObject('mount', {
    position: up.map((v) => v * (RADIUS + 20)),
    orientation: multiply(standing, fromAxisAngle([1, 0, 0], -0.2)),   // lean first, then stand
  }));

  return { world, planetoid, mount };
}

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
  const { world, planetoid, mount } = buildWorld();
  const scene = gpu.createScene(world.sceneSpec(SURROUNDINGS));
  // 'forward' looks along the mount's +Y; 'lookAt' looks at the target,
  // here the planetoid's centre.
  const camera = new AttachedCamera(mount, { mode: 'forward', target: planetoid.position });
  const view = gpu.createRenderer(canvas, { scene, camera });
  gpu.start();

  // No controls yet; from the console, e.g. physlab.camera.mode = 'lookAt'.
  window.physlab = { world, camera, scene, view, gpu };
}
