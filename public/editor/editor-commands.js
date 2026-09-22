// Editor commands: the things a user can ask for, by name.
//
// Panel buttons (data-action) and keyboard shortcuts both run these, so a
// command behaves the same however it's invoked. Commands that change the
// scene go through the SceneDocument, which makes them undoable and reports
// failures; this file only decides what to ask for and tells the user when
// there's nothing to do.
//
// Commands that need the page — files, cameras — are supplied by editor.js
// as `extra`, so this file stays free of DOM and GPU and can be tested
// under node.

import { ROOT } from './scene-document.js';

// New objects are built at the origin of their own frame and placed with
// `translate`, so moving one later is a single field, and the gizmos will
// have one thing to drag.

const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** A cube of half-width `half`: six planes, each nested inside the last. */
export function boxDef(half, material) {
  let node;
  for (const normal of [...FACES].reverse()) {
    const face = { plane: { normal, offset: half } };
    if (node) face.inside = node;        // the innermost face's inside is solid
    node = face;
  }
  if (material) node.material = material;
  return node;
}

export function sphereDef(radius, material) {
  const def = { sphere: { center: [0, 0, 0], radius } };
  if (material) def.material = material;
  return def;
}

// A material that makes a new object visible: something shaded, preferring a
// plain one over a patterned floor.
export function pickMaterial(spec) {
  const entries = Object.entries(spec.materials ?? {});
  const shaded = ([, m]) => ['lambert', 'glossy'].includes(m.kind ?? 'lambert');
  const plain = entries.find((e) => shaded(e) && e[1].pattern !== 'checker');
  return (plain ?? entries.find(shaded))?.[0] ?? null;
}

/**
 * @param {object} ctx
 * @param {SceneDocument} ctx.doc
 * @param {() => object} ctx.getActive   the focused view, for where to put new things
 * @param {(text:string, bad?:boolean) => void} ctx.note
 * @param {(question:string, suggestion:string) => string|null} [ctx.ask]
 * @param {object} [ctx.extra]   page-level commands merged into the table
 */
export function createCommands({ doc, getActive, note, ask = globalThis.prompt, extra = {} }) {
  // Failures are already recorded on the document; this makes them visible
  // at the moment the user acted.
  const report = (result, success) => {
    if (!result.ok) note(result.error, true);
    else if (success) note(success);
    return result.ok;
  };

  const selectedObject = () => {
    const { owner, path } = doc.selection;
    return owner && owner !== ROOT && !path ? owner : null;
  };

  // New objects land where the focused camera is looking.
  const placement = () => getActive?.()?.camera?.target?.slice() ?? [0, 0, 0.5];

  function ensureMaterial() {
    const existing = pickMaterial(doc.spec);
    if (existing) return existing;
    let name = 'clay';
    for (let i = 2; doc.spec.materials?.[name]; i++) name = `clay-${i}`;
    doc.edit('Add material', (spec) => {
      (spec.materials ??= {})[name] = { albedo: [0.72, 0.55, 0.45] };
    }, { kind: 'materials' });
    return name;
  }

  function create(kind) {
    const material = ensureMaterial();
    const def = kind === 'box' ? boxDef(0.5, material) : sphereDef(0.5, material);
    def.translate = placement();
    const result = doc.createObject(def, { base: kind });
    report(result, result.ok && `created ${result.name}`);
  }

  return {
    undo() { if (!doc.undo()) note('nothing to undo'); },
    redo() { if (!doc.redo()) note('nothing to redo'); },
    deselect() { doc.clearSelection(); },

    'create-sphere': () => create('sphere'),
    'create-box': () => create('box'),

    delete() {
      const { owner, path } = doc.selection;
      if (!owner) { note('nothing selected'); return; }
      if (owner === ROOT && !path) { note('the root cannot be deleted', true); return; }
      report(path ? doc.deleteNode(owner, path) : doc.deleteObject(owner));
    },

    duplicate() {
      const key = selectedObject();
      if (!key) { note('select an object to duplicate'); return; }
      const result = doc.duplicateObject(key, { offset: [1.25, 0, 0] });
      report(result, result.ok && `duplicated as ${result.name}`);
    },

    rename() {
      const key = selectedObject();
      if (!key) { note('select an object to rename'); return; }
      const to = ask('Rename object', key)?.trim();
      if (to && to !== key) report(doc.renameObject(key, to), `renamed to ${to}`);
    },

    'make-unique'() {
      const { owner } = doc.selection;
      if (!owner || !doc.isInstance(owner)) { note('select an instance'); return; }
      const result = doc.makeUnique(owner);
      report(result, result.ok && `${owner} now has its own definition, ${result.name}`);
    },

    promote() {
      const { owner, path } = doc.selection;
      if (!owner || !path) { note('select a part of an object to name it'); return; }
      const name = ask('Name for the new object', doc.uniqueName('part'))?.trim();
      if (name) report(doc.promote(owner, path, name), `named ${name}`);
    },

    ...extra,
  };
}
