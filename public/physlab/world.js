// The things in physlab's world, and the scene they make.
//
// An object has a position and an orientation, and may have geometry. The
// geometry is a scene subtree (scene-format.md) in the object's own
// coordinates; sceneSpec() places each one by its object's orientation and
// position to make the scene the renderer draws. An object without
// geometry - a camera's mount, a marker - is simply not in the scene.

import { identity, normalize, axes, toAxisAngle } from './quat.js';

export class WorldObject {
  /**
   * @param {string} name  unique in its world; also the scene object's key
   * @param {object} [opts]
   * @param {number[]} [opts.position]     [x, y, z], meters
   * @param {number[]} [opts.orientation]  quaternion [x, y, z, w] (see quat.js)
   * @param {object|null} [opts.geometry]  scene subtree, in object coordinates
   */
  constructor(name, { position = [0, 0, 0], orientation = identity(), geometry = null } = {}) {
    this.name = name;
    // One array for the object's whole life: moving it writes into this, so
    // anything holding a reference to it (a camera's look-at point, say)
    // follows. Use setPosition rather than assigning a new array.
    this.position = position.slice();
    this.orientation = normalize(orientation);
    this.geometry = geometry;
  }

  setPosition(p) {
    this.position[0] = p[0];
    this.position[1] = p[1];
    this.position[2] = p[2];
  }

  /** The object's own x, y and z axes, as world directions. */
  axes() { return axes(this.orientation); }
}

export class World {
  constructor() {
    this.objects = [];
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
   */
  sceneSpec({ materials = {}, lights = [] } = {}) {
    const placed = this.objects.filter((o) => o.geometry);
    if (!placed.length) throw new Error('no object in the world has any geometry to draw');

    const objects = {};
    const uses = placed.map((o) => {
      objects[o.name] = o.geometry;
      const use = { use: o.name };
      const { axis, radians } = toAxisAngle(o.orientation);
      if (radians !== 0) use.rotate = { axis, radians };
      if (o.position.some((v) => v !== 0)) use.translate = o.position.slice();
      return use;
    });
    return {
      materials,
      lights,
      objects,
      root: uses.length === 1 ? uses[0] : { union: uses },
    };
  }
}
