// The animation viewer: a model with a skeleton on a floor, posed by its
// clips - picked from a list, played, or scrubbed through - recompiled every
// frame that its pose changes (stage.js says what is shown).
//
//   anim-viewer/anim-viewer.html
//   anim-viewer/anim-viewer.html?model=parts/quaternius/mannequin.json
//       &clips=anim/quaternius/ual.json
//       &materials=parts/quaternius/mannequin-materials.json
//
//   model      a model: one with a skeleton (tools/import-model.mjs
//              --skeleton), or any other, shown at rest
//   clips      its clips (tools/import-animations.mjs); none, no clips
//   materials  material libraries for it, after lib/materials.json, comma
//              separated (import-model's --material-template writes one)
//   pose       how a pose is shown: "coefficients" (the default, for a
//              model of spheres and spheroids) - the stage compiled once,
//              the model's shapes grafted in wherever its clips take it
//              (movers.js), each pose only their quadrics rewritten - or
//              "recompile", every pose compiled afresh (stage.js)
//
// The panel is uiulator markup (../vendor/uiulator.js, loaded by the page
// before this), shown from one object, `panel` below.
//
// Names are files under scenes/; full URLs load from anywhere that allows
// it; .gz is unzipped. With no parameters it opens on the mannequin. A
// clip or material that isn't there is listed under Warnings, and the
// viewer plays on: at rest, or magenta.

import { ASContext } from '../as-context.js';
import '../as-renderer.js';                        // registers ASRenderer
import { ASCamera, attachCameraControls } from '../as-camera.js';
import { FrameProfiler } from '../frame-profiler.js';
import { loadText, loadBytes } from '../load.js';
import { loadReferences, compileScene, isGzip, gunzip } from '../antisphere-scene.js';
import { stageSpec, STAGE_FILE, chainOf, chainSpec, chainPrims, reachOf, graftedStage } from './stage.js';

const SCENE_DIR = '../scenes/';
const MANNEQUIN = {
  model: 'parts/quaternius/mannequin.json',
  clips: 'anim/quaternius/ual.json',
  materials: 'parts/quaternius/mannequin-materials.json',
};
const STEP = 1 / 30;                               // , and . step this far
const REST = '(rest)';                             // the clip list's "no clip"

const el = (id) => document.getElementById(id);
const isURL = (name) => /^[a-z][a-z0-9+.-]*:\/\//i.test(name);
const located = (name) => (isURL(name) ? name : SCENE_DIR + name);

function fail(msg) {
  el('err').style.display = 'grid';
  el('err').textContent = msg;
  el('app').style.display = 'none';
}

let noteTimer = 0;
function note(text, bad) {
  el('note').textContent = text;
  el('note').style.color = bad ? '#f87171' : '#4ade80';
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { el('note').textContent = ''; }, bad ? 6000 : 1600);
}

// Warnings, each listed once: a pose is recompiled every frame, and would
// say the same thing every time. The panel shows the list.
const warnings = [];
function warn(msg) {
  if (warnings.includes(msg)) return;
  warnings.push(msg);
  console.warn(msg);
}

async function readJSON(url) {
  const text = isGzip(url) ? new TextDecoder().decode(await gunzip(new Uint8Array(await loadBytes(url))))
                           : await loadText(url);
  return JSON.parse(text);
}

main().catch((e) => { fail(e.message); throw e; });

async function main() {
  // The mannequin's clips and materials are the defaults only for the
  // mannequin: another model names its own, or has none.
  const params = new URLSearchParams(location.search);
  const given = params.has('model');
  const names = {
    model: params.get('model') || MANNEQUIN.model,
    clips: params.get('clips') ?? (given ? '' : MANNEQUIN.clips),
    materials: params.get('materials') ?? (given ? '' : MANNEQUIN.materials),
  };

  let model = {};
  try {
    model = await readJSON(located(names.model));
  } catch (error) {
    warn(`cannot load model "${names.model}": ${error.message}`);
  }
  let clips = {};
  if (names.clips && names.clips !== 'none') {
    try {
      const library = await readJSON(located(names.clips));
      clips = library.clips ?? library;
    } catch (error) {
      warn(`cannot load clips "${names.clips}": ${error.message}`);
    }
  }
  const modelRef = `@${names.model}`;
  const materials = names.materials.split(',').map((m) => m.trim()).filter(Boolean).map((m) => `@${m}`);

  // What is shown: the clip (null, at rest), the time in it.
  // A model that won't compile at all is left off: the floor alone.
  const state = { clip: null, t: 0, playing: false, speed: 1, dirty: true, broken: false };
  const spec = () => {
    const stage = stageSpec(model, { modelRef, clips, clip: state.clip, t: state.t, materials, warn });
    if (state.broken) stage.root.outside = undefined;
    return stage;
  };

  // Everything the stage refers to, read once: the model's file, the
  // materials. Each pose compiles against them.
  const gpu = await ASContext.create({ computeUrl: '../gen/antisphere-raycast.wgsl', blitUrl: '../gen/blit.wgsl' });
  const path = SCENE_DIR + STAGE_FILE;
  const first = spec();
  const files = await loadReferences(first, { from: path, readText: loadText, readBytes: loadBytes, warn });
  const compileWarn = (where, msg) => warn(`${where}: ${msg}`);
  let scene;
  try {
    scene = gpu.createScene(first, { files, path, warn: compileWarn });
  } catch (error) {
    warn(`${names.model}: ${error.message}`);
    state.broken = true;
    scene = gpu.createScene(spec(), { files, path, warn: compileWarn });
  }
  state.dirty = false;

  // Posing by coefficients: the stage compiled once, the model's shapes
  // grafted into it as a chain wherever its clips may take it - above the
  // floor and, for a swimmer, below it too - and each pose writing their
  // quadrics into every copy. Without a chain (a mesh part, say), by
  // recompiling.
  const chain = state.broken ? null : chainOf(model, { warn });
  const reach = chain ? reachOf(model, chain, clips) : null;
  if (chain) {
    // The chain's materials, loaded along with the stage's.
    Object.assign(files, await loadReferences(chainSpec(model, chain, { materials }), { from: path, readText: loadText, readBytes: loadBytes, warn }));
  }
  const posing = { mode: 'recompile', nodes: null, rest: null, copies: 0 };
  function poseBy(mode) {
    if (mode === 'coefficients' && chain) {
      const compile = (stage) => compileScene(stage, { files, path, warn: compileWarn });
      const grafted = graftedStage(model, chain, compile, { materials, reach });
      if (!grafted) {
        warn('the chain did not compile as a plain chain: posing by recompiling');
        mode = 'recompile';
      } else {
        scene.load(grafted.built);
        posing.nodes = grafted.nodes;
        posing.rest = grafted.rest;
        posing.copies = grafted.copies.length;
      }
    }
    posing.mode = mode === 'coefficients' && chain ? 'coefficients' : 'recompile';
    if (posing.mode === 'recompile') scene.update(spec(), { warn: compileWarn });
    state.dirty = true;
  }
  if (chain) poseBy(params.get('pose') ?? 'coefficients');
  else if (params.get('pose') === 'coefficients') warn('pose=coefficients: the model isn\'t all spheres and spheroids, so it is posed by recompiling');

  /** Show the current pose: its quadrics written, or the stage recompiled. */
  function pose() {
    if (posing.mode === 'coefficients') {
      const prims = chainPrims(model, chain, posing.rest, { clips, clip: state.clip, t: state.t, warn });
      scene.setNodePrims(posing.nodes.flatMap((copies, k) => copies.map((i) => [i, prims[k]])));
    } else {
      scene.update(spec(), { warn: compileWarn });
    }
  }

  const canvas = el('c');
  const camera = new ASCamera();
  const view = gpu.createRenderer(canvas, { scene, camera });
  view.useSceneCamera();
  const controls = attachCameraControls(canvas, camera, {
    onNote: note,
    probe: (origin, direction) => scene.traceRay(origin, direction),
  });

  // -- the panel -------------------------------------------------------------

  const duration = () => (state.clip ? clips[state.clip].duration : 0);

  function setTime(t) {
    const d = duration();
    // Played past its end, a clip starts over: looping or not, the viewer
    // repeats it.
    state.t = d > 0 ? ((t % d) + d) % d : 0;
    state.dirty = true;
  }
  const play = (on) => { state.playing = on && !!state.clip; };

  function chooseClip(name) {
    state.clip = name;
    el('time').max = String(duration() || 1);
    setTime(0);
    play(!!name);
  }

  // What the panel shows and sets (anim-viewer.html's data-shows and
  // data-controls). Setting a clip, a speed or a time goes through these.
  const clipNames = model.skeleton && !state.broken ? Object.keys(clips) : [];
  const panel = {
    modelFile: names.model,
    modelAbout: state.broken ? 'does not compile: left out (see Warnings)'
      : model.skeleton ? `${model.skeleton.bones.length} bones${model.scale ? `, scale ${+model.scale.toPrecision(4)}` : ''}`
      : 'no skeleton: shown as it is',
    clipsFile: names.clips && names.clips !== 'none' ? names.clips : 'no clips',
    hasClips: clipNames.length > 0,
    // Keyed by name, for the list's data-expands (each option's value and
    // text its key).
    clipNames: Object.fromEntries([REST, ...clipNames].map((name) => [name, name])),
    get clip() { return state.clip ?? REST; },
    set clip(name) { chooseClip(clips[name] ? name : null); },
    get hasClip() { return !!state.clip; },
    get speed() { return String(state.speed); },
    set speed(v) { state.speed = +v; },
    get scrub() { return state.t; },
    set scrub(t) { play(false); setTime(t); },
    get playLabel() { return state.playing ? 'pause' : 'play'; },
    get timeReadout() {
      const c = clips[state.clip];
      return c ? `${state.t.toFixed(3)} / ${(+c.duration).toFixed(3)} s${c.loop ? ', loops' : ''}` : '';
    },
    get markers() { return (clips[state.clip]?.markers ?? []).map(({ name, time }) => ({ name, time: `${time.toFixed(2)}s` })); },
    hasChain: !!chain,
    get poseBy() { return posing.mode; },
    get grafted() { return posing.mode === 'coefficients' ? `${posing.copies} cop${posing.copies === 1 ? 'y' : 'ies'} of ${chain.length} shapes, reach ${reach.height.toFixed(2)} × ${(2 * reach.radius).toFixed(2)}` : ''; },
    set poseBy(mode) { poseBy(mode); },
    warnings,
  };
  const uiulator = globalThis.uiulator;
  if (typeof uiulator !== 'function') {
    throw new Error('uiulator.js is not loaded; include it with a <script> before the page module');
  }
  // Two parts: what changes only when something is chosen, and what may
  // change every frame - kept apart so that the clip list isn't redrawn
  // every frame, open or not.
  const chosen = uiulator(panel, [el('sec-model'), el('sec-clip')], { oncontrolchanged: () => live.update() });
  const live = uiulator(panel, [el('sec-play'), el('sec-frame'), el('sec-warnings')]);
  // A <select> is shown before its expanded <option>s exist, so on the very
  // first pass its value has nothing to match. The second pass finds them.
  chosen.update();

  el('play').addEventListener('click', () => { play(!state.playing); el('play').blur(); });
  // Controls that don't take typing give focus back once used, so the
  // keys work again (and a slider let go of follows the clip again).
  el('panel').addEventListener('change', (e) => {
    if (e.target.tagName === 'SELECT' || e.target.type === 'range') e.target.blur();
  });

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
    switch (e.key.toLowerCase()) {
      case ' ': e.preventDefault(); play(!state.playing); break;
      case ',': play(false); setTime(state.t - STEP); break;
      case '.': play(false); setTime(state.t + STEP); break;
      case 's': view.shadows = !view.shadows; note(`shadows ${view.shadows ? 'on' : 'off'}`); break;
      case 'm': note(`camera: ${controls.cycleMode()}`); break;
      case 'c': view.useSceneCamera(); controls.setMode('orbit'); note('camera reset'); break;
      case 'p': el('prof').hidden = !el('prof').hidden; break;
    }
  });

  // -- each frame ------------------------------------------------------------

  // The shared frame loop (ASContext.start()), the profiler timing the
  // compute and blit passes. Each frame: time moves on; the pose, if it
  // changed, is shown (its quadrics written, or the stage recompiled); the
  // panel follows; then the loop draws the view. The pose and the panel
  // are timed on the CPU, apart, among the profiler's figures.
  const profiler = new FrameProfiler(gpu.device, gpu.canTimestamp, ['compute', 'blit'], el('prof'));
  let poseMs = NaN;
  gpu.onFrame((dt) => {
    controls.update(dt);
    if (state.playing) setTime(state.t + dt * state.speed);
    if (state.dirty) {
      state.dirty = false;
      const started = performance.now();
      try {
        pose();
      } catch (error) {
        warn(error.message);                        // the last pose stays
      }
      poseMs = performance.now() - started;
    }
    const panelStart = performance.now();
    live.update();
    const panelMs = performance.now() - panelStart;
    profiler.extra = {
      'pose by': posing.mode,
      'pose (cpu)': Number.isFinite(poseMs) ? `${poseMs.toFixed(2)} ms` : '-',
      'panel (cpu)': `${panelMs.toFixed(2)} ms`,
      nodes: String(scene.nodes.length - 1),
      pixels: `${(view.pixelCount / 1e6).toFixed(2)} M`,
    };
  });
  gpu.start({ profiler });

  Object.assign(window, { gpu, scene, view, camera, controls, model, clips, materials, state, panel, profiler });
}
