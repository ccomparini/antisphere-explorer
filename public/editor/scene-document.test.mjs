// Tests for SceneDocument. Run from this directory with:
//   node --test scene-document.test.mjs
//
// The fake scene below stands in for ASScene. It applies the handful of
// compiler rules these tests lean on, so a document that would fail to
// compile fails here too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SceneDocument, ROOT } from './scene-document.js';

function validate(spec) {
  const objects = spec.objects ?? {};
  const check = (def, where) => {
    if (!def) return;                    // null: no further subdivision
    if (typeof def === 'string') {
      if (!(def in objects)) throw new Error(`${where}: unknown object "${def}"`);
      return;
    }
    if (def.use !== undefined) {
      if (!(def.use in objects)) throw new Error(`${where}: unknown object "${def.use}"`);
      return;
    }
    for (const op of ['group', 'union', 'intersect', 'difference']) {
      if (def[op] !== undefined) {
        if (!def[op].length) throw new Error(`${where}: ${op} needs at least one operand`);
        def[op].forEach((m, i) => check(m, `${where}.${op}[${i}]`));
        return;
      }
    }
    if (!def.sphere && !def.plane) throw new Error(`${where}: needs a sphere or plane`);
    if (def.sphere && !(def.sphere.radius > 0)) throw new Error(`${where}: radius must be positive`);
    for (const side of ['inside', 'outside']) {
      if (def[side] !== undefined) check(def[side], `${where}.${side}`);
    }
  };
  check(spec.root, 'root');
  for (const [key, def] of Object.entries(objects)) check(def, `objects.${key}`);
}

function fakeScene() {
  return {
    compiles: 0, lightWrites: 0, lights: [], spec: null,
    update(spec) { validate(spec); this.compiles++; this.spec = spec; this.lights = spec.lights ?? []; },
    setLights(lights) { this.lightWrites++; this.lights = lights; },
  };
}

const baseSpec = () => ({
  materials: { clay: { albedo: [0.7, 0.5, 0.4] } },
  lights: [{ pos: [0, 0, 5], color: [10, 10, 10] }],
  objects: {
    bead: {
      sphere: { center: [0, 0, 0], radius: 1 }, material: 'clay',
      inside: { sphere: { center: [0.5, 0, 0], radius: 0.4 }, complement: true },
    },
    'bead-1': { use: 'bead', translate: [3, 0, 0] },
    'bead-2': { use: 'bead', translate: [-3, 0, 0] },
    lamp: { sphere: { center: [0, 0, 0], radius: 0.2 }, translate: [0, 5, 0] },
  },
  root: {
    sphere: { center: [0, 0, 0], radius: 40 },
    inside: { union: ['bead-1', 'bead-2', 'lamp'] },
  },
});

// A document with a controllable clock, so coalescing is deterministic.
function make(spec = baseSpec()) {
  const scene = fakeScene();
  scene.update(structuredClone(spec));
  let t = 0;
  const doc = new SceneDocument(scene, spec, { now: () => t });
  return { doc, scene, tick: (ms = 10) => { t += ms; } };
}

// -- transactions and history ----------------------------------------------------

test('an edit compiles, and undo and redo restore it', () => {
  const { doc, scene } = make();
  doc.setMaterial('clay', { albedo: [1, 0, 0] });
  assert.deepEqual(scene.spec.materials.clay.albedo, [1, 0, 0]);
  assert.ok(doc.undo());
  assert.deepEqual(doc.spec.materials.clay.albedo, [0.7, 0.5, 0.4]);
  assert.deepEqual(scene.spec.materials.clay.albedo, [0.7, 0.5, 0.4]);
  assert.ok(doc.redo());
  assert.deepEqual(scene.spec.materials.clay.albedo, [1, 0, 0]);
});

test('a failed edit rolls back, reports, and records nothing', () => {
  const { doc, scene } = make();
  const compiles = scene.compiles;
  const r = doc.editNode('lamp', '', (node) => { node.sphere.radius = -1; });
  assert.equal(r.ok, false);
  assert.match(r.error, /radius must be positive/);
  assert.equal(doc.spec.objects.lamp.sphere.radius, 0.2);
  assert.equal(doc.canUndo, false);
  assert.equal(doc.error, r.error);
  assert.equal(scene.compiles, compiles);        // the rejected compile never landed
});

test('light drags take the cheap path and coalesce into one undo step', () => {
  const { doc, scene, tick } = make();
  const compiles = scene.compiles;
  for (let i = 1; i <= 50; i++) { doc.setLight(0, { pos: [i, 0, 5] }); tick(); }
  assert.equal(scene.lightWrites, 50);
  assert.equal(scene.compiles, compiles);
  assert.equal(doc.undoLabel, 'Edit light 0');
  doc.undo();
  assert.deepEqual(doc.spec.lights[0].pos, [0, 0, 5]);
  assert.equal(doc.canUndo, false);
});

test('coalescing stops at endCoalesce, a pause, or a different key', () => {
  const { doc, tick } = make();
  const steps = () => { let n = 0; while (doc.canUndo) { doc.undo(); n++; } return n; };

  doc.setLight(0, { pos: [1, 0, 5] }); tick();
  doc.setLight(0, { pos: [2, 0, 5] }); tick();
  doc.endCoalesce();
  doc.setLight(0, { pos: [3, 0, 5] }); tick(5000);   // a pause
  doc.setLight(0, { pos: [4, 0, 5] }); tick();
  doc.setMaterial('clay', { albedo: [0, 1, 0] });
  assert.equal(steps(), 4);
});

test('adding or removing a light recompiles', () => {
  const { doc, scene } = make();
  const compiles = scene.compiles;
  doc.addLight();
  assert.equal(scene.compiles, compiles + 1);
  assert.equal(scene.lights.length, 2);
  doc.removeLight(0);
  assert.equal(scene.lights.length, 1);
});

test('dirty follows the saved state through edits and undo', () => {
  const { doc } = make();
  assert.equal(doc.dirty, false);
  doc.setMaterial('clay', { albedo: [1, 0, 0] });
  assert.equal(doc.dirty, true);
  doc.markSaved();
  assert.equal(doc.dirty, false);
  doc.undo();
  assert.equal(doc.dirty, true);
  doc.redo();
  assert.equal(doc.dirty, false);
});

test('a coalesced edit after saving still counts as a change', () => {
  const { doc, tick } = make();
  doc.setLight(0, { pos: [1, 0, 5] }); tick();
  doc.markSaved();
  doc.setLight(0, { pos: [2, 0, 5] }); tick();     // merges into the saved step
  assert.equal(doc.dirty, true);
});

test('history is capped', () => {
  const scene = fakeScene();
  const spec = baseSpec();
  scene.update(structuredClone(spec));
  const doc = new SceneDocument(scene, spec, { historyLimit: 5 });
  for (let i = 0; i < 20; i++) doc.setMaterial('clay', { albedo: [i / 20, 0, 0] }, { coalesce: null });
  let n = 0;
  while (doc.canUndo) { doc.undo(); n++; }
  assert.equal(n, 4);
});

test('load replaces the document and clears history', () => {
  const { doc } = make();
  doc.setMaterial('clay', { albedo: [1, 0, 0] });
  const r = doc.load(baseSpec(), 'other.json');
  assert.equal(r.ok, true);
  assert.equal(doc.fileName, 'other.json');
  assert.equal(doc.canUndo, false);
  assert.equal(doc.dirty, false);
});

test('a bad load leaves the document alone', () => {
  const { doc } = make();
  const bad = baseSpec();
  bad.root.inside = { union: [] };
  const r = doc.load(bad, 'bad.json');
  assert.equal(r.ok, false);
  assert.notEqual(doc.fileName, 'bad.json');
  assert.deepEqual(doc.spec.root.inside.union, ['bead-1', 'bead-2', 'lamp']);
});

test('listeners hear edits and errors', () => {
  const { doc } = make();
  const heard = [];
  doc.onChange((c) => heard.push(c.kind));
  doc.setLight(0, { pos: [1, 1, 1] });
  doc.editNode('lamp', '', (n) => { n.sphere.radius = 0; });
  doc.select('lamp');
  doc.undo();
  assert.deepEqual(heard, ['lights', 'error', 'selection', 'undo']);
});

// -- selection and lookup ----------------------------------------------------------

test('a node inside an instance resolves in its prototype', () => {
  const { doc } = make();
  assert.ok(doc.select('bead-1', 'inside'));
  const found = doc.resolve('bead-1', 'inside');
  assert.equal(found.definitionKey, 'bead');
  assert.equal(found.node, doc.spec.objects.bead.inside);
  assert.equal(doc.select('bead-1', 'outside/nowhere'), false);
  assert.deepEqual(doc.selection, { owner: 'bead-1', path: 'inside' });
});

test('paths do not descend through a reference', () => {
  const { doc } = make();
  assert.ok(doc.resolve(ROOT, 'inside/union/0'));
  assert.equal(doc.resolve(ROOT, 'inside/union/0/inside'), null);
});

test('a node deleted to null no longer counts as selected', () => {
  const { doc } = make();
  doc.select('bead-1', 'inside');
  doc.deleteNode('bead-1', 'inside');
  assert.deepEqual(doc.selection, { owner: 'bead-1', path: '' });
  doc.deleteObject('bead-1');
  assert.deepEqual(doc.selection, { owner: null, path: '' });
});

test('instances and references are found', () => {
  const { doc } = make();
  assert.deepEqual(doc.instancesOf('bead').sort(), ['bead-1', 'bead-2']);
  assert.equal(doc.definitionKeyOf('bead-2'), 'bead');
  assert.equal(doc.isInstance('bead-1'), true);
  assert.equal(doc.isInstance('lamp'), false);
});

// -- frames ------------------------------------------------------------------------

test('world offsets combine placement, instancing and local translates', () => {
  const { doc } = make();
  assert.deepEqual(doc.worldOffset('bead-1'), [3, 0, 0]);
  assert.deepEqual(doc.worldOffset('bead-2', 'inside'), [-3, 0, 0]);
  assert.deepEqual(doc.worldOffset('lamp'), [0, 5, 0]);
  // The prototype itself is placed twice, through two instances.
  assert.equal(doc.worldOffset('bead'), null);

  // Moving the bite to a world position lands it in the prototype's frame.
  assert.deepEqual(doc.toLocal('bead-1', 'inside', [3.5, 1, 0]), [0.5, 1, 0]);
  assert.deepEqual(doc.toWorld('bead-2', 'inside', [0.5, 0, 0]), [-2.5, 0, 0]);
});

test('translates on the placement and inside the definition both count', () => {
  const spec = baseSpec();
  spec.root.inside = { union: [{ use: 'lamp', translate: [0, 0, 2] }, 'bead-1', 'bead-2'] };
  spec.objects.bead.inside.translate = [0, 0, 0.25];
  const { doc } = make(spec);
  assert.deepEqual(doc.worldOffset('lamp'), [0, 5, 2]);
  assert.deepEqual(doc.worldOffset('bead-1', 'inside'), [3, 0, 0.25]);
});

// -- operations ----------------------------------------------------------------------

test('editing through an instance edits the prototype', () => {
  const { doc } = make();
  doc.editNode('bead-1', 'inside', (n) => { n.sphere.radius = 0.6; });
  assert.equal(doc.resolve('bead-2', 'inside').node.sphere.radius, 0.6);
});

test('makeUnique splits one instance off, keeping its position', () => {
  const { doc } = make();
  const r = doc.makeUnique('bead-1');
  assert.equal(r.ok, true);
  assert.equal(r.name, 'bead-1-proto');
  assert.deepEqual(doc.spec.objects['bead-1'], { use: 'bead-1-proto', translate: [3, 0, 0] });
  doc.editNode('bead-1', 'inside', (n) => { n.sphere.radius = 0.6; });
  assert.equal(doc.resolve('bead-2', 'inside').node.sphere.radius, 0.4);
  assert.deepEqual(doc.worldOffset('bead-1', 'inside'), [3, 0, 0]);
});

test('makeUnique folds a chain of instances into one translate', () => {
  const spec = baseSpec();
  spec.objects['bead-1'] = { use: 'bead-2', translate: [0, 1, 0] };   // an instance of an instance
  spec.root.inside.union = ['bead-1', 'lamp'];
  const { doc } = make(spec);
  const before = doc.worldOffset('bead-1', 'inside');
  doc.makeUnique('bead-1');
  assert.deepEqual(doc.spec.objects['bead-1'].translate, [-3, 1, 0]);
  assert.deepEqual(doc.worldOffset('bead-1', 'inside'), before);
});

test('a prototype with instances cannot be deleted', () => {
  const { doc } = make();
  const r = doc.deleteObject('bead');
  assert.equal(r.ok, false);
  assert.match(r.error, /prototype of bead-1, bead-2/);
  assert.ok(doc.has('bead'));
});

test('deleting placements prunes emptied aggregates', () => {
  const { doc, scene } = make();
  doc.deleteObject('bead-1');
  assert.deepEqual(doc.spec.root.inside.union, ['bead-2', 'lamp']);
  doc.deleteObject('bead-2');
  doc.deleteObject('lamp');
  // The union is gone and the slot is explicitly null: no subdivision there.
  assert.equal(doc.spec.root.inside, null);
  assert.equal(scene.spec.root.inside, null);
  doc.undo(); doc.undo(); doc.undo();
  assert.deepEqual(doc.spec.root.inside.union, ['bead-1', 'bead-2', 'lamp']);
});

test('creating an object places it; deleting it leaves no trace', () => {
  const { doc } = make();
  const original = structuredClone(doc.spec);
  const r = doc.createObject({ sphere: { center: [0, 0, 1], radius: 0.5 } }, { base: 'ball' });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'ball');
  assert.deepEqual(doc.spec.objects['editor-objects'], { union: ['ball'] });
  assert.deepEqual(doc.spec.root.union[1], 'editor-objects');
  assert.deepEqual(doc.selection, { owner: 'ball', path: '' });

  const second = doc.createObject({ sphere: { center: [1, 0, 1], radius: 0.5 } }, { base: 'ball' });
  assert.equal(second.name, 'ball-2');
  assert.deepEqual(doc.spec.objects['editor-objects'].union, ['ball', 'ball-2']);

  doc.deleteObject('ball');
  doc.deleteObject('ball-2');
  assert.deepEqual(doc.spec, original);
});

test('names are checked', () => {
  const { doc } = make();
  for (const bad of ['lamp', '@thing', '']) {
    const r = doc.createObject({ sphere: { center: [0, 0, 0], radius: 1 } }, { name: bad });
    assert.equal(r.ok, false, `"${bad}" should be refused`);
  }
});

test('duplicating an instance makes another instance, beside the original', () => {
  const { doc } = make();
  const r = doc.duplicateObject('bead-1', { offset: [0, 2, 0] });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'bead-1-2');
  assert.deepEqual(doc.spec.objects['bead-1-2'], { use: 'bead', translate: [3, 2, 0] });
  assert.deepEqual(doc.spec.root.inside.union, ['bead-1', 'bead-1-2', 'bead-2', 'lamp']);
  assert.deepEqual(doc.instancesOf('bead').sort(), ['bead-1', 'bead-1-2', 'bead-2']);
});

test('duplicating a definition copies it', () => {
  const { doc } = make();
  const r = doc.duplicateObject('lamp', { offset: [1, 0, 0] });
  assert.deepEqual(doc.spec.objects[r.name].translate, [1, 5, 0]);
  doc.editNode(r.name, '', (n) => { n.sphere.radius = 0.3; });
  assert.equal(doc.spec.objects.lamp.sphere.radius, 0.2);
});

test('rename rewrites every reference, and the selection follows', () => {
  const { doc, scene } = make();
  doc.select('bead-1', 'inside');
  doc.renameObject('bead', 'pearl');
  assert.equal(doc.spec.objects['bead-1'].use, 'pearl');
  assert.equal(doc.spec.objects['bead-2'].use, 'pearl');
  doc.renameObject('bead-1', 'pearl-1');
  assert.deepEqual(doc.spec.root.inside.union, ['pearl-1', 'bead-2', 'lamp']);
  assert.deepEqual(doc.selection, { owner: 'pearl-1', path: 'inside' });
  assert.deepEqual(Object.keys(doc.spec.objects), ['pearl', 'pearl-1', 'bead-2', 'lamp']);
  assert.ok(scene.spec.objects.pearl);
});

test('a refused rename changes nothing', () => {
  const { doc } = make();
  doc.select('bead-1');
  const r = doc.renameObject('bead-1', 'lamp');
  assert.equal(r.ok, false);
  assert.deepEqual(doc.selection, { owner: 'bead-1', path: '' });
  assert.ok(doc.has('bead-1'));
});

test('promote names a subtree without changing the scene', () => {
  const { doc } = make();
  const r = doc.promote(ROOT, 'inside', 'contents');
  assert.equal(r.ok, true);
  assert.deepEqual(doc.spec.root.inside, { use: 'contents' });
  assert.deepEqual(doc.spec.objects.contents.union, ['bead-1', 'bead-2', 'lamp']);
  assert.deepEqual(doc.selection, { owner: 'contents', path: '' });

  // From inside a prototype, the new object is shared by every instance.
  doc.promote('bead-1', 'inside', 'bite');
  assert.deepEqual(doc.spec.objects.bead.inside, { use: 'bite' });

  assert.equal(doc.promote(ROOT, '', 'everything').ok, false);
  assert.equal(doc.promote(ROOT, 'inside', 'again').ok, false);   // already a reference
});

// -- multiple selection ------------------------------------------------------------

test('the selection is an ordered set whose last entry is primary', () => {
  const { doc } = make();
  doc.select('bead-1');
  doc.addToSelection('lamp');
  doc.addToSelection('bead-2', 'inside');
  assert.deepEqual(doc.selection, { owner: 'bead-2', path: 'inside' });
  assert.deepEqual(doc.selections.map((e) => e.owner), ['bead-1', 'lamp', 'bead-2']);
  assert.equal(doc.isSelected('lamp'), true);
  assert.equal(doc.isSelected('bead-2'), false);       // its node is selected, not it

  // Re-adding something already selected makes it primary rather than repeating it.
  doc.addToSelection('bead-1');
  assert.deepEqual(doc.selections.map((e) => e.owner), ['lamp', 'bead-2', 'bead-1']);

  // A plain select replaces the lot.
  doc.select('lamp');
  assert.deepEqual(doc.selections, [{ owner: 'lamp', path: '' }]);
  doc.clearSelection();
  assert.deepEqual(doc.selections, []);
  assert.deepEqual(doc.selection, { owner: null, path: '' });
});

test('adding something that does not exist changes nothing', () => {
  const { doc } = make();
  doc.select('lamp');
  assert.equal(doc.addToSelection('nope'), false);
  assert.equal(doc.addToSelection('lamp', 'inside/nowhere'), false);
  assert.deepEqual(doc.selections, [{ owner: 'lamp', path: '' }]);
});

test('a deletion prunes just the entries it removed', () => {
  const { doc } = make();
  doc.select('bead-1');
  doc.addToSelection('lamp');
  doc.deleteObject('lamp');
  assert.deepEqual(doc.selections, [{ owner: 'bead-1', path: '' }]);
});

test('entries trimmed to the same thing collapse, keeping the primary last', () => {
  const { doc } = make();
  doc.select('bead-1');              // the object
  doc.addToSelection('bead-1', 'inside');
  doc.deleteNode('bead-1', 'inside');   // trims the second entry to the object
  assert.deepEqual(doc.selections, [{ owner: 'bead-1', path: '' }]);
});

test('a transaction is one compile and one undo step', () => {
  const { doc, scene } = make();
  const compiles = scene.compiles;
  doc.transaction('Delete two beads', () => {
    doc.deleteObject('bead-1');
    doc.deleteObject('bead-2');
  });
  assert.equal(scene.compiles, compiles + 1);
  assert.deepEqual(doc.spec.root.inside.union, ['lamp']);
  assert.equal(doc.undoLabel, 'Delete two beads');
  doc.undo();
  assert.deepEqual(doc.spec.root.inside.union, ['bead-1', 'bead-2', 'lamp']);
});

test('a transaction that fails part way leaves nothing behind', () => {
  const { doc, scene } = make();
  const before = structuredClone(doc.spec);
  const compiles = scene.compiles;
  const r = doc.transaction('Delete two', () => {
    doc.deleteObject('lamp');
    doc.deleteObject('bead');        // refused: it still has instances
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /prototype of/);
  assert.deepEqual(doc.spec, before);
  assert.equal(scene.compiles, compiles);
  assert.equal(doc.canUndo, false);
});

test('a frame with a rotation or a scale in it is not just an offset', () => {
  const spec = baseSpec();
  spec.objects['bead-1'] = { use: 'bead', translate: [3, 0, 0],
                             rotate: { axis: [0, 0, 1], degrees: 30 } };
  spec.objects.lamp.scale = 2;
  spec.objects.tilted = { use: 'bead', translate: [0, 4, 0] };
  spec.root.inside.union = ['bead-1', 'bead-2', 'lamp', 'tilted'];
  const { doc } = make(spec);
  assert.equal(doc.worldOffset('bead-1', 'inside'), null);   // rotated instance
  assert.equal(doc.worldOffset('lamp'), null);               // scaled definition
  assert.deepEqual(doc.worldOffset('tilted'), [0, 4, 0]);    // still a plain offset
  assert.equal(doc.toLocal('bead-1', 'inside', [1, 2, 3]), null);
});

// -- combining objects ------------------------------------------------------------

test('combining takes up the operands and leaves them editable', () => {
  const { doc, scene } = make();
  const compiles = scene.compiles;
  const r = doc.combine('union', ['bead-1', 'lamp']);
  assert.equal(r.ok, true);
  assert.equal(r.name, 'union');

  // The combination is an object made of the two, which are still objects.
  assert.deepEqual(doc.spec.objects.union, { union: ['bead-1', 'lamp'] });
  assert.ok(doc.has('bead-1') && doc.has('lamp'));
  // Their own placements are gone: the combination places them now. The
  // root has been wrapped to hold the editor's container, as it is whenever
  // the first object is added, so the original tree is inside that.
  assert.deepEqual(doc.spec.root.union[0].inside.union, ['bead-2']);
  assert.deepEqual(doc.spec.objects['editor-objects'], { union: ['union'] });
  assert.deepEqual(doc.selection, { owner: 'union', path: '' });
  assert.equal(scene.compiles, compiles + 1, 'one compile, one undo step');

  doc.undo();
  assert.equal(doc.has('union'), false);
  assert.deepEqual(doc.spec.root.inside.union, ['bead-1', 'bead-2', 'lamp']);
});

test('difference keeps the first operand and cuts away the rest', () => {
  const { doc } = make();
  doc.combine('difference', ['bead-1', 'bead-2']);
  assert.deepEqual(doc.spec.objects.cut, { difference: ['bead-1', 'bead-2'] });
});

test('a part of a combination is still a part', () => {
  const { doc } = make();
  doc.combine('intersect', ['bead-1', 'lamp']);
  // Editing a part edits the combination, because it is the same object.
  doc.select('lamp');
  doc.editNode('lamp', '', (node) => { node.sphere.radius = 0.5; });
  assert.equal(doc.spec.objects.lamp.sphere.radius, 0.5);
  assert.deepEqual(doc.spec.objects.intersect.intersect, ['bead-1', 'lamp']);
});

test('combinations nest', () => {
  const { doc } = make();
  doc.combine('union', ['bead-1', 'bead-2']);
  doc.combine('difference', ['union', 'lamp']);
  assert.deepEqual(doc.spec.objects.cut, { difference: ['union', 'lamp'] });
  assert.deepEqual(doc.spec.objects['editor-objects'], { union: ['cut'] });
});

test('combining is refused where it would mean nothing', () => {
  const { doc } = make();
  assert.equal(doc.combine('union', ['lamp']).ok, false, 'one operand');
  assert.equal(doc.combine('union', ['lamp', 'nope']).ok, false, 'no such object');
  assert.throws(() => doc.combine('smoosh', ['lamp', 'bead-1']), /no such operation/);
  assert.ok(doc.has('lamp'), 'a refused combination changes nothing');
});

test('a part of a combination knows what it is part of', () => {
  const { doc } = make();
  doc.combine('union', ['bead-1', 'lamp']);
  assert.equal(doc.outermostOwner('bead-1'), 'union', 'a part reports the whole');
  assert.equal(doc.outermostOwner('union'), 'union', 'and the whole reports itself');

  // Nested combinations walk all the way up.
  doc.combine('difference', ['union', 'bead-2']);
  assert.equal(doc.outermostOwner('bead-1'), 'cut');
  assert.equal(doc.outermostOwner('cut'), 'cut');

  // A prototype used by several instances is not "part of" any one of them.
  assert.equal(doc.outermostOwner('bead'), 'bead');
});

// -- an object is its whole subtree -------------------------------------------------

// A robot with two named parts, placed twice.
const partsSpec = () => ({
  materials: { clay: {} },
  lights: [{ pos: [0, 0, 5], color: [10, 10, 10] }],
  objects: {
    arm: { sphere: { center: [1, 0, 0], radius: 0.4 }, material: 'clay' },
    leg: { sphere: { center: [0, 0, -1], radius: 0.4 }, material: 'clay' },
    robot: { union: ['arm', 'leg'] },
    'robot-1': { use: 'robot', translate: [3, 0, 0] },
    'robot-2': { use: 'robot', translate: [-3, 0, 0] },
  },
  root: { sphere: { center: [0, 0, 0], radius: 40 },
          inside: { union: ['robot-1', 'robot-2'] } },
});

test('reachableObjects finds the parts, and their parts', () => {
  const { doc } = make(partsSpec());
  assert.deepEqual([...doc.reachableObjects('robot')].sort(), ['arm', 'leg']);
  assert.deepEqual([...doc.reachableObjects('robot-1')].sort(), ['arm', 'leg', 'robot']);
  assert.deepEqual([...doc.reachableObjects('arm')], []);
});

test('makeUnique copies all the way down', () => {
  const { doc } = make(partsSpec());
  const r = doc.makeUnique('robot-2');
  assert.equal(r.ok, true);

  // The copy refers to copies of the parts, not to the originals.
  const copy = doc.spec.objects[r.name];
  assert.equal(copy.union.length, 2);
  assert.ok(!copy.union.includes('arm'), `still shares: ${JSON.stringify(copy)}`);
  for (const part of copy.union) assert.ok(doc.has(part), `${part} exists`);

  // Editing the copy's arm leaves the other robot's arm alone.
  const [armCopy] = copy.union;
  doc.editNode(armCopy, '', (node) => { node.sphere.radius = 9; });
  assert.equal(doc.spec.objects.arm.sphere.radius, 0.4, 'the original is untouched');
  assert.equal(doc.spec.objects[armCopy].sphere.radius, 9);

  // And robot-1 still works the way it did.
  assert.deepEqual(doc.spec.objects['robot-1'], { use: 'robot', translate: [3, 0, 0] });
  assert.deepEqual(doc.spec.objects['robot-2'], { use: r.name, translate: [-3, 0, 0] });
});

test('a copied subtree keeps its shape, however deep', () => {
  const spec = partsSpec();
  spec.objects.hand = { sphere: { center: [2, 0, 0], radius: 0.2 }, material: 'clay' };
  spec.objects.arm = { union: ['hand'] };
  const { doc } = make(spec);
  const r = doc.makeUnique('robot-2');
  const copy = doc.spec.objects[r.name];
  const [armCopy] = copy.union;
  const [handCopy] = doc.spec.objects[armCopy].union;
  assert.notEqual(armCopy, 'arm');
  assert.notEqual(handCopy, 'hand');
  assert.ok(doc.has(handCopy), 'the hand was copied too');
});

test('duplicating a definition copies its parts too', () => {
  const { doc } = make(partsSpec());
  // `robot` is a definition made of two parts; duplicate it.
  const r = doc.duplicateObject('robot', { offset: [0, 5, 0] });
  assert.equal(r.ok, true);
  const copy = doc.spec.objects[r.name];
  assert.ok(!copy.union.includes('arm'), `the copy shares a part: ${JSON.stringify(copy)}`);

  // Moving the copy's arm leaves the original's arm where it was.
  const [armCopy] = copy.union;
  doc.editNode(armCopy, '', (node) => { node.sphere.center = [7, 0, 0]; });
  assert.deepEqual(doc.spec.objects.arm.sphere.center, [1, 0, 0]);
});

test('duplicating an instance still shares the prototype', () => {
  const { doc } = make(partsSpec());
  const r = doc.duplicateObject('robot-1', { offset: [0, 5, 0] });
  assert.deepEqual(doc.spec.objects[r.name], { use: 'robot', translate: [3, 5, 0] });
  assert.deepEqual(doc.instancesOf('robot').sort(), ['robot-1', 'robot-2', r.name].sort());
});

test('deleting an object takes the parts that were only its', () => {
  const { doc } = make(partsSpec());
  // robot-1 and robot-2 both use `robot`, so neither can be deleted alone
  // without the other losing its parts: delete one instance first.
  doc.deleteObject('robot-1');
  assert.ok(doc.has('robot') && doc.has('arm'), 'robot-2 still needs them');

  doc.deleteObject('robot-2');
  assert.equal(doc.has('robot'), false, 'nothing refers to the prototype now');
  assert.equal(doc.has('arm'), false, 'nor to its parts');
  assert.equal(doc.has('leg'), false);
});

test('a part still used elsewhere survives the deletion', () => {
  const spec = partsSpec();
  // The arm is also placed in the scene in its own right.
  spec.root.inside.union.push('arm');
  const { doc } = make(spec);
  doc.deleteObject('robot-1');
  doc.deleteObject('robot-2');
  assert.equal(doc.has('robot'), false);
  assert.equal(doc.has('leg'), false, 'the leg was only the robot\'s');
  assert.ok(doc.has('arm'), 'the arm is placed in the scene too');
  assert.deepEqual(doc.spec.root.inside.union, ['arm']);
});

test('deleting one of a combination leaves the other alone', () => {
  const { doc } = make();
  doc.combine('union', ['bead-1', 'lamp']);
  doc.deleteObject('union');
  assert.equal(doc.has('union'), false);
  assert.equal(doc.has('lamp'), false, 'a part of it, used nowhere else');
  assert.ok(doc.has('bead'), 'the prototype behind bead-1 is still used by bead-2');
  assert.ok(doc.has('bead-2'));
});
