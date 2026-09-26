// The editor's side panel: a view of the SceneDocument.
//
// The markup lives in editor.html and says what the panel looks like; this
// file says what it shows and what its controls do. Nothing here builds DOM.
//
// Every model the markup binds to is getters over the live document, so a
// refresh is just uiulator's update(); there's no copy to keep in sync. Every
// setter is a document operation, so everything the panel can change is
// transactional and undoable, and a refused edit simply reads back as the
// old value on the next refresh.
//
// Sections are bound by separate uiulator instances, which is what gives
// them different event modes: lights edit on every tick (a cheap buffer
// write, coalesced into one undo step), while geometry and materials wait
// for a finished edit, since those recompile.
//
// The document announces every change; the panel refreshes the sections a
// change can affect. Buttons name a data-action: the panel handles the few
// that are about its own display and passes the rest to the editor's
// command table.

import { DEBUG_VIEWS } from '../as-renderer.js';
import { CAMERA_MODES } from '../as-camera.js';
import { ROOT, joinPath } from './scene-document.js';
import { SHAPES } from './editor-commands.js';

/**
 * True for controls that consume ordinary keystrokes. The editor's shortcuts
 * and arrow-key flying stand down while one of these has focus, so typing a
 * light's position doesn't fly the camera.
 */
export function isTextEntry(elem) {
  if (!elem) return false;
  if (elem.tagName === 'TEXTAREA' || elem.tagName === 'SELECT') return true;
  return elem.tagName === 'INPUT' &&
    ['text', 'number', 'search', 'email', 'url', 'tel', 'password'].includes(elem.type);
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

// Albedo is a 0..1 colour and maps straight onto <input type=color>.
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const toHex = (rgb) => '#' + rgb.map((c) =>
  Math.round(clamp01(c) * 255).toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

// Enough digits to be exact for anything typed, few enough that 0.1 + 0.2
// doesn't show as 0.30000000000000004.
const tidy = (v) => +(+v).toFixed(6);

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// ---------------------------------------------------------------------------
// Structure outline
//
// The tree is unbounded in depth and uiulator expands markup rather than
// recursing into it, so the tree is flattened into rows, each carrying its
// own tree-drawing prefix. Collapsing is data too: the walk skips the
// children of rows not in `expanded`.
//
// Rows are addressed exactly as the document addresses selections: an owner
// (an object key, or ROOT) and a path of literal spec keys. A row that
// refers to another object selects that object, since that's what someone
// clicking on a name means.
// ---------------------------------------------------------------------------

const v3 = (v) => `(${v.map((x) => +(+x).toFixed(2)).join(', ')})`;

// Almost every shape here is a surface of revolution, so turning one about
// its own axis moves nothing at all - which looks exactly like a broken
// control. This works out when that is about to happen, so the panel can say
// so rather than leaving someone to wonder.
//
// Conservative: anything it cannot see through - a reference, a transform
// deeper in the subtree - counts as "this might move", since a wrong warning
// is worse than a missing one.
const AXIS_FIELDS = { cylinder: 'axis', cone: 'axis', spheroid: 'axis', slab: 'axis',
                      paraboloid: 'axis', hyperboloid: 'axis', quadric: 'axis',
                      plane: 'normal' };

const parallel = (a, b) => {
  const la = Math.hypot(...a), lb = Math.hypot(...b);
  if (la < 1e-12 || lb < 1e-12) return false;
  const dot = (a[0]*b[0] + a[1]*b[1] + a[2]*b[2]) / (la * lb);
  return Math.abs(Math.abs(dot) - 1) < 1e-6;
};

function turnsInvisibly(def, axis, depth = 0) {
  if (!def || depth > 12) return false;
  if (typeof def !== 'object' || Array.isArray(def)) return false;
  if (def.use !== undefined) return false;                  // cannot see inside
  if (depth > 0 && (def.rotate !== undefined || def.scale !== undefined
                    || def.translate !== undefined)) return false;
  for (const op of ['group', 'union', 'intersect', 'difference']) {
    if (Array.isArray(def[op])) {
      return def[op].every((member) => turnsInvisibly(member, axis, depth + 1));
    }
  }
  // A sphere is symmetric about everything; the rest about their own axis.
  let symmetric = def.sphere !== undefined;
  for (const [shape, field] of Object.entries(AXIS_FIELDS)) {
    if (def[shape] !== undefined) {
      symmetric = Array.isArray(def[shape][field]) && parallel(def[shape][field], axis);
    }
  }
  if (!symmetric) return false;
  return ['inside', 'outside'].every((side) =>
    def[side] === undefined || def[side] === null || turnsInvisibly(def[side], axis, depth + 1));
}

function refName(def) {
  if (typeof def === 'string') return def;
  return isObject(def) && typeof def.use === 'string' ? def.use : null;
}

// A row's label, and its children as [display name, path segments, subtree].
function describe(def) {
  if (!def) return { label: '∅', kids: [] };        // no further subdivision
  if (typeof def === 'string') return { label: `→ ${def}`, kids: [] };
  if (!isObject(def)) return { label: '?', kids: [] };

  const extras = [];
  if (def.translate) extras.push(`+${v3(def.translate)}`);
  if (def.rotate) {
    const turn = def.rotate.degrees ?? ((def.rotate.radians ?? 0) * 180 / Math.PI);
    extras.push(`↻${+(+turn).toFixed(1)}°`);
  }
  if (def.scale !== undefined) {
    extras.push(`×${+(+(def.scale.factor ?? def.scale)).toFixed(3)}`);
  }
  if (def.bounds) extras.push('bounded');
  const tail = extras.length ? ` · ${extras.join(' · ')}` : '';

  if (def.use) return { label: `use ${def.use}${tail}`, kids: [] };
  for (const op of ['group', 'union']) {
    if (Array.isArray(def[op])) {
      return {
        label: `${op} (${def[op].length})${tail}`,
        kids: def[op].map((member, i) => [String(i), [op, String(i)], member]),
      };
    }
  }

  let label = '?';
  if (def.sphere) label = `sphere r=${+def.sphere.radius} @${v3(def.sphere.center)}`;
  else if (def.plane) label = `plane n=${v3(def.plane.normal)} d=${+(def.plane.offset ?? 0)}`;
  if (def.complement) label += ' ⁻';
  const material = def.material ?? def.paint;
  if (material !== undefined) label += ` · ${material === null ? 'vacuum' : material}`;

  const kids = [];
  if (def.inside !== undefined) kids.push(['in', ['inside'], def.inside]);
  if (def.outside !== undefined) kids.push(['out', ['outside'], def.outside]);
  return { label: label + tail, kids };
}

function flatten(doc, expanded) {
  const spec = doc.spec;
  const primary = doc.selection;
  const rows = [];

  function walk(owner, segments, name, def, prefix, isLast, depth) {
    const path = joinPath(segments);
    const key = `${owner}:${path}`;
    const { label, kids } = describe(def);
    // An object's own row selects the object, even when its body is a
    // reference to its prototype; any other reference selects its target.
    const ref = (owner === ROOT || segments.length) ? refName(def) : null;
    const target = ref ? { owner: ref, path: '' } : { owner, path };
    const open = expanded.has(key);
    rows.push({
      prefix: depth === 0 ? '' : prefix + (isLast ? '└─ ' : '├─ '),
      glyph: kids.length ? (open ? '▾' : '▸') : ' ',
      hasKids: kids.length > 0,
      name, label, key,
      target,
      selected: doc.isSelected(target.owner, target.path),
      primary: primary.owner === target.owner && primary.path === target.path,
    });
    if (!kids.length || !open) return;
    const childPrefix = depth === 0 ? '' : prefix + (isLast ? '   ' : '│  ');
    kids.forEach(([childName, childSegments, child], i) =>
      walk(owner, [...segments, ...childSegments], childName, child,
           childPrefix, i === kids.length - 1, depth + 1));
  }

  walk(ROOT, [], 'root', spec.root, '', true, 0);

  const named = Object.entries(spec.objects ?? {});
  if (named.length) {
    const open = expanded.has('objects');
    rows.push({ prefix: '', glyph: open ? '▾' : '▸', hasKids: true, name: 'objects',
                label: `(${named.length})`, key: 'objects', target: null,
                selected: false, primary: false });
    if (open) {
      named.forEach(([name, def], i) =>
        walk(name, [], name, def, '', i === named.length - 1, 1));
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * Bind the panel markup already in `root` to a document.
 *
 * @param {HTMLElement} root   the panel container, holding the bound markup
 * @param {object} ctx
 * @param {SceneDocument} ctx.doc
 * @param {ASScene} ctx.scene                for statistics
 * @param {() => object} ctx.getActive       the focused view {renderer, camera, controls, index, name}
 * @param {() => object} ctx.getCameraView   the view whose camera the Camera section edits
 * @param {(name:string) => void} ctx.command   run an editor command
 */
export function createPanel(root, ctx) {
  const uiulator = globalThis.uiulator;
  if (typeof uiulator !== 'function') {
    throw new Error('uiulator.js is not loaded; include it with a <script> before the page module');
  }
  const { doc, scene } = ctx;
  const $ = (selector) => root.querySelector(selector);
  const expanded = new Set([`${ROOT}:`]);

  // -- header ------------------------------------------------------------------

  const header = {
    // The shapes the Add row offers, keyed by the name the create command
    // takes, so a button's value says which one it is.
    shapes: Object.fromEntries(
      Object.entries(SHAPES).map(([name, shape]) => [name, { label: shape.label }])),
    get title() { return doc.fileName; },
    get dirty() { return doc.dirty; },
    get error() { return doc.error ?? ''; },
    get canUndo() { return doc.canUndo; },
    get canRedo() { return doc.canRedo; },
    get history() {
      const parts = [];
      if (doc.undoLabel) parts.push(`undo: ${doc.undoLabel}`);
      if (doc.redoLabel) parts.push(`redo: ${doc.redoLabel}`);
      return parts.join(' · ');
    },
    get stats() {
      return `${scene.nodes.length} nodes · ${scene.materials.length - 1} materials · ` +
             `${scene.lights.length} lights · ${scene.bytes ?? '?'} B`;
    },
  };

  // -- camera ------------------------------------------------------------------
  //
  // The view whose camera this section edits is chosen by its camera glyph,
  // not by hover focus, so reaching the panel across other panes doesn't
  // change what's being edited.

  const edited = () => ctx.getCameraView();
  const camera = {
    cameraModes: CAMERA_MODES,
    debugViews: DEBUG_VIEWS,
    projections: ['perspective', 'orthographic'],
    get viewName() { return edited()?.name ?? ''; },
    get projection() { return edited().camera.projection; },
    set projection(v) { edited().camera.projection = v; },
    get mode() { return edited().camera.mode; },
    set mode(v) { edited().controls.setMode(v); },
    get shadows() { return edited().renderer.shadows; },
    set shadows(v) { edited().renderer.shadows = !!v; },
    // Option values are the array keys, so strings.
    get debugView() { return String(edited().renderer.debugView); },
    set debugView(v) { edited().renderer.setDebugView(+v); },
    get scale() { return edited().renderer.renderScale; },
    set scale(v) { edited().renderer.setRenderScale(v); },
    get scaleText() { return this.scale.toFixed(2); },
  };

  // -- selection -----------------------------------------------------------------
  //
  // At object level, translate moves the object itself — for an instance,
  // its own { use, translate } body — while shape fields edit the node the
  // selection resolves to, which for an instance is its prototype. So moving
  // an instance moves only it, and resizing it resizes every instance.

  const current = () => {
    const { owner, path } = doc.selection;
    if (!owner) return null;
    const found = doc.resolve(owner, path);
    return found ? { owner, path, node: found.node } : null;
  };

  const translateHolder = (cur) => {
    if (cur.path) return cur.node;
    return cur.owner === ROOT ? doc.spec.root : doc.spec.objects[cur.owner];
  };

  // Rapid edits to one field of one node merge into a single undo step.
  const fieldKey = (cur, field) => `field:${cur.owner}:${cur.path}:${field}`;

  function editShape(field, mutate) {
    const cur = current();
    if (!cur) return;
    doc.editNode(cur.owner, cur.path, mutate, {
      label: `Edit ${field} of ${cur.owner}${cur.path ? '/' + cur.path : ''}`,
      coalesce: fieldKey(cur, field),
    });
  }

  // Transforms belong to the thing being placed, not to the shape: at object
  // level they go on the object's own body, so a shape authored about the
  // origin turns and grows where it stands - scale, then rotate, then
  // translate. Inside an object they go on the node, and there the origin is
  // the definition's, so a rotation there will swing the part around it.
  function editTransform(cur, field, mutate) {
    const where = cur.owner + (cur.path ? '/' + cur.path : '');
    const label = `${field} ${where}`;
    const coalesce = fieldKey(cur, field);
    if (cur.path) {
      doc.editNode(cur.owner, cur.path, mutate, { label, coalesce });
      return;
    }
    doc.edit(label, (spec) => {
      const body = cur.owner === ROOT ? spec.root : spec.objects[cur.owner];
      if (!isObject(body)) throw new Error(`${where} cannot carry a transform`);
      mutate(body);
    }, { coalesce });
  }

  function setTranslate(next) {
    const cur = current();
    if (cur) editTransform(cur, 'Move', (holder) => { holder.translate = next; });
  }

  // A rotation is an axis and an angle together, so both fields write the
  // whole thing. Zero degrees leaves nothing behind, which keeps a spec that
  // was only nudged as clean as one that was never touched.
  const rotationOf = (holder) => {
    const spin = isObject(holder) && isObject(holder.rotate) ? holder.rotate : null;
    const degrees = spin
      ? (typeof spin.degrees === 'number' ? spin.degrees : (spin.radians ?? 0) * 180 / Math.PI)
      : 0;
    // Across the up axis rather than along it: almost everything here is a
    // surface of revolution about its own axis, so a turn about that axis
    // would be no turn at all. See turnsInvisibly().
    return { axis: spin?.axis ?? [1, 0, 0], degrees };
  };

  function setRotation(axis, degrees, pivot = pivotOf(current())) {
    const cur = current();
    if (!cur) return;
    // Zeroing the last non-zero component on the way to another axis would
    // leave a rotation about nothing, which the compiler rightly refuses.
    // Leave the axis as it was rather than making an error of it.
    if (!axis.some((v) => v !== 0)) return;
    editTransform(cur, 'Turn', (holder) => {
      if (!degrees) { delete holder.rotate; return; }
      holder.rotate = { axis, degrees };
      if (pivot.some((v) => v !== 0)) holder.rotate.pivot = pivot;
    });
  }

  // One pivot is shown for both transforms, since wanting a rotation and a
  // scale about different points is rare and two more rows of fields is not.
  // A scene that names them separately keeps them: the rotation's is the one
  // displayed, and writing sets whichever of the two exist.
  const pivotOf = (cur) => {
    if (!cur) return [0, 0, 0];
    const holder = translateHolder(cur);
    if (!isObject(holder)) return [0, 0, 0];
    const spin = isObject(holder.rotate) ? holder.rotate.pivot : null;
    const grow = isObject(holder.scale) ? holder.scale.pivot : null;
    return spin ?? grow ?? [0, 0, 0];
  };

  function setPivot(pivot) {
    const cur = current();
    if (!cur) return;
    const zero = !pivot.some((v) => v !== 0);
    editTransform(cur, 'Pivot', (holder) => {
      if (isObject(holder.rotate)) {
        if (zero) delete holder.rotate.pivot; else holder.rotate.pivot = pivot;
      }
      if (typeof holder.scale === 'number' && !zero) {
        holder.scale = { factor: holder.scale, pivot };
      } else if (isObject(holder.scale)) {
        if (zero) delete holder.scale.pivot; else holder.scale.pivot = pivot;
      }
    });
  }

  const scaleOf = (holder) => {
    const factor = isObject(holder) ? holder.scale : undefined;
    if (typeof factor === 'number') return factor;
    if (isObject(factor) && typeof factor.factor === 'number') return factor.factor;
    return 1;
  };

  function setScale(factor) {
    const cur = current();
    if (!cur) return;
    const pivot = pivotOf(cur);
    editTransform(cur, 'Resize', (holder) => {
      if (factor === 1) { delete holder.scale; return; }
      // Whatever pivot is in force applies to the scale as well, since the
      // panel shows one for both; with none, a bare number says it all.
      const named = (isObject(holder.scale) && holder.scale.pivot) || 
                    (pivot.some((v) => v !== 0) ? pivot : null);
      holder.scale = named ? { factor, pivot: named } : factor;
    });
  }

  const selection = {
    get has() { return !!current(); },
    get count() { return doc.selections.length; },
    get multiple() { return doc.selections.length > 1; },
    get countText() {
      const n = doc.selections.length;
      return `${n} selected · these fields edit the last, Delete and Duplicate all of them`;
    },
    get title() {
      const cur = current();
      if (!cur) return '';
      return (cur.owner === ROOT ? 'root' : cur.owner) + (cur.path ? ` / ${cur.path}` : '');
    },
    get kindText() {
      const cur = current();
      if (!cur) return '';
      const node = cur.node;
      const type = !node ? 'nothing' : typeof node === 'string' ? 'reference'
        : node.sphere ? 'sphere' : node.plane ? 'plane'
        : node.group ? 'group' : node.union ? 'union' : node.use ? 'reference' : '?';
      if (cur.owner === ROOT) return type;
      if (!cur.path) {
        if (doc.isInstance(cur.owner)) return `instance of ${doc.spec.objects[cur.owner].use}`;
        const n = doc.instancesOf(cur.owner).length;
        return n ? `definition · ${n} instance${n === 1 ? '' : 's'}` : 'definition';
      }
      if (!doc.isInstance(cur.owner)) return type;
      // Editing here edits the definition; say so when others will change too.
      const definition = doc.definitionKeyOf(cur.owner);
      const users = doc.instancesOf(definition).length;
      return users > 1 ? `${type} in ${definition}, shared by ${users}` : `${type} in ${definition}`;
    },
    get isObjectLevel() { const c = current(); return !!c && !c.path && c.owner !== ROOT; },
    get isInstance() { const c = current(); return !!c && !c.path && doc.isInstance(c.owner); },
    get canPromote() { const c = current(); return !!c && !!c.path && isObject(c.node) && !c.node.use; },
    get isSphere() { return !!current()?.node?.sphere; },
    get isPlane() { return !!current()?.node?.plane; },
    get isPrimitive() { const n = current()?.node; return !!(n?.sphere || n?.plane); },
    get hasTransform() { const c = current(); return !!c && isObject(translateHolder(c)); },

    get spinDegrees() {
      const c = current();
      return c ? tidy(rotationOf(translateHolder(c)).degrees) : 0;
    },
    set spinDegrees(v) {
      const c = current();
      if (c) setRotation(rotationOf(translateHolder(c)).axis, v);
    },
    get scaleFactor() {
      const c = current();
      return c ? tidy(scaleOf(translateHolder(c))) : 1;
    },
    set scaleFactor(v) { if (v > 0) setScale(v); },
    // A pivot with no transform to belong to would have nowhere to be
    // written, so the row only appears once there is one.
    // True when the chosen axis is one the shape is symmetric about, so the
    // panel can say why nothing moved.
    get spinIsFutile() {
      const c = current();
      if (!c) return false;
      const holder = translateHolder(c);
      const { axis, degrees } = rotationOf(holder);
      return !!degrees && turnsInvisibly(holder, axis);
    },
    get hasPivot() {
      const c = current();
      if (!c) return false;
      const holder = translateHolder(c);
      return isObject(holder) && (holder.rotate !== undefined || holder.scale !== undefined);
    },

    get radius() { return tidy(current()?.node?.sphere?.radius ?? 0); },
    set radius(v) { editShape('radius', (n) => { n.sphere.radius = v; }); },
    get offset() { return tidy(current()?.node?.plane?.offset ?? 0); },
    set offset(v) { editShape('offset', (n) => { n.plane.offset = v; }); },

    get complement() { return !!current()?.node?.complement; },
    set complement(v) {
      editShape('complement', (n) => { if (v) n.complement = true; else delete n.complement; });
    },

    // Material options: inherit (no material key), vacuum (null), or a name.
    get materialNames() { return Object.keys(doc.spec.materials ?? {}); },
    get material() {
      const m = current()?.node?.material;
      return m === null ? '(vacuum)' : m ?? '';
    },
    set material(v) {
      editShape('material', (n) => {
        if (v === '') delete n.material;
        else n.material = v === '(vacuum)' ? null : v;
      });
    },
  };

  // Three-component fields, bound as e.g. tx ty tz.
  function vectorFields(model, names, read, write) {
    names.forEach((name, axis) => Object.defineProperty(model, name, {
      enumerable: true,
      get: () => tidy(read()?.[axis] ?? 0),
      set: (v) => { const next = (read() ?? [0, 0, 0]).slice(); next[axis] = v; write(next); },
    }));
  }
  vectorFields(selection, ['tx', 'ty', 'tz'],
    () => { const c = current(); return c && isObject(translateHolder(c)) ? translateHolder(c).translate : null; },
    setTranslate);
  vectorFields(selection, ['px', 'py', 'pz'],
    () => pivotOf(current()),
    setPivot);
  vectorFields(selection, ['ax', 'ay', 'az'],
    () => { const c = current(); return c ? rotationOf(translateHolder(c)).axis : null; },
    (next) => {
      const c = current();
      if (c) setRotation(next, rotationOf(translateHolder(c)).degrees);
    });
  vectorFields(selection, ['cx', 'cy', 'cz'],
    () => current()?.node?.sphere?.center,
    (next) => editShape('centre', (n) => { n.sphere.center = next; }));
  vectorFields(selection, ['nx', 'ny', 'nz'],
    () => current()?.node?.plane?.normal,
    (next) => editShape('normal', (n) => { n.plane.normal = next; }));

  // -- lights ------------------------------------------------------------------
  //
  // Light colour is radiant power, routinely above 1, so it's shown as a hue
  // the colour picker can display and an intensity carrying the magnitude.
  // The last hue is remembered per light, so taking intensity to zero and
  // back doesn't lose it.

  const hues = [];

  function lightView(i) {
    const light = () => doc.spec.lights[i];
    const split = () => {
      const c = light().color;
      const peak = Math.max(...c);
      if (peak > 0) hues[i] = c.map((x) => x / peak);
      return { hue: hues[i] ?? [1, 1, 1], intensity: peak };
    };
    const setAxis = (axis, v) => {
      const pos = light().pos.slice();
      pos[axis] = v;
      doc.setLight(i, { pos });
    };
    return {
      get x() { return tidy(light().pos[0]); }, set x(v) { setAxis(0, v); },
      get y() { return tidy(light().pos[1]); }, set y(v) { setAxis(1, v); },
      get z() { return tidy(light().pos[2]); }, set z(v) { setAxis(2, v); },
      get hue() { return toHex(split().hue); },
      set hue(v) {
        const { intensity } = split();
        hues[i] = fromHex(v);
        doc.setLight(i, { color: hues[i].map((c) => c * intensity) });
      },
      get intensity() { return +split().intensity.toFixed(3); },
      set intensity(v) {
        const { hue } = split();
        doc.setLight(i, { color: hue.map((c) => c * v) });
      },
    };
  }

  const lightsModel = { lights: [] };
  const rebuildLights = () => {
    const count = doc.spec.lights?.length ?? 0;
    if (lightsModel.lights.length !== count) hues.length = 0;
    lightsModel.lights = Array.from({ length: count }, (_, i) => lightView(i));
  };

  // -- materials -----------------------------------------------------------------

  // Absent fields read as the compiler's defaults, so a control never shows
  // "undefined", and are only written into the spec once actually edited.
  function materialView(name) {
    const def = () => doc.spec.materials[name];
    const kind = def().kind ?? 'lambert';
    const colour = (key, fallback) => ({
      enumerable: true,
      get: () => toHex(def()[key] ?? fallback),
      set: (v) => doc.setMaterial(name, { [key]: fromHex(v) }),
    });
    const scalar = (key, fallback) => ({
      enumerable: true,
      get: () => def()[key] ?? fallback,
      set: (v) => doc.setMaterial(name, { [key]: v }),
    });
    return Object.defineProperties({
      name, kind,
      albedoLabel: kind === 'ambient' ? 'level' : 'albedo',
      isChecker: def().pattern === 'checker',
      isGlossy: kind === 'glossy',
      isEmissive: kind === 'emissive',
    }, {
      albedo:    colour('albedo', [0.7, 0.7, 0.7]),
      albedo2:   colour('albedo2', [0.3, 0.3, 0.3]),
      scale:     scalar('scale', 1),
      shininess: scalar('shininess', 32),
      specular:  scalar('specular', 0.6),
      emission:  scalar('emission', 1),
    });
  }

  const materialsModel = { materials: [] };
  const rebuildMaterials = () => {
    materialsModel.materials = Object.keys(doc.spec.materials ?? {}).map(materialView);
  };

  // -- structure -----------------------------------------------------------------

  const structureModel = { rows: [] };
  const rebuildRows = () => {
    structureModel.rows = flatten(doc, expanded);
  };

  // -- bindings ----------------------------------------------------------------

  const sections = {
    header: uiulator(header, $('#panel-head')),
    camera: uiulator(camera, $('#panel-camera'), { 'update-on-change': true }),
    selection: uiulator(selection, $('#panel-selection'), {
      'control-on-submit': true, 'update-on-change': true,
    }),
    lights: uiulator(lightsModel, $('#panel-lights'), { 'update-on-change': true }),
    materials: uiulator(materialsModel, $('#panel-materials'), {
      'control-on-submit': true, 'update-on-change': true,
    }),
    structure: uiulator(structureModel, $('#panel-structure')),
  };
  const ALL = Object.keys(sections);

  function refresh(...names) {
    if (!names.length) names = ALL;
    if (names.includes('lights')) rebuildLights();
    if (names.includes('materials')) rebuildMaterials();
    if (names.includes('structure')) rebuildRows();
    for (const name of names) sections[name].update();
  }

  // Which sections a change can affect. Light values change on every tick of
  // a drag, so they touch as little as possible; anything that may have
  // restructured the scene refreshes everything.
  doc.onChange(({ kind }) => {
    switch (kind) {
      case 'lights':    refresh('header', 'lights'); break;
      case 'materials': refresh('header', 'materials', 'selection'); break;
      case 'selection': refresh('selection', 'structure'); break;
      case 'error':
      case 'saved':     refresh('header', 'selection'); break;
      default:          refresh(); break;
    }
  });

  // A light drag coalesces into one undo step; letting go of the control
  // ends it, so the next drag is a step of its own.
  $('#panel-lights').addEventListener('change', () => doc.endCoalesce());

  // -- actions -----------------------------------------------------------------

  // Buttons in repeated items carry their index in value="@key". One
  // delegated handler covers every button, including those uiulator creates
  // later by expansion.
  root.addEventListener('click', (e) => {
    const button = e.target.closest('[data-action]');
    if (!button || !root.contains(button)) return;
    // A focused button would keep the shortcuts disabled, and uiulator won't
    // update the text of the focused element, which a toggle glyph needs.
    button.blur();
    const index = Number(button.value);
    const action = button.dataset.action;

    switch (action) {
      case 'toggle':
      case 'select-row': {
        const row = structureModel.rows[index];
        if (!row) break;
        if (action === 'select-row' && row.target) {
          const { owner, path } = row.target;
          if (e.shiftKey) doc.addToSelection(owner, path);
          else doc.select(owner, path);
          break;
        }
        if (!row.hasKids) break;
        if (expanded.has(row.key)) expanded.delete(row.key);
        else expanded.add(row.key);
        refresh('structure');
        break;
      }
      case 'create':
        ctx.command('create', button.value);
        break;
      case 'add-light':
        doc.addLight();
        break;
      case 'remove-light':
        doc.removeLight(index);
        break;
      default:
        ctx.command(action);
    }
  });

  // Controls that don't take typing give focus back once used, so the view
  // shortcuts work again without having to click a pane first.
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.tagName === 'SELECT' || ['range', 'checkbox', 'color'].includes(t.type)) t.blur();
  });

  // -- initial fill ------------------------------------------------------------

  refresh();
  // A <select> is shown before its expanded <option>s exist, so on the very
  // first pass its value has nothing to match. The second pass finds them.
  refresh('camera', 'selection');

  return {
    /** Re-read the edited camera's settings, after a shortcut may have changed them. */
    refreshCamera: () => refresh('camera'),

    /** Open the Camera section on the view now being edited, and bring it into sight. */
    showCamera() {
      const section = $('#panel-camera');
      section.open = true;
      refresh('camera');
      section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      section.classList.remove('flash');
      void section.offsetWidth;          // restart the animation
      section.classList.add('flash');
    },
    /** Refresh named sections, or all of them. */
    refresh,
  };
}
