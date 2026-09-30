// physlab: somewhere to try physics against an antisphere scene, and so to
// exercise the GPU overlap queries. For now: a world of objects, a camera
// riding on one of them, and flight controls for any of them.
//
//   left / right arrows   which object the controls fly
//   up / down arrows      what the camera looks at; its own object means
//                         "look forward"
//
// (flight-input.js has the rest of the keys.)
//
// Distances are in meters.

import { ASContext } from '../as-context.js';
import '../as-renderer.js';           // registers the renderer ASContext.createRenderer makes
import { World, WorldObject } from './world.js';
import { AttachedCamera } from './camera.js';
import { FlightControl, levelOrientation } from './flight.js';
import { attachFlightInput } from './flight-input.js';
import { fromBasis } from './quat.js';

// Not objects (yet): what the objects are made of, and what lights them.
const SURROUNDINGS = {
  materials: {
    // Sphere surface coordinates are longitude and latitude in radians,
    // times scale: 50 makes squares of 0.02 rad, about 10 m here.
    rock: { albedo: [0.46, 0.43, 0.39], albedo2: [0.31, 0.29, 0.27],
            pattern: 'checker', scale: 50 },
    hull: { albedo: [0.85, 0.85, 0.88] },
    nose: { albedo: [0.80, 0.15, 0.10] },
  },
  // A distant sun. Light falls off as color / (1 + d^2), so at about 7 km
  // it takes a color in the tens of millions to light the ground.
  lights: [{ pos: [3000, -4000, 5000], color: [3.6e7, 3.3e7, 2.9e7] }],
};

const RADIUS = 500;

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };

// A rocket in its own coordinates, pointing along +Y: a body 2 m across
// and 8 m long (y from -4 to 4), and a cone capping it from y = 4 to its
// tip at y = 6. The cone is double, so a slab keeps just the cap; so does
// the body's cylinder, which is endless otherwise.
const ROCKET = {
  union: [
    { intersect: [
      { cylinder: { center: [0, 0, 0], axis: [0, 1, 0], radius: 1 }, material: 'hull' },
      { slab: { center: [0, 0, 0], axis: [0, 1, 0], thickness: 8 }, material: 'hull' },
    ] },
    { intersect: [
      { cone: { apex: [0, 6, 0], axis: [0, 1, 0], slope: 0.5 }, material: 'nose' },
      { slab: { center: [0, 5, 0], axis: [0, 1, 0], thickness: 2 }, material: 'nose' },
    ] },
  ],
};

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

  // The rocket stands on its tail on the ground, about 40 m east of the
  // point below the mount: its +Y straight up, its +Z east.
  const east = [1, 0, 0];
  const standAt = unit(up.map((v, i) => v + (40 / RADIUS) * east[i]));
  const rz = unit(east.map((v, i) => v - east.reduce((s, e, j) => s + e * standAt[j], 0) * standAt[i]));
  world.add(new WorldObject('rocket', {
    position: standAt.map((v) => v * (RADIUS + 4)),        // its base, y = -4, on the ground
    orientation: fromBasis(cross(standAt, rz), standAt, rz),
    geometry: ROCKET,
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
  const { world, mount } = buildWorld();
  const scene = gpu.createScene(world.sceneSpec(SURROUNDINGS));
  // Looking forward from the mount to start, pitched down a little so the
  // ground is in view.
  const camera = new AttachedCamera(mount, { pitch: -0.2 });
  const flight = new FlightControl(camera);

  // The arrows step through the world's objects: left/right for what the
  // controls fly, up/down for what the camera looks at.
  const status = document.getElementById('status');
  const showStatus = () => {
    const looking = world.objects.find((o) => o.position === camera.target);
    status.textContent = `flying: ${flight.object.name} · camera on ${camera.object.name}, ` +
      (looking ? `looking at ${looking.name}` : 'looking forward');
  };
  const step = (list, current, by) => list[(list.indexOf(current) + by + list.length) % list.length];
  const flyNext = (by) => { flight.attach(step(world.objects, flight.object, by)); showStatus(); };
  const lookNext = (by) => {
    const current = world.objects.find((o) => o.position === camera.target) ?? camera.object;
    const next = step(world.objects, current, by);
    camera.target = next === camera.object ? null : next.position;   // held by reference
    showStatus();
  };
  attachFlightInput(canvas, flight, { commands: {
    ArrowLeft: () => flyNext(-1), ArrowRight: () => flyNext(1),
    ArrowUp: () => lookNext(1), ArrowDown: () => lookNext(-1),
  } });
  showStatus();

  const view = gpu.createRenderer(canvas, { scene, camera });
  // Before each frame is drawn, time moves on: dt is seconds since the last
  // frame, clamped by ASContext so a stall doesn't become a leap. If
  // anything with geometry moved, the scene follows (a full rebuild, for
  // now; see DESIGN.md on moving nodes in place).
  gpu.onFrame((dt) => {
    flight.update(dt);
    world.update(dt);
    if (world.geometryMoved()) scene.update(world.sceneSpec(SURROUNDINGS));
  });
  gpu.start();

  window.physlab = { world, camera, flight, scene, view, gpu };
}
