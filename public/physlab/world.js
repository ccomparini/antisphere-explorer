// The things in physlab's world, and the scene they make.
//
// An object has a position and an orientation, and may have geometry. The
// geometry is a scene subtree (scene-format.md) in the object's own
// coordinates; sceneSpec() places each one by its object's orientation and
// position to make the scene the renderer draws. An object without
// geometry - a camera's mount, a marker - is simply not in the scene.
//
// Time moves by World.update(dt), once per rendered frame (physlab.js
// hooks it to ASContext.onFrame, which runs before each frame is drawn).
// It gives every object its own update(dt, world). An object's behaviour is
// either an `update` function given when it is made, or a subclass's
// update(); by default an object does nothing.
//
// When an object with geometry moves, the scene has to follow. sceneSpec()
// remembers where everything with geometry was, and which geometry it had;
// geometryMoved() says whether any of it has moved, changed shape (by
// setGeometry) or appeared since. For now following means
// rebuilding the scene; moving objects' nodes in place comes later (see
// DESIGN.md, "Moving objects").

import { identity, normalize, axes, toAxisAngle } from './quat.js';

export class WorldObject {
  /**
   * @param {string} name  unique in its world; also the scene object's key
   * @param {object} [opts]
   * @param {number[]} [opts.position]     [x, y, z], meters
   * @param {number[]} [opts.orientation]  quaternion [x, y, z, w] (see quat.js)
   * @param {object|null} [opts.geometry]  scene subtree, in object coordinates
   * @param {(object: WorldObject, dt: number, world: World) => void} [opts.update]
   *   what the object does as time passes; dt in seconds
   * @param {object|null} [opts.body]  makes it a simulated body (physics-world.js):
   *   { mass, centre, inertia, radius, friction?, compliance? } - its centre of
   *   mass on its local +Y, its inertia across that axis per unit mass, and
   *   how far its geometry reaches from its origin. Its body's axis is its
   *   +Y; any shape will do, but its roll about that axis is carried, not
   *   simulated (see physics.js).
   */
  constructor(name, { position = [0, 0, 0], orientation = identity(), geometry = null,
                      update = null, body = null } = {}) {
    this.name = name;
    // One array for the object's whole life: moving it writes into this, so
    // anything holding a reference to it (a camera's look-at point, say)
    // follows. Use setPosition rather than assigning a new array.
    this.position = position.slice();
    this.orientation = normalize(orientation);
    this.geometry = geometry;
    this.geometryVersion = 0;     // bumped by setGeometry, so the scene follows
    this.behaviour = update;
    this.body = body;
  }

  /** Advance this object by dt seconds. Subclasses may override. */
  update(dt, world) {
    if (this.behaviour) this.behaviour(this, dt, world);
  }

  setPosition(p) {
    this.position[0] = p[0];
    this.position[1] = p[1];
    this.position[2] = p[2];
  }

  /**
   * Give the object new geometry (a scene subtree, in object coordinates).
   * Pass a new object rather than editing the old one in place: the
   * physics caches each geometry's compiled solid by identity.
   */
  setGeometry(geometry) {
    this.geometry = geometry;
    this.geometryVersion++;
  }

  /** The object's own x, y and z axes, as world directions. */
  axes() { return axes(this.orientation); }
}

export class World {
  constructor() {
    this.objects = [];
    this._built = null;           // poses at the last sceneSpec(), by object name
  }

  /**
   * Advance everything by dt seconds: once per rendered frame, with the
   * time since the last. This is also where fixed-size physics steps will
   * run, as many as dt calls for, since they need all the objects at once.
   */
  update(dt) {
    for (const o of this.objects) o.update(dt, this);
  }

  add(object) {
    if (this.objects.some((o) => o.name === object.name)) {
      throw new Error(`the world already has an object called "${object.name}"`);
    }
    this.objects.push(object);
    return object;
  }

  /**
   * A scene spec of every object with geometry, each placed where its object
   * is: defined once under its own name, in object coordinates, then used
   * with its orientation as `rotate` and its position as `translate`
   * (scene-format.md applies rotate before translate, which is what
   * placing it wants).
   *
   * @param {object} [surroundings]  { materials, lights }, which aren't objects (yet)
   * @param {object} [opts]
   * @param {(o: WorldObject) => ({ center, radius }|null)} [opts.bounds]
   *   Makes the root a group (scene-format.md) instead of a
   *   union, with each object's bounds from this where it gives one. The
   *   compiled scene's overlaps then say which objects may touch; their
   *   members index placed(), the objects in the scene at this call.
   */
  sceneSpec({ materials = {}, lights = [] } = {}, { bounds = null } = {}) {
    const placed = this.objects.filter((o) => o.geometry);
    if (!placed.length) throw new Error('no object in the world has any geometry to draw');
    this._built = this._poses();
    this._placed = placed;

    const objects = {};
    const uses = placed.map((o) => {
      objects[o.name] = o.geometry;
      const use = { use: o.name };
      const { axis, radians } = toAxisAngle(o.orientation);
      if (radians !== 0) use.rotate = { axis, radians };
      if (o.position.some((v) => v !== 0)) use.translate = o.position.slice();
      const b = bounds?.(o);
      if (b) use.bounds = b;
      return use;
    });
    let root = uses.length === 1 ? uses[0] : { union: uses };
    if (bounds) root = { group: uses };
    return { materials, lights, objects, root };
  }

  /** The objects in the scene as of the last sceneSpec(), in its order. */
  placed() { return this._placed ?? []; }

  /**
   * The pairs of objects a compiled scene says may touch: its root
   * group's overlaps (sceneSpec with bounds), as [object, object].
   */
  overlappingPairs(overlaps) {
    const placed = this.placed();
    return overlaps.filter((o) => o.group === 'root').map(({ members: [i, j] }) => [placed[i], placed[j]]);
  }

  /** Has anything with geometry moved, turned, changed shape or appeared since the last sceneSpec()? */
  geometryMoved() {
    const now = this._poses();
    if (!this._built || now.size !== this._built.size) return true;
    for (const [name, pose] of now) if (this._built.get(name) !== pose) return true;
    return false;
  }

  _poses() {
    return new Map(this.objects.filter((o) => o.geometry)
      .map((o) => [o.name, `${o.position.join()}|${o.orientation.join()}|${o.geometryVersion}`]));
  }
}
