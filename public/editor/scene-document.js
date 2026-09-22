// SceneDocument: what the scene is, and how it changes.
//
// Sits between the editor's views and the GPU. It owns the authored spec,
// the selection and the undo history, and commits edits to an ASScene. It has
// no DOM and no GPU code of its own, so it runs unchanged under node for
// testing: anything with update(spec) and setLights(lights) will do as a
// scene.
//
// Layers:
//   ASScene          GPU resources: compile, buffers, traceRays
//   SceneDocument    the authored scene and every change to it        <- here
//   editor-panel.js  a view of the document
//   editor.js        wiring: panes, input, picking, shortcuts
//
// Identity. Objects are named by their keys in spec.objects. An object whose
// whole body is { use, translate } is an *instance* of the object it uses,
// its prototype; anything else is a definition. The root subtree is
// addressed as ROOT ('@root'), since it has no key.
//
// A selection entry is two-level: an owner (an object key, or ROOT) and a
// path within that owner's *definition*. Paths are the literal keys into the
// spec, joined with '/': 'inside/outside', 'union/2/inside'. Scoped to one
// definition, a deletion elsewhere can't shift them.
//
// The selection is an ordered set of entries. The last one added is the
// primary: the one whose properties get shown and edited. `selection` is
// the primary alone, `selections` all of them.
//
// Editing inside an instance edits its prototype, so every instance changes.
// makeUnique() gives one instance a private copy of its definition first.
//
// Undo is by snapshot: the spec is tens of kilobytes, so a clone per step is
// cheap, and restoring a snapshot is correct by construction. Rapid edits
// that share a coalesce key merge into one step, so a slider drag is one
// undo, not two hundred.
//
// Every edit is transactional. The mutation runs on the live spec, the
// result is compiled, and if either throws the spec is restored and the error
// reported. The document therefore always describes what the scene is
// actually rendering.

export const ROOT = '@root';

const AGGREGATES = ['group', 'union'];
const SIDES = ['inside', 'outside'];
const ZERO = [0, 0, 0];
const MAX_CHAIN = 64;          // guard against pathological instancing chains

const clone = (x) => structuredClone(x);
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export const splitPath = (path) => (path ? String(path).split('/') : []);
export const joinPath = (segments) => segments.join('/');

const sameEntry = (a, b) => a.owner === b.owner && a.path === b.path;
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isUseBody = (def) => isObject(def) && typeof def.use === 'string';

/** The object a subtree refers to by name, or null if it isn't a reference. */
function refName(def) {
  if (typeof def === 'string') return def === 'empty' ? null : def;
  return isUseBody(def) ? def.use : null;
}

// Visit every subtree beneath `def`, with enough context to replace it:
// parent[slot] is the subtree itself.
function walkDef(def, visit, owner, path, parent, slot) {
  visit({ def, owner, segments: path, parent, slot });
  if (!isObject(def)) return;
  for (const op of AGGREGATES) {
    if (Array.isArray(def[op])) {
      def[op].forEach((member, i) =>
        walkDef(member, visit, owner, [...path, op, String(i)], def[op], i));
    }
  }
  for (const side of SIDES) {
    if (def[side] !== undefined) {
      walkDef(def[side], visit, owner, [...path, side], def, side);
    }
  }
}

function walkSpec(spec, visit) {
  if (spec.root !== undefined) walkDef(spec.root, visit, ROOT, [], spec, 'root');
  for (const [key, def] of Object.entries(spec.objects ?? {})) {
    walkDef(def, visit, key, [], spec.objects, key);
  }
}

// Remove subtrees in place. Array members are spliced out, highest index
// first so earlier removals don't shift later ones; anything in a named slot
// becomes 'empty'. An explicit 'empty' matters for `inside`, where an omitted
// value would mean solid.
function removeAll(places) {
  const byArray = new Map();
  for (const p of places) {
    if (Array.isArray(p.parent)) {
      if (!byArray.has(p.parent)) byArray.set(p.parent, []);
      byArray.get(p.parent).push(Number(p.slot));
    } else {
      p.parent[p.slot] = 'empty';
    }
  }
  for (const [array, indices] of byArray) {
    indices.sort((a, b) => b - a).forEach((i) => array.splice(i, 1));
  }
}

// Replace every group or union with no members by 'empty', repeatedly, since
// emptying one can empty its parent.
function pruneAggregates(spec) {
  for (;;) {
    const emptied = [];
    walkSpec(spec, (place) => {
      const d = place.def;
      if (isObject(d) && AGGREGATES.some((op) => Array.isArray(d[op]) && d[op].length === 0)) {
        emptied.push(place);
      }
    });
    if (!emptied.length) return;
    removeAll(emptied);
  }
}

// Sum of the translates on the way from `body` down `segments`, including the
// node at the end. Translations compose by addition; this is where rotation
// will need a real transform once it exists.
function pathTranslate(body, segments) {
  let total = [...ZERO];
  let node = body;
  const take = (n) => { if (isObject(n) && n.translate) total = add3(total, n.translate); };
  take(node);
  for (const seg of segments) {
    if (node === null || typeof node !== 'object') return null;
    node = node[seg];
    take(node);
  }
  return node === undefined ? null : total;
}

export class SceneDocument {
  #scene;
  #spec;
  #history = [];
  #index = 0;
  #nextId = 0;
  #savedId = 0;
  #selected = [];               // entries { owner, path }; the last is primary
  #inTransaction = false;
  #error = null;
  #listeners = new Set();
  #coalesceMs;
  #historyLimit;
  #now;

  /**
   * @param {object} scene  anything with update(spec) and setLights(lights);
   *                        normally an ASScene already compiled from `spec`
   * @param {object} spec   the scene as authored
   * @param {object} [opts]
   * @param {string} [opts.fileName]
   * @param {string} [opts.containerKey]  where new objects go; see createObject
   * @param {number} [opts.coalesceMs]    how recent an edit must be to merge
   * @param {number} [opts.historyLimit]  undo steps kept
   * @param {() => number} [opts.now]     clock, injectable for tests
   */
  constructor(scene, spec, opts = {}) {
    this.#scene = scene;
    this.fileName = opts.fileName ?? 'untitled.json';
    this.containerKey = opts.containerKey ?? 'editor-objects';
    this.#coalesceMs = opts.coalesceMs ?? 1000;
    this.#historyLimit = opts.historyLimit ?? 200;
    this.#now = opts.now ?? (() => Date.now());
    this.#reset(clone(spec));
  }

  // -- state -------------------------------------------------------------------

  /** The live spec. Treat as read-only: change it through edit() or an operation. */
  get spec() { return this.#spec; }
  get error() { return this.#error; }
  get dirty() { return this.#history[this.#index].id !== this.#savedId; }
  /** The primary selection, or { owner: null, path: '' } if nothing is selected. */
  get selection() {
    const last = this.#selected.at(-1);
    return last ? { ...last } : { owner: null, path: '' };
  }
  /** Every selected entry, primary last. */
  get selections() { return this.#selected.map((e) => ({ ...e })); }

  get canUndo() { return this.#index > 0; }
  get canRedo() { return this.#index < this.#history.length - 1; }
  get undoLabel() { return this.canUndo ? this.#history[this.#index].label : null; }
  get redoLabel() { return this.canRedo ? this.#history[this.#index + 1].label : null; }

  /**
   * Subscribe to changes. The listener gets { kind, label?, error? }, where
   * kind is one of: structure, lights, materials, selection, undo, redo, load,
   * saved, error. Returns an unsubscribe function.
   */
  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(change) {
    for (const listener of this.#listeners) listener(change);
  }

  #reset(spec) {
    this.#spec = spec;
    this.#history = [this.#entry('open', null)];
    this.#index = 0;
    this.#savedId = this.#history[0].id;
    this.#selected = [];
    this.#error = null;
  }

  #entry(label, coalesce) {
    return { spec: clone(this.#spec), label, coalesce, time: this.#now(), id: ++this.#nextId };
  }

  // -- editing -----------------------------------------------------------------

  /**
   * Change the scene. `mutate(spec)` edits the live spec in place; throw from
   * it to refuse the edit. The result is compiled, and if either the mutation
   * or the compile fails, the spec is restored and { ok: false, error } comes
   * back — nothing is recorded and the scene keeps rendering as it was.
   *
   * kind 'lights' takes the cheap path when the number of lights is
   * unchanged: a buffer write rather than a recompile. Everything else
   * recompiles.
   *
   * Edits sharing a `coalesce` key, made within coalesceMs of each other with
   * nothing in between, merge into one undo step.
   */
  edit(label, mutate, { kind = 'structure', coalesce = null } = {}) {
    // Inside a transaction, operations only mutate: the transaction compiles
    // and records once for all of them, and a throw here aborts the lot.
    if (this.#inTransaction) {
      mutate(this.#spec);
      return { ok: true };
    }
    const before = clone(this.#spec);
    let error = null;
    try {
      mutate(this.#spec);
      const sameLightCount = (before.lights ?? []).length === (this.#spec.lights ?? []).length;
      if (kind === 'lights' && sameLightCount) {
        this.#scene.setLights(this.#spec.lights.map((l) => ({ pos: l.pos.slice(), color: l.color.slice() })));
      } else {
        error = this.#compile();
      }
    } catch (e) {
      error = e.message ?? String(e);
    }

    if (error) {
      this.#spec = before;
      this.#error = error;
      this.#emit({ kind: 'error', label, error });
      return { ok: false, error };
    }

    this.#error = null;
    this.#record(label, coalesce);
    this.#validateSelection();
    this.#emit({ kind, label });
    return { ok: true };
  }

  /**
   * Run several operations as one edit: one compile, one undo step, and if
   * any of them fails, none of them happened. `fn` calls ordinary document
   * operations. Nested transactions fold into the outermost.
   */
  transaction(label, fn, opts) {
    if (this.#inTransaction) { fn(); return { ok: true }; }
    return this.edit(label, () => {
      this.#inTransaction = true;
      try { fn(); } finally { this.#inTransaction = false; }
    }, opts);
  }

  /** End the current coalescing run, so the next edit starts a new undo step. */
  endCoalesce() {
    this.#history[this.#index].coalesce = null;
  }

  #compile() {
    try {
      this.#scene.update(clone(this.#spec));
      return null;
    } catch (e) {
      return e.message ?? String(e);
    }
  }

  #record(label, coalesce) {
    const top = this.#history[this.#index];
    const atTop = this.#index === this.#history.length - 1;
    if (coalesce && atTop && top.coalesce === coalesce &&
        this.#now() - top.time < this.#coalesceMs) {
      // Merge: the step before this one still holds the state from before the
      // run began, which is what undo should return to. A fresh id keeps the
      // saved-state check honest.
      top.spec = clone(this.#spec);
      top.time = this.#now();
      top.id = ++this.#nextId;
      return;
    }
    this.#history.length = this.#index + 1;           // an edit discards any redo
    this.#history.push(this.#entry(label, coalesce));
    if (this.#history.length > this.#historyLimit) this.#history.shift();
    this.#index = this.#history.length - 1;
  }

  undo() {
    if (!this.canUndo) return false;
    const label = this.#history[this.#index].label;
    this.#index--;
    return this.#restore('undo', label);
  }

  redo() {
    if (!this.canRedo) return false;
    this.#index++;
    return this.#restore('redo', this.#history[this.#index].label);
  }

  #restore(kind, label) {
    this.#spec = clone(this.#history[this.#index].spec);
    this.#error = this.#compile();
    this.#validateSelection();
    this.#emit({ kind, label });
    return !this.#error;
  }

  // -- file --------------------------------------------------------------------

  /** Replace the whole document, as for New or Open. History starts over. */
  load(spec, fileName) {
    try {
      this.#scene.update(clone(spec));
    } catch (e) {
      const error = e.message ?? String(e);
      this.#emit({ kind: 'error', label: 'load', error });
      return { ok: false, error };
    }
    if (fileName) this.fileName = fileName;
    this.#reset(clone(spec));
    this.#emit({ kind: 'load' });
    return { ok: true };
  }

  toJSON() {
    return JSON.stringify(this.#spec, null, 2) + '\n';
  }

  /** Record the current state as the saved one, for `dirty`. */
  markSaved() {
    this.#savedId = this.#history[this.#index].id;
    this.#emit({ kind: 'saved' });
  }

  // -- selection ---------------------------------------------------------------

  /**
   * Select just this: an object, or a node within its definition, replacing
   * whatever was selected. Null clears. Returns false, and leaves the
   * selection alone, if there is no such thing.
   */
  select(owner, path = '') {
    if (owner === null) {
      this.#selected = [];
    } else {
      if (!this.#selectable(owner, path)) return false;
      this.#selected = [{ owner, path: path ?? '' }];
    }
    this.#emit({ kind: 'selection' });
    return true;
  }

  /**
   * Add to the selection, making the addition primary. Something already
   * selected just becomes primary. Returns false for nothing selectable.
   */
  addToSelection(owner, path = '') {
    if (!this.#selectable(owner, path)) return false;
    const entry = { owner, path: path ?? '' };
    this.#selected = this.#selected.filter((e) => !sameEntry(e, entry));
    this.#selected.push(entry);
    this.#emit({ kind: 'selection' });
    return true;
  }

  isSelected(owner, path = '') {
    return this.#selected.some((e) => e.owner === owner && e.path === (path ?? ''));
  }

  clearSelection() { return this.select(null); }

  #selectable(owner, path) {
    if (!this.#ownerExists(owner)) return false;
    return !path || !!this.resolve(owner, path);
  }

  #ownerExists(owner) {
    return owner === ROOT || Object.hasOwn(this.#spec.objects ?? {}, owner);
  }

  // After an edit or an undo, drop whatever part of the selection no longer
  // exists: the object if it's gone, just the path if only the node is. A
  // deleted node leaves an explicit 'empty' in its slot, so the path still
  // resolves; that counts as gone too.
  #validateSelection() {
    const kept = [];
    for (const entry of this.#selected) {
      if (!this.#ownerExists(entry.owner)) continue;
      let next = entry;
      if (entry.path) {
        const found = this.resolve(entry.owner, entry.path);
        if (!found || found.node === 'empty') next = { owner: entry.owner, path: '' };
      }
      // Trimming can make two entries the same; keep the later, so the
      // primary stays primary.
      const dup = kept.findIndex((e) => sameEntry(e, next));
      if (dup >= 0) kept.splice(dup, 1);
      kept.push(next);
    }
    this.#selected = kept;
  }

  // -- lookup ------------------------------------------------------------------

  has(key) { return Object.hasOwn(this.#spec.objects ?? {}, key); }
  objectKeys() { return Object.keys(this.#spec.objects ?? {}); }
  isInstance(key) { return isUseBody(this.#spec.objects?.[key]); }

  /** Follow an instance through its prototypes to the definition it uses. */
  definitionKeyOf(key) {
    let current = key;
    for (let n = 0; n < MAX_CHAIN; n++) {
      const body = this.#spec.objects?.[current];
      if (body === undefined) return null;
      if (!isUseBody(body)) return current;
      current = body.use;
    }
    return null;
  }

  /**
   * Every place that names `key`. isBody marks an instance's own body — the
   * { use } that makes it an instance — as opposed to a placement somewhere
   * in a tree.
   */
  referencesTo(key) {
    const refs = [];
    walkSpec(this.#spec, (place) => {
      if (refName(place.def) !== key) return;
      refs.push({
        ...place,
        path: joinPath(place.segments),
        isBody: place.owner !== ROOT && place.segments.length === 0,
      });
    });
    return refs;
  }

  /** The objects that are instances of `key`. */
  instancesOf(key) {
    return this.referencesTo(key).filter((r) => r.isBody).map((r) => r.owner);
  }

  /**
   * Find a node: { node, parent, slot, definitionKey } with parent[slot] ===
   * node, or null. For an instance, the path is resolved in its definition,
   * which is the point: editing that node edits the prototype.
   */
  resolve(owner, path = '') {
    let parent, slot, definitionKey;
    if (owner === ROOT) {
      parent = this.#spec; slot = 'root'; definitionKey = ROOT;
    } else {
      definitionKey = this.definitionKeyOf(owner);
      if (!definitionKey) return null;
      parent = this.#spec.objects; slot = definitionKey;
    }
    let node = parent[slot];
    for (const seg of splitPath(path)) {
      // A reference has no children of its own; its contents belong to
      // another object, which is selected as that object.
      if (node === null || typeof node !== 'object' || isUseBody(node)) return null;
      parent = node; slot = seg; node = node[seg];
      if (node === undefined) return null;
    }
    return { node, parent, slot, definitionKey };
  }

  // -- frames ------------------------------------------------------------------

  /**
   * The world-space offset of a node's local frame: add it to a point in the
   * node's own coordinates to get world coordinates. Includes the node's own
   * translate, the instancing chain, and wherever the owner is placed.
   *
   * Null when the frame is ambiguous: an object placed in more than one spot,
   * or a definition used by several instances, has no single world position.
   * Picking resolves that by knowing which placement was clicked.
   */
  worldOffset(owner, path = '') {
    const frame = this.#frameOf(owner, 0);
    if (!frame) return null;
    let total = frame;
    let body;
    if (owner === ROOT) {
      body = this.#spec.root;
    } else {
      let key = owner;
      for (let n = 0; isUseBody(this.#spec.objects?.[key]); n++) {
        if (n >= MAX_CHAIN) return null;
        total = add3(total, this.#spec.objects[key].translate ?? ZERO);
        key = this.#spec.objects[key].use;
      }
      body = this.#spec.objects?.[key];
      if (body === undefined) return null;
    }
    const along = pathTranslate(body, splitPath(path));
    return along ? add3(total, along) : null;
  }

  /** Convert a world-space point into a node's local frame, or null. */
  toLocal(owner, path, worldPoint) {
    const offset = this.worldOffset(owner, path);
    return offset ? sub3(worldPoint, offset) : null;
  }

  /** Convert a point in a node's local frame to world space, or null. */
  toWorld(owner, path, localPoint) {
    const offset = this.worldOffset(owner, path);
    return offset ? add3(localPoint, offset) : null;
  }

  // Where the frame an object's body is written in sits in the world.
  #frameOf(key, depth) {
    if (key === ROOT) return [...ZERO];
    if (depth > MAX_CHAIN) return null;
    const refs = this.referencesTo(key);
    if (refs.length === 0) return [...ZERO];      // unplaced: its own frame is the world
    if (refs.length > 1) return null;             // placed twice: no single frame
    const ref = refs[0];
    const base = this.#frameOf(ref.owner, depth + 1);
    if (!base) return null;
    if (ref.isBody) {
      // Used as a prototype by exactly one instance: that instance's body,
      // translate included, is where this definition lands.
      return add3(base, this.#spec.objects[ref.owner].translate ?? ZERO);
    }
    const ownerBody = ref.owner === ROOT ? this.#spec.root : this.#spec.objects[ref.owner];
    const along = pathTranslate(ownerBody, ref.segments);
    return along ? add3(base, along) : null;
  }

  // -- naming ------------------------------------------------------------------

  /** A key not yet in use: `base`, else base-2, base-3, ... */
  uniqueName(base = 'object') {
    if (!this.has(base)) return base;
    for (let i = 2; ; i++) if (!this.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  #checkNewName(name) {
    if (typeof name !== 'string' || !name) throw new Error('an object needs a name');
    if (name === 'empty' || name.startsWith('@')) throw new Error(`"${name}" is a reserved name`);
    if (this.has(name)) throw new Error(`an object called "${name}" already exists`);
  }

  // -- operations --------------------------------------------------------------

  /**
   * Add a new object and place it in the scene, by adding it to
   * `containerKey`: a union, so new objects may overlap whatever is there.
   * If the container isn't yet in the scene, the root is wrapped as
   * { union: [root, container] } to put it there.
   */
  createObject(def, { name, base = 'object', container = this.containerKey, label } = {}) {
    const key = name ?? this.uniqueName(base);
    const result = this.edit(label ?? `Create ${key}`, (spec) => {
      this.#checkNewName(key);
      (spec.objects ??= {})[key] = clone(def);
      this.#placeIn(spec, key, container);
    });
    if (result.ok) this.select(key);
    return { ...result, name: key };
  }

  #placeIn(spec, key, container) {
    if (!Object.hasOwn(spec.objects, container)) spec.objects[container] = { union: [] };
    const holder = spec.objects[container];
    const members = holder?.union ?? holder?.group;
    if (!Array.isArray(members)) throw new Error(`"${container}" is not a union or group`);
    members.push(key);
    if (this.referencesTo(container).length === 0) {
      spec.root = { union: [spec.root, container] };
    }
  }

  /**
   * Remove an object and every placement of it. Refused for a prototype that
   * still has instances, since deleting it would take them with it silently.
   */
  deleteObject(key) {
    return this.edit(`Delete ${key}`, (spec) => {
      if (!this.has(key)) throw new Error(`no object "${key}"`);
      const instances = this.instancesOf(key);
      if (instances.length) {
        throw new Error(`"${key}" is the prototype of ${instances.join(', ')}; ` +
                        'delete those or make them unique first');
      }
      removeAll(this.referencesTo(key));
      delete spec.objects[key];
      this.#prune(spec);
    });
  }

  /**
   * Remove a node from an object's definition. With an empty path this is
   * deleteObject. Inside an instance it edits the prototype, so every
   * instance loses the node.
   */
  deleteNode(owner, path) {
    if (!path) return this.deleteObject(owner);
    return this.edit(`Delete ${owner}/${path}`, (spec) => {
      const found = this.resolve(owner, path);
      if (!found) throw new Error(`nothing at ${owner}/${path}`);
      removeAll([found]);
      this.#prune(spec);
    });
  }

  // A group or union left with no members won't compile, so it becomes
  // 'empty' in turn, and so on up. An emptied editor container is removed
  // outright and the root unwrapped again, so creating and deleting an object
  // leaves no trace.
  #prune(spec) {
    pruneAggregates(spec);
    if (spec.objects?.[this.containerKey] !== 'empty') return;
    removeAll(this.referencesTo(this.containerKey));
    delete spec.objects[this.containerKey];
    pruneAggregates(spec);
    const root = spec.root;
    if (isObject(root) && Array.isArray(root.union) && root.union.length === 1 &&
        Object.keys(root).length === 1) {
      spec.root = root.union[0];
    }
  }

  /**
   * Copy an object, offset by `offset`. Duplicating an instance makes another
   * instance of the same prototype; duplicating a definition copies it. The
   * copy goes beside the original in whatever holds it, or into the
   * container if nothing does.
   */
  duplicateObject(key, { offset = [1, 0, 0], name } = {}) {
    const copyKey = name ?? this.uniqueName(key);
    const result = this.edit(`Duplicate ${key}`, (spec) => {
      const source = spec.objects?.[key];
      if (source === undefined) throw new Error(`no object "${key}"`);
      this.#checkNewName(copyKey);
      let copy;
      if (isUseBody(source)) copy = { use: source.use };
      else copy = clone(source);
      if (isObject(copy)) copy.translate = add3(source.translate ?? ZERO, offset);
      spec.objects[copyKey] = copy;

      const beside = this.referencesTo(key).find((r) => !r.isBody && Array.isArray(r.parent));
      if (beside) beside.parent.splice(Number(beside.slot) + 1, 0, copyKey);
      else this.#placeIn(spec, copyKey, this.containerKey);
    });
    if (result.ok) this.select(copyKey);
    return { ...result, name: copyKey };
  }

  /**
   * Rename an object, rewriting every reference to it. Keys are identities,
   * so this is the one operation that has to touch the whole spec.
   */
  renameObject(from, to) {
    const previous = this.#selected;
    const result = this.edit(`Rename ${from} to ${to}`, (spec) => {
      if (!this.has(from)) throw new Error(`no object "${from}"`);
      this.#checkNewName(to);
      for (const ref of this.referencesTo(from)) {
        if (typeof ref.def === 'string') ref.parent[ref.slot] = to;
        else ref.def.use = to;
      }
      // Rebuilt rather than reassigned, so the object keeps its position.
      spec.objects = Object.fromEntries(
        Object.entries(spec.objects).map(([k, v]) => [k === from ? to : k, v]));
      // Before edit() validates, or the selection would be dropped as gone.
      this.#selected = this.#selected.map((e) => (e.owner === from ? { ...e, owner: to } : e));
    });
    if (!result.ok) this.#selected = previous;
    return result;
  }

  /**
   * Give an instance its own copy of its definition, so it can be edited
   * without changing the others. Any translates picked up along the
   * instancing chain are folded into the instance, so it doesn't move.
   * Returns the new definition's key in `name`.
   */
  makeUnique(instanceKey, { name } = {}) {
    let definitionKey = null;
    const result = this.edit(`Make ${instanceKey} unique`, (spec) => {
      if (!this.isInstance(instanceKey)) throw new Error(`"${instanceKey}" is not an instance`);
      let offset = [...ZERO];
      let key = instanceKey;
      for (let n = 0; isUseBody(spec.objects[key]); n++) {
        if (n >= MAX_CHAIN) throw new Error('instancing chain too deep');
        offset = add3(offset, spec.objects[key].translate ?? ZERO);
        key = spec.objects[key].use;
      }
      definitionKey = name ?? this.uniqueName(`${instanceKey}-proto`);
      this.#checkNewName(definitionKey);
      spec.objects[definitionKey] = clone(spec.objects[key]);
      const body = { use: definitionKey };
      if (offset.some((v) => v !== 0)) body.translate = offset;
      spec.objects[instanceKey] = body;
    });
    return { ...result, name: definitionKey };
  }

  /**
   * Turn a subtree into a named object, leaving a reference where it was. It
   * renders identically — a reference expands in place — but can now be
   * selected, instanced and renamed as an object.
   */
  promote(owner, path, name) {
    const result = this.edit(`Promote to ${name}`, (spec) => {
      if (!path) {
        throw new Error(owner === ROOT ? 'the whole root cannot be promoted'
                                       : `"${owner}" is already an object`);
      }
      const found = this.resolve(owner, path);
      if (!found) throw new Error(`nothing at ${owner}/${path}`);
      if (found.node === 'empty') throw new Error('there is nothing there to promote');
      if (refName(found.node)) throw new Error('that is already a reference to an object');
      this.#checkNewName(name);
      (spec.objects ??= {})[name] = found.node;
      found.parent[found.slot] = Array.isArray(found.parent) ? name : { use: name };
    });
    if (result.ok) this.select(name);
    return result;
  }

  /**
   * Edit a node in place: `mutate(node, found)` changes it. Through an
   * instance this edits the prototype. Pass a coalesce key for drags.
   */
  editNode(owner, path, mutate, { label, coalesce = null } = {}) {
    return this.edit(label ?? `Edit ${owner}${path ? '/' + path : ''}`, () => {
      const found = this.resolve(owner, path);
      if (!found) throw new Error(`nothing at ${owner}/${path}`);
      if (!isObject(found.node)) throw new Error('that node has no properties to edit');
      mutate(found.node, found);
    }, { coalesce });
  }

  // -- lights and materials ------------------------------------------------------

  /** Change a light. Consecutive edits to the same light coalesce by default. */
  setLight(index, patch, { coalesce } = {}) {
    return this.edit(`Edit light ${index}`, (spec) => {
      const light = spec.lights?.[index];
      if (!light) throw new Error(`no light ${index}`);
      for (const [k, v] of Object.entries(patch)) light[k] = Array.isArray(v) ? v.slice() : v;
    }, { kind: 'lights', coalesce: coalesce === undefined ? `light:${index}` : coalesce });
  }

  addLight(light = { pos: [2, -2, 3], color: [20, 20, 20] }) {
    return this.edit('Add light', (spec) => {
      (spec.lights ??= []).push(clone(light));
    }, { kind: 'lights' });
  }

  removeLight(index) {
    return this.edit(`Remove light ${index}`, (spec) => {
      if (!spec.lights?.[index]) throw new Error(`no light ${index}`);
      spec.lights.splice(index, 1);
    }, { kind: 'lights' });
  }

  /** Change a material. Consecutive edits to the same material coalesce by default. */
  setMaterial(name, patch, { coalesce } = {}) {
    return this.edit(`Edit material ${name}`, (spec) => {
      const material = spec.materials?.[name];
      if (!material) throw new Error(`no material "${name}"`);
      for (const [k, v] of Object.entries(patch)) material[k] = Array.isArray(v) ? v.slice() : v;
    }, { kind: 'materials', coalesce: coalesce === undefined ? `material:${name}` : coalesce });
  }
}
