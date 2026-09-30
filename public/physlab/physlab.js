// physlab: somewhere to try physics against an antisphere scene, and so to
// exercise the GPU overlap queries. For now it renders a world of objects
// through a camera riding on one of them.
//
// Distances are in meters.

import { ASContext } from '../as-context.js';
import '../as-renderer.js';           // registers the renderer ASContext.createRenderer makes
import { World, WorldObject } from './world.js';
import { AttachedCamera } from './camera.js';
import { FlightControl, levelOrientation } from './flight.js';
import { attachFlightInput } from './flight-input.js';

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

function buildWorld() {
  const world = new World();

  // A small, very dense planetoid, 1 km across, at the origin.
  const planetoid = world.add(new WorldObject('planetoid', {
    geometry: { sphere: { center: [0, 0, 0], radius: RADIUS }, material: 'rock' },
  }));

  // Something to carry the camera, with no geometry of its own: 20 m up,
  // 10 degrees off the north pole (the checker's longitudes pinch at the
  // pole), upright - its +Z straight away from the planet - and facing east.
  const lat = (80 * Math.PI) / 180;
  const up = [0, -Math.cos(lat), Math.sin(lat)];
  const position = up.map((v) => v * (RADIUS + 20));
  const mount = world.add(new WorldObject('mount', {
    position,
    orientation: levelOrientation(position, [1, 0, 0]),
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
  // 'forward' looks along the mount's +Y, pitched down a little so the
  // ground is in view; 'lookAt' looks at the target, here the planetoid's
  // centre. V switches.
  const camera = new AttachedCamera(mount, { mode: 'forward', target: planetoid.position, pitch: -0.2 });
  const flight = new FlightControl(camera);
  mount.behaviour = (self, dt) => flight.update(dt);
  attachFlightInput(canvas, flight);
  const view = gpu.createRenderer(canvas, { scene, camera });
  // Before each frame is drawn, time moves on: dt is seconds since the last
  // frame, clamped by ASContext so a stall doesn't become a leap.
  gpu.onFrame((dt) => world.update(dt));
  gpu.start();

  window.physlab = { world, camera, flight, scene, view, gpu };
}
