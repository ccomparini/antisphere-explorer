// ---------------------------------------------------------------------------
// Circular mazes
//
// A maze of concentric corridors round an open hub, as a scene subtree.
// The major walls are concentric rings between cylinders, as tall as the
// halls, with doorways cut through them by slabs; short radial walls, slabs
// too, cross the corridors. The tree is a spatial partition made of those
// very surfaces (see "geometry" below).
// Which doorways are open and which radial walls stand is a spanning tree
// over the maze's cells, grown at random from the hub by a seeded
// generator, so there is exactly one way between any two places, and the
// same seed always makes the same maze.
//
// Cells: corridor i, between ring walls i and i + 1, is cut into c_i
// cells. Ring 0 has `baseCells`; each ring outward doubles the count when
// its cells would otherwise be over twice as long as a hall is wide, so a
// cell's outward neighbours always lie wholly within its arc, and a
// doorway fits in any of them.
//
// No DOM: runs in node (tools/maze.mjs) and in the browser alike.
// ---------------------------------------------------------------------------

/** A seeded generator of numbers in [0, 1): mulberry32. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = 2 * Math.PI;
const dirOf = (a) => [Math.cos(a), Math.sin(a), 0];
const tangentOf = (a) => [-Math.sin(a), Math.cos(a), 0];
const at = (r, a, z) => [r * Math.cos(a), r * Math.sin(a), z];

/**
 * Generate a circular maze.
 *
 * Returns { tree, cells, passages, hub, exit, radius }:
 *   tree      a scene subtree - the walls, standing on z = 0 - to put
 *             under "objects" and place where it is wanted
 *   cells     [{ ring, index, angle0, angle1, center }], one per cell
 *   passages  [[a, b]], the open ways between cells, by index into cells;
 *             -1 is the hub
 *   openings  the walls opened for them, and for the exit: { ring, angle }
 *             a doorway through ring wall `ring` at `angle`, or
 *             { radial, angle } the radial wall in corridor `radial` at it
 *   hub       { center, radius }: the open middle
 *   exit      { angle }: where the way out is cut through the outer wall
 *   radius    the outer wall's outside
 *
 * `innerRadius` is the hub's, 1.25 hall widths by default. A doorway must
 * fit inside its cell where it goes through a wall, or this throws.
 *
 * `material` is the walls' faces (default "wall", which the scene must
 * define); `doorMaterial` the insides of the doorways, their jambs, and
 * `topMaterial` the tops, both `material` unless given. Each face is a node
 * of its own, so it shows its own. The dividers between them name none
 * (null), so a material around the maze would not reach in.
 */
export function circularMaze({
  seed = 1,
  rings = 5,
  hallWidth = 2.25,
  hallHeight = 2.5,
  wallThickness = 0.2,
  innerRadius = hallWidth * 1.25,
  baseCells = 6,
  doorWidth = hallWidth * 0.8,
  material,
  doorMaterial,
  topMaterial,
} = {}) {
  const random = seeded(seed);
  const t = wallThickness, h = hallHeight;
  // Ring wall i: from rho(i) out to rho(i) + t. Corridor i between walls
  // i and i + 1.
  const rho = (i) => innerRadius + i * (hallWidth + t);

  // -- cells and the graph ------------------------------------------------
  const counts = [baseCells];
  for (let i = 1; i < rings; i++) {
    const c = counts[i - 1];
    counts.push((TAU * (rho(i) + t)) / (2 * c) >= 2 * hallWidth ? 2 * c : c);
  }
  const cells = [], first = [];
  counts.forEach((c, ring) => {
    first.push(cells.length);
    const mid = (rho(ring) + t + rho(ring + 1)) / 2;
    for (let index = 0; index < c; index++) {
      const angle0 = (TAU * index) / c, angle1 = (TAU * (index + 1)) / c;
      cells.push({ ring, index, angle0, angle1, center: at(mid, (angle0 + angle1) / 2, h / 2) });
    }
  });
  const cellOf = (ring, index) => first[ring] + ((index % counts[ring]) + counts[ring]) % counts[ring];
  const middle = (k) => (cells[k].angle0 + cells[k].angle1) / 2;

  // Neighbours: -1 is the hub. Each edge says which wall it would open.
  const edges = new Map(cells.map((_, k) => [k, []]).concat([[-1, []]]));
  const link = (a, b, wall) => { edges.get(a).push({ to: b, wall }); edges.get(b).push({ to: a, wall }); };
  for (let j = 0; j < counts[0]; j++) link(-1, cellOf(0, j), { ring: 0, angle: middle(cellOf(0, j)) });
  cells.forEach((cell, k) => {
    // Round the corridor, across the radial wall at the cell's far end
    // (a corridor of one cell has no neighbour but itself).
    if (counts[cell.ring] > 1) {
      link(k, cellOf(cell.ring, cell.index + 1), { radial: cell.ring, angle: cell.angle1 });
    }
    // Outward, through the next ring wall, to each child.
    if (cell.ring + 1 < rings) {
      const ratio = counts[cell.ring + 1] / counts[cell.ring];
      for (let c = 0; c < ratio; c++) {
        const child = cellOf(cell.ring + 1, cell.index * ratio + c);
        link(k, child, { ring: cell.ring + 1, angle: middle(child) });
      }
    }
  });

  // Every doorway has to fit inside its cell where it goes through the
  // wall - the cells beyond wall j are ring j's (ring 0's for wall 0, the
  // outermost ring's for the exit) - its narrowest chord there, less half
  // a wall's thickness either side, where the radial walls at the cell's
  // ends reach in. A wider one would cut beyond its cell, and its slab
  // span more than the wedges can separate.
  for (let j = 0; j <= rings; j++) {
    const ring = Math.min(j, rings - 1);
    const chord = 2 * rho(j) * Math.sin(Math.PI / counts[ring]);
    if (doorWidth + t >= chord) {
      throw new Error(`a doorway ${doorWidth} wide does not fit in wall ${j}: its cells are ` +
                      `${chord.toFixed(3)} across there; make innerRadius larger (it is ${innerRadius}) ` +
                      'or the doorways narrower');
    }
  }

  // A spanning tree, grown depth first from the hub in a random order.
  const visited = new Set([-1]);
  const passages = [], open = [];
  const stack = [-1];
  while (stack.length) {
    const here = stack[stack.length - 1];
    const ways = edges.get(here).filter((e) => !visited.has(e.to));
    if (!ways.length) { stack.pop(); continue; }
    const way = ways[Math.floor(random() * ways.length)];
    visited.add(way.to);
    passages.push([here, way.to]);
    open.push(way.wall);
    stack.push(way.to);
  }
  // The way out: through the outer wall, at a cell of the outermost ring.
  const outer = cellOf(rings - 1, Math.floor(random() * counts[rings - 1]));
  const exitAngle = middle(outer);
  open.push({ ring: rings, angle: exitAngle });

  // -- geometry -------------------------------------------------------------
  //
  // The walls are the divisions: the tree is a spatial partition built
  // from the maze's own surfaces, not walls collected into a group.
  //   - Root: the outermost wall's outside. A ray that misses the maze
  //     passes it in one test.
  //   - Then floor and ceiling: the slab the halls stand in.
  //   - Then radially: the maze is layers - hub, wall 0, corridor 0, wall 1,
  //     ..., the outer wall - with cylinders between them, divided middle
  //     first, so a ray finds its layer in a few tests.
  //   - Then by angle, within a layer: planes through the axis, middle
  //     first, down to wedges of a quarter turn at most holding at most one
  //     radial wall or doorway. In a wedge that narrow a slab along the line
  //     from the middle meets it only once, so the slab alone is the wall
  //     or the doorway.
  //   - Then the walls in a wedge, face by face (see layer()).
  // Dividers name no material - `material: null`, pure divisions - so an
  // absent inside among them is empty; walls name `material`.
  const wall = material ?? 'wall';
  const jamb = doorMaterial ?? wall;
  const cap = topMaterial ?? wall;
  const cylinder = (radius) => ({ cylinder: { center: [0, 0, 0], axis: [0, 0, 1], radius } });
  // Along the line from the middle out at angle a, centred on the middle:
  // every slab at one angle is the same planes to the last bit.
  const across = (a, thickness) => ({ slab: { center: [0, 0, 0], axis: tangentOf(a), thickness } });
  // Through the axis at angle b; its inside is the half turn before b.
  const halfTurn = (b) => ({ plane: { normal: tangentOf(b), offset: 0 } });

  // Angular BSP over `items` ({ angle, half }: a slab's angle, and the
  // angle half its width spans at the layer's inside) in the range lo..hi;
  // `leaf(items)` builds what is in a wedge.
  const span = (x, lo, hi) => {
    const into = (v) => lo + ((((v - lo) % TAU) + TAU) % TAU);
    const a0 = into(x.angle - x.half);
    return a0 < hi || into(x.angle + x.half) < a0;      // starts inside, or wraps into it
  };
  // Items at one angle - a radial wall either side of a ring wall, where
  // two corridors have as many cells - share a wedge: no cut parts them.
  const angles = (items) => new Set(items.map((x) => x.angle.toFixed(9))).size;
  const angular = (items, lo, hi, leaf, depth = 0) => {
    if (!items.length || (angles(items) <= 1 && hi - lo <= Math.PI / 2 + 1e-9) || depth > 12) return leaf(items);
    const b = (lo + hi) / 2;
    return {
      ...halfTurn(b), material: null,
      inside: angular(items.filter((x) => span(x, lo, b)), lo, b, leaf, depth + 1),
      outside: angular(items.filter((x) => span(x, b, hi)), b, hi, leaf, depth + 1),
    };
  };
  const slabsAt = (angles, radius, width) =>
    angles.map((angle) => ({ angle, half: Math.asin(Math.min(1, width / 2 / radius)) + 1e-6 }));

  // Every face of a wall is the surface of a node carrying the wall's
  // material, entered on its inside, with the empty space in front of it an
  // outside of the wall's own nodes - so trace() reports the face a ray
  // actually struck, at that face's own root. The dividers (material null,
  // pure divisions) therefore stand in empty space, never on a face: the
  // cylinders between layers run along the middle of the corridors, the
  // slab of the halls reaches half a hall above the tops, the root half a
  // hall beyond the outer wall. A divider on a face would hand the region
  // beyond it a t0 its own nodes did not make.
  const margin = hallWidth / 2;
  const top = { plane: { normal: [0, 0, 1], offset: h } };     // inside: below the tops
  const nest = (nodes) => nodes.reduceRight((rest, n) => (rest ? { ...n, inside: rest } : n), null);
  const solidSlab = (a, thickness, complement = false, named = wall) =>
    ({ slab: { ...across(a, thickness).slab, ...(complement ? { complement: true } : {}) }, material: named });
  // A row of radial walls under the tops - its own copy of them, as it
  // hangs from a ring wall's outside, which clears what was found above -
  // each a slab whose inside is the wall; past one, the next, and past the
  // last, nothing.
  const row = (angles) => angles.length ? {
    ...top, material: cap,
    inside: angles.reduceRight((rest, a) => ({ ...solidSlab(a, t), ...(rest ? { outside: rest } : {}) }), null),
  } : null;

  // Layer j: ring wall j with the half corridor either side of it, from the
  // middle of corridor j - 1 (or the middle of everything) to the middle of
  // corridor j (or past the outer wall). In a wedge: the tops; ring wall j's
  // outside face, beyond which the outer half corridor's radial walls
  // stand; its inside face, within which the inner half corridor's do (or
  // the hub is); and its doorways, slabs complemented, so the wall is their
  // inside and the opening their outside, the jambs taking the wall's
  // material. Radial walls reach across two layers, half in each.
  const openRadial = new Set(open.filter((w) => w.radial !== undefined).map((w) => `${w.radial}:${w.angle}`));
  const radialWalls = (i) => (i < 0 || i >= rings || counts[i] < 2) ? [] :
    cells.filter((c) => c.ring === i && !openRadial.has(`${i}:${c.angle1}`)).map((c) => c.angle1);
  const mid = (i) => (rho(i) + t + rho(i + 1)) / 2;            // middle of corridor i
  const layer = (j) => {
    // Each slab's angular width where it is: a doorway in the ring wall, a
    // radial wall from the near end of its half corridor out.
    const items = [
      ...slabsAt(open.filter((w) => w.ring === j).map((w) => w.angle), rho(j), doorWidth).map((x) => ({ ...x, kind: 'door' })),
      ...(j > 0 ? slabsAt(radialWalls(j - 1), mid(j - 1), t) : []).map((x) => ({ ...x, kind: 'in' })),
      ...slabsAt(radialWalls(j), rho(j) + t, t).map((x) => ({ ...x, kind: 'out' })),
    ];
    return angular(items, 0, TAU, (here) => {
      const of = (kind) => here.filter((x) => x.kind === kind).map((x) => x.angle);
      const inner = { cylinder: { ...cylinder(rho(j)).cylinder, complement: true }, material: wall,
                      ...(row(of('in')) ? { outside: row(of('in')) } : {}) };
      const doors = of('door').map((a) => solidSlab(a, doorWidth, true, jamb));
      const outer = { ...cylinder(rho(j) + t), material: wall, inside: nest([inner, ...doors]),
                      ...(row(of('out')) ? { outside: row(of('out')) } : {}) };
      return { ...top, material: cap, inside: outer };
    });
  };

  const radial = (a, b) => {
    if (a === b) return layer(a);
    const m = Math.ceil((a + b) / 2);           // layers a..m-1 inside, m..b outside
    return { ...cylinder(mid(m - 1)), material: null, inside: radial(a, m - 1), outside: radial(m, b) };
  };
  const tall = h + margin;
  const tree = {
    ...cylinder(rho(rings) + t + margin), material: null,
    inside: {
      slab: { center: [0, 0, tall / 2], axis: [0, 0, 1], thickness: tall }, material: null,
      inside: radial(0, rings),
    },
  };

  return {
    tree,
    cells,
    passages,
    openings: open,
    hub: { center: [0, 0, h / 2], radius: rho(0) },
    exit: { angle: exitAngle },
    radius: rho(rings) + t,
  };
}
