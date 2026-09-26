// The editor page: wiring between the GPU, the document, the panel and the
// four views.
//
//   ASScene          GPU resources, shared by every pane
//   SceneDocument    the authored scene, selection and undo
//   editor-panel.js  a view of the document
//   editor.js        this: panes, loading, commands, shortcuts
//
// Scene files are read from SCENE_DIR, relative to this page; ?scene=name
// opens one at startup, and Revert reloads the current one from there.

import { ASContext } from '../as-context.js';
import { DEBUG_VIEWS } from '../as-renderer.js';
import { ASCamera, attachCameraControls } from '../as-camera.js';
import { SceneDocument } from './scene-document.js';
import { createPanel, isTextEntry } from './editor-panel.js';
import { createCommands } from './editor-commands.js';
import { rayThroughPixel, selectionForHit } from './editor-pick.js';

const SCENE_DIR = '../scenes/';

// A starting point for New: shell, floor, one object, one light.
const NEW_SCENE = {
  camera: { target: [0, 0, 0.5], yaw: 0.6, pitch: 0.35, distance: 6 },
  materials: {
    sky:   { kind: 'unlit', albedo: [0.09, 0.11, 0.15] },
    floor: { albedo: [0.33, 0.35, 0.38], albedo2: [0.15, 0.16, 0.19],
             pattern: 'checker', scale: 1 },
    clay:  { albedo: [0.72, 0.55, 0.45] },
  },
  lights: [{ pos: [3, -4, 5], color: [40, 36, 30] }],
  objects: {},
  root: {
    plane: { normal: [0, 0, 1], offset: 0 }, material: 'floor',
    outside: {
      sphere: { radius: 40, complement: true },
      material: 'sky',
      outside: {
        sphere: { center: [0, 0, 0.5], radius: 0.5 }, material: 'clay',
      },
    },
  },
};

const el = (id) => document.getElementById(id);

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

async function fetchScene(name) {
  const res = await fetch(SCENE_DIR + name, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${name}: ${res.status} ${res.statusText}`);
  return res.json();
}

// Shortcuts and arrow-key flying are global listeners, so they stand down
// while the user is typing into the panel. Only text entry counts: a slider
// or a checkbox gives focus back once used (see editor-panel.js).
const editingPanel = () =>
  el('panel').contains(document.activeElement) && isTextEntry(document.activeElement);

main().catch((e) => { fail(e.message); throw e; });

async function main() {
  // One device, one set of pipelines, one scene — shared by every pane.
  const gpu = await ASContext.create({
    computeUrl: '../antisphere-raycast.wgsl',
    blitUrl:    '../blit.wgsl',
  });

  let fileName = new URLSearchParams(location.search).get('scene');
  const spec = fileName ? await fetchScene(fileName) : structuredClone(NEW_SCENE);
  fileName ??= 'untitled.json';

  const scene = await gpu.createScene(spec);
  const doc = new SceneDocument(scene, spec, { fileName });

  // -- views -----------------------------------------------------------------

  const panes = [...document.querySelectorAll('.pane')];
  let active = null;

  const views = panes.map((pane, i) => {
    const canvas = pane.querySelector('canvas');
    const camera = new ASCamera();
    const renderer = gpu.createRenderer(canvas, { scene, camera });
    const controls = attachCameraControls(canvas, camera, {
      onNote: note,
      // Only the focused pane responds to keys and the pointer, so arrow keys
      // don't fly all four cameras at once — and none respond mid-edit.
      enabled: () => views[i] === active && !editingPanel(),
      probe: (origin, direction) => scene.traceRay(origin, direction),
    });
    return { pane, renderer, camera, controls, index: i,
             name: pane.querySelector('.tag').textContent };
  });
  active = views[0];

  // The view whose camera the panel's Camera section edits: chosen with the
  // camera glyph in each pane, independently of hover focus.
  let cameraView = views[0];

  // Four viewpoints onto the same geometry. The first follows whatever the
  // scene file declares; the rest are fixed axis views framed on the scene
  // camera's target, so they all look at the same thing.
  function frameViews() {
    const centre = scene.camera?.target ?? [0, 0, 0];
    const far = (scene.camera?.distance ?? 8) * 1.2;
    // The axis views are orthographic: parallel rays are what make a
    // drawing you can measure against, and what stops near geometry from
    // hiding what is behind it.
    const layouts = [
      null,
      { yaw: 0,           pitch: 0,       distance: far, projection: 'orthographic' },
      { yaw: Math.PI / 2, pitch: 0,       distance: far, projection: 'orthographic' },
      { yaw: 0,           pitch: Math.PI / 2 - 1e-3, distance: far, projection: 'orthographic' },
    ];
    views.forEach((v, i) => {
      v.controls.setMode('orbit');
      if (i === 0) { v.camera.setFromSpec(scene.camera ?? { target: centre }); return; }
      v.camera.target = centre.slice();
      v.camera.orthoHeight = null;          // framed from the orbit distance
      Object.assign(v.camera, layouts[i]);
    });
  }
  frameViews();

  // Focus follows the mouse: whichever pane the pointer is over takes keys
  // and camera input, without a click. Not mid-drag, so an orbit that
  // strays across a border keeps its pane, and not while the pointer is
  // locked for mouse-look, when it isn't really anywhere.
  function focus(view) {
    if (active === view) return;
    active.controls.releaseLook();
    active = view;
    for (const v of views) v.pane.classList.toggle('active', v === active);
  }

  function editCamera(view) {
    cameraView = view;
    for (const v of views) v.pane.querySelector('.cam').classList.toggle('editing', v === view);
    el('app').classList.remove('panel-hidden');
    panel.showCamera();
  }

  // -- picking ---------------------------------------------------------------

  // A click selects the object under the cursor, a double click the node
  // itself, and a click on nothing clears the selection. Shift adds to the
  // selection instead of replacing it, and then a click on nothing leaves it
  // alone. A press that moves more than a few pixels is a camera drag, not a
  // click.
  const CLICK_SLOP = 4;

  async function pickAt(view, event, { deep = false, add = false } = {}) {
    if (typeof scene.pick !== 'function' || !scene.provenance) {
      note('picking needs ASScene.pick() and ASScene.provenance', true);
      return;
    }
    const rect = view.pane.querySelector('canvas').getBoundingClientRect();
    const { origin, direction } = rayThroughPixel(view.camera, rect, event.clientX, event.clientY);
    const hit = await scene.pick(origin, direction);
    if (!hit) { if (!add) doc.clearSelection(); return; }
    const target = selectionForHit(scene.provenance, hit.node, { deep });
    if (!target) { note('nothing selectable there'); return; }
    // The scene may have changed during the round trip; a stale hit just
    // fails to select.
    const chosen = add
      ? doc.addToSelection(target.owner, target.path)
      : doc.select(target.owner, target.path);
    if (!chosen) note('that has changed; try again');
  }

  views.forEach((v) => {
    // The glyph sits over the canvas, so its presses must not also reach
    // the pane: no pick, no double-click drill-in.
    const glyph = v.pane.querySelector('.cam');
    glyph.addEventListener('pointerdown', (e) => e.stopPropagation());
    glyph.addEventListener('click', (e) => { e.stopPropagation(); editCamera(v); });

    v.pane.addEventListener('pointerenter', (e) => {
      if (e.buttons || document.pointerLockElement) return;
      focus(v);
    });

    let press = null;
    v.pane.addEventListener('pointerdown', (e) => {
      // Clicking a canvas doesn't move focus, so a field in the panel would
      // stay focused and keep the shortcuts disabled. Let go of it.
      if (el('panel').contains(document.activeElement)) document.activeElement.blur();
      focus(v);
      press = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    });
    v.pane.addEventListener('click', (e) => {
      const start = press;
      press = null;
      if (!start || document.pointerLockElement) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_SLOP) return;
      pickAt(v, e, { deep: e.detail >= 2, add: e.shiftKey });
    });
  });
  views[0].pane.classList.add('active');
  views[0].pane.querySelector('.cam').classList.add('editing');

  // -- files -----------------------------------------------------------------

  const discardOk = (question = 'Discard unsaved changes?') => !doc.dirty || confirm(question);

  // Replace the whole document. A spec that doesn't compile is refused, and
  // the current scene stays as it was.
  function loadSpec(next, name) {
    const result = doc.load(next, name);
    if (!result.ok) { note(`load: ${result.error}`, true); return; }
    frameViews();
    panel.refreshCamera();
    note(`loaded ${name}`);
  }

  async function revert() {
    try {
      const shaders = await gpu.reloadShaders({ force: true });
      if (shaders.error) { note(`reload: ${shaders.error}`, true); return; }
      const result = doc.load(await fetchScene(doc.fileName), doc.fileName);
      if (!result.ok) { note(`reload: ${result.error}`, true); return; }
      note('reloaded');
    } catch (err) {
      note(`reload: ${err.message} (only files in ${SCENE_DIR} can be reloaded)`, true);
    }
  }

  function save() {
    const blob = new Blob([doc.toJSON()], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = doc.fileName;
    link.click();
    URL.revokeObjectURL(link.href);
    doc.markSaved();
    note(`saved ${doc.fileName}`);
  }

  el('panel-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !discardOk()) return;
    try {
      loadSpec(JSON.parse(await file.text()), file.name);
    } catch (err) {
      note(`open: ${err.message}`, true);
    }
  });

  // -- commands ----------------------------------------------------------------

  const commands = createCommands({
    doc, note,
    getActive: () => active,
    extra: {
      new() { if (discardOk()) loadSpec(structuredClone(NEW_SCENE), 'untitled.json'); },
      open() { el('panel-file').click(); },
      save,
      revert() {
        if (discardOk('Discard unsaved changes and reload from the server?')) revert();
      },
      'reset-camera'() {
        cameraView.renderer.useSceneCamera();
        cameraView.controls.setMode('orbit');
        panel.refreshCamera();
      },
    },
  });

  function run(name, argument) {
    const command = commands[name];
    if (command) command(argument);
    else note(`unknown command: ${name}`, true);
  }

  const panel = createPanel(el('panel'), {
    doc, scene,
    getActive: () => active,
    getCameraView: () => cameraView,
    command: run,
  });

  // -- shortcuts ---------------------------------------------------------------

  window.addEventListener('keydown', (e) => {
    if (editingPanel()) return;
    const key = e.key.toLowerCase();
    const mod = e.metaKey || e.ctrlKey;

    // Document shortcuts, with the usual modifiers. Handled before the
    // single-key ones so Cmd-D isn't also D for debug.
    if (mod) {
      const byKey = { z: e.shiftKey ? 'redo' : 'undo', y: 'redo', d: 'duplicate', s: 'save' };
      if (byKey[key]) { e.preventDefault(); run(byKey[key]); }
      return;
    }
    if (key === 'delete' || key === 'backspace') { e.preventDefault(); run('delete'); return; }
    if (key === 'escape') { run('deselect'); return; }

    const v = active;
    switch (key) {
      case 'm': note(`${v.index}: camera ${v.controls.cycleMode()}`); break;
      case 's':
        v.renderer.shadows = !v.renderer.shadows;
        note(`${v.index}: shadows ${v.renderer.shadows ? 'on' : 'off'}`);
        break;
      case 'd': note(`${v.index}: ${v.renderer.cycleDebugView()}`); break;
      case 'b':
        note(`${v.index}: ${v.renderer.setDirectOut(!v.renderer.directOut) ? 'direct' : 'blit'}`);
        break;
      case 'c': v.renderer.useSceneCamera(); note(`${v.index}: camera reset`); break;
      case 'r': run('revert'); break;
      case 'p': el('app').classList.toggle('panel-hidden'); break;
      case '[': case ']': {
        const step = e.key === ']' ? 0.1 : -0.1;
        const s = v.renderer.setRenderScale(v.renderer.renderScale + step);
        note(`${v.index}: scale ${s.toFixed(2)}`);
        break;
      }
      default: return;
    }
    // Shortcuts act on the hovered pane, which may be the one being edited.
    panel.refreshCamera();
  });

  window.addEventListener('beforeunload', (e) => {
    if (doc.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // -- frame loop --------------------------------------------------------------

  // Held-key movement and walk-mode gravity, for the focused pane only.
  gpu.onFrame((dt) => { for (const v of views) v.controls.update(dt); });

  let frames = 0, tPrev = performance.now();
  gpu.onFrame(() => {
    frames++;
    const now = performance.now();
    if (now - tPrev < 500) return;
    const fps = Math.round((frames * 1000) / (now - tPrev));
    frames = 0; tPrev = now;
    el('stat').textContent =
      `${scene.nodes.length} nodes · ${scene.lights.length} lights · ` +
      `${views.length} views · ${fps} fps`;
  });

  gpu.start();

  // Handy from the console while building the editor out.
  Object.assign(window, { gpu, scene, doc, views, panel, commands, DEBUG_VIEWS });
}
