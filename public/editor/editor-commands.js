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

// ---------------------------------------------------------------------------
// The shapes the editor can make
//
// Each is built at the origin of its own frame and placed with `translate`,
// so moving one later is a single field - and so the gizmos will have one
// thing to drag.
//
// Most of these shapes run off along their axis on their own, so they are cut
// to size by nesting a slab in the primitive's `inside`: the region is then
// "inside the shape and inside the slab", which is two nodes rather than the
// several an `intersect` would fold out to.
//
// Sizes are around a unit: big enough to see, small enough not to swallow
// whatever is already there.
// ---------------------------------------------------------------------------

const UP = [0, 0, 1];

/** Cap a shape to `height` along its axis, by nesting a slab inside it. */
function capped(def, height, material) {
  const shape = { ...def, material };
  shape.inside = { slab: { center: [0, 0, 0], axis: UP, thickness: height } };
  return shape;
}

export const SHAPES = {
  sphere: {
    label: 'Sphere',
    make: (material) => ({ sphere: { center: [0, 0, 0], radius: 0.5 }, material }),
  },

  // Three slabs, one per axis, each nested in the last: a box is the region
  // inside all three. Six planes would say the same thing with twice the
  // nodes, since a slab is already a pair of parallel faces.
  box: {
    label: 'Box',
    make: (material, size = [1, 1, 1]) => ({
      slab: { center: [0, 0, 0], axis: [1, 0, 0], thickness: size[0] },
      material,
      inside: {
        slab: { center: [0, 0, 0], axis: [0, 1, 0], thickness: size[1] },
        inside: { slab: { center: [0, 0, 0], axis: UP, thickness: size[2] } },
      },
    }),
  },

  cylinder: {
    label: 'Cylinder',
    make: (material) =>
      capped({ cylinder: { center: [0, 0, 0], axis: UP, radius: 0.4 } }, 1.2, material),
  },

  cone: {
    label: 'Cone',
    make: (material) =>
      // Apex at the top of the cap, so the cap leaves one cone rather than
      // two: the other nappe is above the apex and gets cut away.
      capped({ cone: { apex: [0, 0, 0.6], axis: UP, slope: 0.5 } }, 1.2, material),
  },

  spheroid: {
    label: 'Spheroid',
    make: (material) => ({
      spheroid: { center: [0, 0, 0], axis: UP, height: 1.2, radius: 0.4 }, material,
    }),
  },

  paraboloid: {
    label: 'Paraboloid',
    make: (material) =>
      capped({ paraboloid: { vertex: [0, 0, -0.6], axis: UP, focal: 0.12 } }, 1.2, material),
  },

  hyperboloid: {
    label: 'Hyperboloid',
    make: (material) =>
      capped({ hyperboloid: { center: [0, 0, 0], axis: UP, radius: 0.3, slope: 0.6 } },
             1.2, material),
  },

  // The two that do not end: a plate and a half-space. Both go in the
  // editor's union container, which asks nothing of its members' bounds.
  slab: {
    label: 'Slab',
    make: (material) => ({ slab: { center: [0, 0, 0], axis: UP, thickness: 0.3 }, material }),
  },

  // Everything below where it is placed. That is a lot of solid at once, but
  // the axis views show plainly what happened, and undo is one key away.
  // Inside a plane is the side its normal points away from, so a normal of
  // +z gives ground rather than sky.
  plane: {
    label: 'Plane',
    make: (material) => ({ plane: { normal: UP, offset: 0 }, material }),
  },
};

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

  // Every selected object, as keys.
  const selectedObjects = () =>
    doc.selections.filter((e) => !e.path && e.owner !== ROOT).map((e) => e.owner);

  // Deepest and last first, so removing one can't shift the address of
  // another still to go: group and union members are addressed by index.
  function deepestFirst(a, b) {
    const A = a.path.split('/'), B = b.path.split('/');
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      if (A[i] === B[i]) continue;
      if (A[i] === undefined) return 1;
      if (B[i] === undefined) return -1;
      const x = Number(A[i]), y = Number(B[i]);
      if (Number.isInteger(x) && Number.isInteger(y)) return y - x;
      return A[i] < B[i] ? 1 : -1;
    }
    return 0;
  }

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

  function create(shape) {
    const known = SHAPES[shape];
    if (!known) { note(`no such shape: ${shape}`, true); return; }
    const def = known.make(ensureMaterial());
    def.translate = placement();
    const result = doc.createObject(def, { base: shape });
    report(result, result.ok && `created ${result.name}`);
  }

  return {
    undo() { if (!doc.undo()) note('nothing to undo'); },
    redo() { if (!doc.redo()) note('nothing to redo'); },
    deselect() { doc.clearSelection(); },

    // One command for every shape; the panel passes the name.
    create,

    // Deletes everything selected, as one undo step: if any part of it is
    // refused, none of it happens.
    delete() {
      const entries = doc.selections;
      if (!entries.length) { note('nothing selected'); return; }
      if (entries.some((e) => e.owner === ROOT && !e.path)) {
        note('the root cannot be deleted', true);
        return;
      }
      const objects = selectedObjects();
      // A node inside an object that is going anyway needs no deleting.
      const nodes = entries.filter((e) => e.path && !objects.includes(e.owner))
                           .sort(deepestFirst);

      const label = entries.length === 1
        ? `Delete ${entries[0].owner}${entries[0].path ? '/' + entries[0].path : ''}`
        : `Delete ${entries.length} things`;

      report(doc.transaction(label, () => {
        for (const entry of nodes) {
          // An earlier deletion may have taken this one with it.
          if (doc.resolve(entry.owner, entry.path)) doc.deleteNode(entry.owner, entry.path);
        }
        // A prototype can't go while its instances remain, so take whatever
        // has no instances left, round by round. If a round can't make
        // progress, let deleteObject refuse with its own message.
        let remaining = [...objects];
        while (remaining.length) {
          const ready = remaining.filter((key) => doc.instancesOf(key).length === 0);
          if (!ready.length) { doc.deleteObject(remaining[0]); break; }
          for (const key of ready) doc.deleteObject(key);
          remaining = remaining.filter((key) => !ready.includes(key));
        }
      }));
    },

    duplicate() {
      const keys = selectedObjects();
      if (!keys.length) { note('select an object to duplicate'); return; }
      const copies = [];
      const label = keys.length === 1 ? `Duplicate ${keys[0]}` : `Duplicate ${keys.length} objects`;
      const result = doc.transaction(label, () => {
        for (const key of keys) copies.push(doc.duplicateObject(key, { offset: [1.25, 0, 0] }).name);
      });
      if (!report(result, `duplicated as ${copies.join(', ')}`)) return;
      // Leave the copies selected, so a second duplicate walks along.
      doc.select(copies[0]);
      for (const name of copies.slice(1)) doc.addToSelection(name);
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
