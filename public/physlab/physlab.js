// physlab: somewhere to try physics against an antisphere scene, and so to
// exercise the GPU overlap queries. For now: a world of objects, a camera
// riding on one of them, and flight controls for any of them.
//
//   left / right arrows   which object the controls fly
//   up / down arrows      what the camera looks at; its own object means
//                         "look forward"
//   space                 fire an octahedron the way the camera looks
//   P (held)              disintegrate: a hole where the camera looks,
//                         growing while P is held
//
// (flight-input.js has the rest of the keys.)
//
// The scenery comes from a scene file, ?scene=<file> in public/scenes/
// (physlab-flat.json by default): its root is the ground, its materials
// and lights light it, its gravity (scene-format.md) pulls, and its spawn
// point is where the camera, the rocket and the rest are put.
//
// Distances are in meters.

import { ASContext } from '../as-context.js';
import '../as-renderer.js';           // registers the renderer ASContext.createRenderer makes
import { World, WorldObject } from './world.js';
import { gravityOf } from './gravity.js';
import { loadImports, parseGravity, parseSpawn, resolveImports } from '../antisphere-scene.js';
import { AttachedCamera } from './camera.js';
import { FlightControl, levelOrientation } from './flight.js';
import { attachFlightInput } from './flight-input.js';
import { fromBasis, fromAxisAngle, fromTo, multiply, rotate } from './quat.js';
import { PhysicsWorld } from './physics-world.js';
import { octahedron, octahedronBody } from './shapes.js';
import { loadText, loadBytes, checkShader } from '../gpu-setup.js';
import { FrameProfiler } from './profiler.js';

// What physlab's own things are made of, where the scene doesn't say.
const BODY_MATERIALS = {
  hull: { albedo: [0.85, 0.85, 0.88] },
  nose: { albedo: [0.80, 0.15, 0.10] },
  ball: { albedo: [0.20, 0.45, 0.80] },
  capsule: { albedo: [0.90, 0.70, 0.20] },
  octahedron: { albedo: [0.35, 0.75, 0.45] },
};

const DEFAULT_SCENE = 'physlab-flat.json';
const SCENES = ['physlab-flat.json', 'physlab-planetoid.json'];

// Thrust while flying a simulated body, m/s^2: more than gravity, so a
// rocket pointed up climbs.
const THRUST = 15;
// What Space fires: octahedra 1.5 m from centre to corner (so 2.1 m
// along an edge), and as heavy as a capsule.
const FIRED = octahedron(1.5, 'octahedron');
const FIRED_BODY = octahedronBody(1.5, { mass: 150 });
// Their speed, m/s, and how far ahead of the eye each one's centre
// starts (beyond the reach of the body the camera rides on, if any).
const FIRE_SPEED = 25;
const FIRE_AHEAD = 3;
// The disintegration ray's hole: its radius when it appears, how fast it
// grows while P is held (m/s), and the most it grows to, in meters.
const HOLE_START = 0.1;
const HOLE_GROWTH = 1.0;
const HOLE_MAX = 20;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };

// A rocket in its own coordinates, pointing along +Y: a body 2 m across
// and 8 m long (y from -4 to 4), and a cone capping it from y = 4 to its
// tip at y = 6. The cone is double, so a slab keeps just the cap; so does
// the body's cylinder, which is endless otherwise.
// A capsule along +Y: a cylinder 3 m long capped with half-spheres,
// 0.6 m in radius. All coaxial, as a two-particle body needs.
const CAPSULE = {
  union: [
    { intersect: [
      { cylinder: { center: [0, 0, 0], axis: [0, 1, 0], radius: 0.6 }, material: 'capsule' },
      { slab: { center: [0, 0, 0], axis: [0, 1, 0], thickness: 3 }, material: 'capsule' },
    ] },
    { sphere: { center: [0, 1.5, 0], radius: 0.6 }, material: 'capsule' },
    { sphere: { center: [0, -1.5, 0], radius: 0.6 }, material: 'capsule' },
  ],
};

const CAPSULE_BODY = { mass: 150, centre: 0, inertia: 4.2 * 4.2 / 12 + 0.6 * 0.6 / 4, radius: 2.1, friction: 0.5 };

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

// Where things go near the spawn point: on the ground `ahead` metres along
// its facing and `right` metres to its right, and `height` metres above a
// point. On a planet (central gravity) the ground curves, so a point is
// carried round the sphere through the spawn point; elsewhere it is flat.
function placer(gravity, spawn) {
  const g0 = spawn.at;
  const up0 = gravity.up(g0);
  const level = (v, up) => unit(v.map((x, i) => x - dot(v, up) * up[i]));
  const forward = level(spawn.facing, up0);
  const right = cross(forward, up0);
  const ground = (ahead, side) => {
    const p = g0.map((v, i) => v + ahead * forward[i] + side * right[i]);
    if (gravity.kind !== 'central') return p;
    const c = gravity.center, r = Math.hypot(...g0.map((v, i) => v - c[i]));
    const d = unit(p.map((v, i) => v - c[i]));
    return c.map((v, i) => v + r * d[i]);
  };
  const above = (p, height) => {
    const up = gravity.up(p);
    return p.map((v, i) => v + height * up[i]);
  };
  // Standing at p: +Y straight up, +Z the facing, carried level there.
  const standing = (p) => {
    const y = gravity.up(p), z = level(forward, y);
    return fromBasis(cross(y, z), y, z);
  };
  return { up0, forward, ground, above, standing };
}

function buildWorld(ground, gravity, spawn) {
  const world = new World();
  const at = placer(gravity, spawn);

  // The scene's own geometry: the ground, and whatever else it has.
  world.add(new WorldObject('scenery', { geometry: ground }));

  // Something to carry the camera, with no geometry of its own: 20 m above
  // the spawn point, upright and facing as it says.
  const position = at.above(spawn.at, 20);
  const mount = world.add(new WorldObject('mount', {
    position,
    orientation: levelOrientation(gravity.up(position), at.forward),
  }));

  // The rocket stands on its tail on the ground 40 m ahead: its +Y
  // straight up, its +Z the facing.
  const pad = at.ground(40, 0);
  const rocket = world.add(new WorldObject('rocket', {
    position: at.above(pad, 4),                         // its base, y = -4, on the ground
    orientation: at.standing(pad),
    geometry: ROCKET,
    // Mostly a cylinder 8 m long and 1 m round, with a little cone on top:
    // centre of mass a little above the middle, inertia across it about
    // L^2 / 12 + r^2 / 4 per unit mass.
    body: { mass: 2000, centre: 0.35, inertia: 5.6, radius: 6.1, friction: 0.6 },
  }));

  // Things to drop near it, from 30 m and 25 m up.
  const near = (ahead, side, height) => at.above(at.ground(40 + ahead, side), height);
  world.add(new WorldObject('ball', {
    position: near(6, 4, 30),
    orientation: at.standing(pad),
    geometry: { sphere: { center: [0, 0, 0], radius: 1.5 }, material: 'ball' },
    body: { mass: 300, centre: 0, inertia: 0.4 * 1.5 * 1.5, radius: 1.5, friction: 0.5 },
  }));
  world.add(new WorldObject('capsule', {
    position: near(-5, -3, 25),
    orientation: multiply(at.standing(pad), fromAxisAngle([0, 0, 1], 1.0)),      // tipped over
    geometry: CAPSULE,
    body: CAPSULE_BODY,
  }));

  return { world, mount, rocket };
}

// The held keys as an acceleration along the flown object's own axes:
// forward its +Y, right its +X, up its +Z.
function thrustOf(flight) {
  const held = (a) => (flight.held.has(a) ? 1 : 0);
  const { x, y, z } = flight.object.axes();
  const f = held('forward') - held('back'), r = held('right') - held('left'), u = held('up') - held('down');
  const g = THRUST * (flight.held.has('fast') ? 2 : 1);
  return [0, 1, 2].map((i) => g * (f * y[i] + r * x[i] + u * z[i]));
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
  });
  // The scene file, its imports folded in.
  const sceneName = new URLSearchParams(location.search).get('scene') ?? DEFAULT_SCENE;
  const scenePath = `../scenes/${sceneName}`;
  const readJson = async (path) => JSON.parse(await loadText(path));
  const raw = await readJson(scenePath);
  const imports = await loadImports(raw, readJson, {
    from: scenePath,
    readBytes: loadBytes,
  });
  const file = resolveImports(raw, imports, { from: scenePath });
  const gravity = gravityOf(parseGravity(file.gravity));
  const spawn = parseSpawn(file.spawn) ?? { at: [0, 0, 0], facing: [1, 0, 0] };
  // Not world objects: what things are made of, what lights them, and the
  // scene's named subtrees, which its ground may use.
  const surroundings = {
    materials: { ...BODY_MATERIALS, ...file.materials },
    lights: file.lights ?? [],
    objects: file.objects ?? {},
  };
  const { world, mount, rocket } = buildWorld(file.root, gravity, spawn);

  // The simulation, centred on the rocket's pad.
  const physicsUrl = '../gen/physics-2pt.wgsl';
  const physicsCode = await loadText(physicsUrl);
  const physicsModule = gpu.device.createShaderModule({ code: physicsCode });
  if (!(await checkShader(physicsModule, 'physics shader', physicsCode))) {
    throw new Error('physics shader failed to compile. See the console for details.');
  }
  const physics = new PhysicsWorld(gpu.device, physicsModule, world, {
    materials: surroundings.materials,
    objects: surroundings.objects,
    origin: rocket.position,
    gravity,
  });
  // The scene is a group of the world's objects, each body's
  // bounds padded by how far it may move before the next compile. Its
  // overlaps are the broad phase: the only pairs physics tests for contact.
  const sceneSpec = () => world.sceneSpec(surroundings, { bounds: (o) => physics.boundsOf(o) });
  const scene = gpu.createScene(sceneSpec());
  physics.setCandidates(world.overlappingPairs(scene.overlaps));
  // Looking forward from the mount to start, pitched down a little so the
  // ground is in view.
  const camera = new AttachedCamera(mount, { pitch: -0.2 });
  const flight = new FlightControl(camera, { up: (p) => gravity.up(p) });

  // Which scene, and the others to switch to.
  const scenes = document.getElementById('scenes');
  scenes.textContent = `scene: ${sceneName}`;
  for (const other of SCENES.filter((n) => n !== sceneName)) {
    const link = document.createElement('a');
    link.href = `?scene=${encodeURIComponent(other)}`;
    link.textContent = other;
    scenes.append(' · ', link);
  }

  // The arrows step through the world's objects: left/right for what the
  // controls fly, up/down for what the camera looks at.
  const status = document.getElementById('status');
  const showStatus = () => {
    const looking = world.objects.find((o) => o.position === camera.target);
    const how = physics.simulates(flight.object) ? ' (thrust)' : '';
    status.textContent = `flying: ${flight.object.name}${how} · camera on ${camera.object.name}, ` +
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
  // Space fires another octahedron: pointing, and moving at FIRE_SPEED, the
  // way the camera looks, from just ahead of it.
  let fired = 0;
  const fire = () => {
    const { eye, forward } = camera.basis();
    const ahead = FIRE_AHEAD + (camera.object.body ? camera.object.body.radius : 0);
    const shot = world.add(new WorldObject(`octahedron-${++fired}`, {
      position: eye.map((v, i) => v + ahead * forward[i]),
      orientation: fromTo([0, 1, 0], forward),
      geometry: FIRED,
      body: FIRED_BODY,
    }));
    physics.add(shot, forward.map((v) => FIRE_SPEED * v));
  };
  // P disintegrates. A ray along the camera's look finds what it hits,
  // and that object is intersected with a complemented sphere centred
  // there, in the object's own coordinates so it moves with it: a hole,
  // which grows in the frame loop while P is held. An object keeps its
  // original geometry and its holes, and is given the two together. A
  // hole names no material, so its walls show whatever it cut into
  // (scene-format.md); `material: null` would make the whole object
  // vacuum, since in an intersection the hole's node is what claims the
  // rest of it.
  const carved = new Map();                 // object -> { base, holes: [{ center, radius }] }
  const carve = (object) => {
    const { base, holes } = carved.get(object);
    object.setGeometry({
      intersect: [
        base,
        ...holes.map(({ center, radius }) => ({
          sphere: { center, radius },
          complement: true,
        })),
      ],
    });
    physics.reshape(object);
  };
  let beam = null;                          // { hole } while P is held
  const beamOn = async () => {
    const b = { hole: null };
    beam = b;
    const { eye, forward } = camera.basis();
    // Past the body the camera rides on, if any, as for firing.
    const tMin = camera.object.body ? camera.object.body.radius : 1e-3;
    // The scene is only replaced in the frame loop, so these are the nodes
    // the ray is about to be cast through.
    const provenance = scene.provenance;
    const { node, t0 } = await scene.castRays([{ origin: eye, direction: forward, tMin, tMax: 5000 }]);
    const object = node[0] ? world.objects.find((o) => o.name === provenance[node[0]]?.owner) : null;
    if (!object) return;                    // into the sky
    const hit = eye.map((v, i) => v + t0[0] * forward[i]);
    const [x, y, z, w] = object.orientation;
    const center = rotate([-x, -y, -z, w], hit.map((v, i) => v - object.position[i]));
    if (!carved.has(object)) carved.set(object, { base: object.geometry, holes: [] });
    b.hole = { object, center, radius: HOLE_START };
    carved.get(object).holes.push(b.hole);
    carve(object);
  };
  const beamOff = () => { beam = null; };

  attachFlightInput(canvas, flight, { commands: {
    ArrowLeft: () => flyNext(-1),
    ArrowRight: () => flyNext(1),
    ArrowUp: () => lookNext(1),
    ArrowDown: () => lookNext(-1),
    Space: fire,
    KeyP: { press: beamOn, release: beamOff },
  } });
  showStatus();

  const view = gpu.createRenderer(canvas, { scene, camera });
  // The blit isn't timed: its work is a single full-screen triangle, and on
  // macOS its timestamps took in waiting for the screen's image (40 ms, in
  // 17 ms frames), which only misled.
  const profiler = new FrameProfiler(gpu.device, gpu.canTimestamp, ['render', 'physics'],
                                     document.getElementById('prof'));

  // The frame loop, run here rather than by ASContext.start() so the
  // profiler can time the render passes as they're encoded. Each frame:
  // time moves on by dt, seconds since the last frame, clamped so a stall
  // doesn't become a leap; the physics steps; if anything with geometry
  // moved, the scene follows (a full rebuild, for now; see DESIGN.md on
  // moving nodes in place), and with it which pairs physics tests; then
  // the view is drawn.
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const frameMs = now - last;
    const dt = Math.min(0.1, frameMs / 1000);
    last = now;
    const cpuStart = performance.now();
    profiler.begin();

    // Flying a simulated body is thrust along its own axes; anything else
    // the controls move directly.
    for (const o of physics.bodies) {
      physics.setThrust(o, o === flight.object ? thrustOf(flight) : [0, 0, 0]);
    }
    if (physics.simulates(flight.object)) flight.pendingYaw = 0;   // turning a body needs a torque; not yet
    else flight.update(dt);
    world.update(dt);
    const hole = beam?.hole;
    if (hole && hole.radius < HOLE_MAX) {
      hole.radius = Math.min(HOLE_MAX, hole.radius + HOLE_GROWTH * dt);
      carve(hole.object);
    }
    const substeps = physics.update(dt, profiler.pass('physics'));
    if (substeps === 0) profiler.skipped('physics');
    if (world.geometryMoved()) {
      scene.update(sceneSpec());
      physics.setCandidates(world.overlappingPairs(scene.overlaps));
    }

    const enc = gpu.device.createCommandEncoder();
    if (!view.encode(enc, { computeTimestamps: profiler.pass('render') })) profiler.skipped('render');
    profiler.resolve(enc);
    gpu.device.queue.submit([enc.finish()]);

    profiler.extra = {
      bodies: String(physics.bodies.length),
      'pairs (paths)': String(physics.pairCount),
      'substeps/frame': String(substeps),
      pixels: `${(view.pixelCount / 1e6).toFixed(2)} M`,
    };
    profiler.end(frameMs, performance.now() - cpuStart);
  }
  requestAnimationFrame(frame);

  window.physlab = { world, camera, flight, scene, view, gpu, physics, profiler, carved };
}
