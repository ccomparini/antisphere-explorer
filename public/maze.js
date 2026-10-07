// ---------------------------------------------------------------------------
// Circular mazes
//
// A maze of concentric corridors round an open hub, as a scene subtree.
// The major walls are concentric rings between cylinders, as tall as the
// halls, with doorways through them; short radial walls cross the
// corridors. The tree is a spatial partition made of those very surfaces
// (see "geometry" below).
// Which doorways are open and which radial walls stand is a spanning tree
// over the maze's cells, grown at random from the hub by a seeded
// generator, so there is exactly one way between any two places, and the
// same seed always makes the same maze.
//
// Cells: corridor `ring`, between ring walls `ring` and `ring` + 1, is cut
// into counts[ring] cells. Ring 0 has `baseCells`; each ring outward
// doubles the count when its cells would otherwise be over twice as long as
// a hall is wide, so a cell's outward neighbours always lie wholly within
// its arc, and a doorway fits in any of them.
//
// No DOM: runs in node (tools/maze.mjs) and in the browser alike.
// ---------------------------------------------------------------------------

/** A seeded generator of numbers in [0, 1): mulberry32. */
export function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = 2 * Math.PI;
const tangentOf = (angle) => [-Math.sin(angle), Math.cos(angle), 0];
const pointAt = (radius, angle, height) => [radius * Math.cos(angle), radius * Math.sin(angle), height];

/**
 * Generate a circular maze.
 *
 * Returns { tree, cells, passages, openings, height, hub, exit, radius, torches }:
 *   tree      a scene subtree - the walls and the floor between them, on
 *             z = 0 - to put under "objects" and place where it is wanted
 *   cells     [{ ring, index, angle0, angle1, center }], one per cell
 *   passages  [[from, to]], the open ways between cells, by index into
 *             cells; -1 is the hub
 *   openings  the walls opened for them, and for the exit: { ring, angle }
 *             a doorway through ring wall `ring` at `angle`, or
 *             { radial, angle } the radial wall in corridor `radial` at it
 *   height    the top of the space the tree divides, above the walls
 *   hub       { center, radius }: the open middle
 *   exit      { angle }: where the way out is cut through the outer wall
 *   radius    the outer wall's outside
 *   torches   [{ cell, pos, color }]: the lights in the maze, by index into
 *             cells; -1 is the hub
 *
 * `innerRadius` is the hub's, 1.25 hall widths by default. A doorway must
 * fit inside its cell where it goes through a wall, or this throws.
 *
 * `material` is the walls' faces (default "wall", which the scene must
 * define); `doorMaterial` the insides of the doorways, their jambs, and
 * `topMaterial` the tops, and `floorMaterial` the floor within the maze, all
 * `material` unless given. Each face is a node of its own, so it shows its
 * own.
 *
 * `torches` is the share of cells, the hub among them, that have a light:
 * 0 (the default) none, 1 all. A torch lights only its own cell (see
 * "Lights" under Subtrees in scene-format.md): its walls and floor, and
 * nothing it can see through a doorway.
 */
export function circularMaze({
  seed = 1,
  rings = 5,
  hallWidth = 2.25,
  wallHeight = 2.5,
  wallThickness = 0.2,
  innerRadius = hallWidth * 1.25,
  baseCells = 6,
  doorWidth = hallWidth * 0.8,
  material,
  doorMaterial,
  topMaterial,
  floorMaterial,
  torches = 0,
} = {}) {
  const random = seeded(seed);
  // Ring wall `ring` runs from wallInside(ring) out to wallOutside(ring);
  // corridor `ring` lies between ring walls `ring` and `ring` + 1.
  const wallInside = (ring) => innerRadius + ring * (hallWidth + wallThickness);
  const wallOutside = (ring) => wallInside(ring) + wallThickness;

  // -- cells and the graph ------------------------------------------------
  const counts = [baseCells];
  for (let ring = 1; ring < rings; ring++) {
    const inward = counts[ring - 1];
    counts.push((TAU * wallOutside(ring)) / (2 * inward) >= 2 * hallWidth ? 2 * inward : inward);
  }
  const cells = [], firstCell = [];
  counts.forEach((count, ring) => {
    firstCell.push(cells.length);
    const midway = (wallOutside(ring) + wallInside(ring + 1)) / 2;
    for (let index = 0; index < count; index++) {
      const angle0 = (TAU * index) / count, angle1 = (TAU * (index + 1)) / count;
      cells.push({ ring, index, angle0, angle1, center: pointAt(midway, (angle0 + angle1) / 2, wallHeight / 2) });
    }
  });
  const cellOf = (ring, index) => firstCell[ring] + ((index % counts[ring]) + counts[ring]) % counts[ring];
  const middleAngle = (cell) => (cells[cell].angle0 + cells[cell].angle1) / 2;

  // Neighbours: -1 is the hub. Each edge says which wall it would open.
  const edges = new Map(cells.map((_, cell) => [cell, []]).concat([[-1, []]]));
  const link = (from, to, wall) => {
    edges.get(from).push({ to, wall });
    edges.get(to).push({ to: from, wall });
  };
  for (let index = 0; index < counts[0]; index++) {
    link(-1, cellOf(0, index), { ring: 0, angle: middleAngle(cellOf(0, index)) });
  }
  cells.forEach((cell, here) => {
    // Round the corridor, across the radial wall at the cell's far end
    // (a corridor of one cell has no neighbour but itself).
    if (counts[cell.ring] > 1) {
      link(here, cellOf(cell.ring, cell.index + 1), { radial: cell.ring, angle: cell.angle1 });
    }
    // Outward, through the next ring wall, to each child.
    if (cell.ring + 1 < rings) {
      const ratio = counts[cell.ring + 1] / counts[cell.ring];
      for (let offset = 0; offset < ratio; offset++) {
        const child = cellOf(cell.ring + 1, cell.index * ratio + offset);
        link(here, child, { ring: cell.ring + 1, angle: middleAngle(child) });
      }
    }
  });

  // Every doorway has to fit inside its cell where it goes through the
  // wall - the cells beyond ring wall `ring` are corridor `ring`'s (the
  // outermost corridor's for the exit) - its narrowest chord there, less
  // half a wall's thickness either side, where the radial walls at the
  // cell's ends reach in. A wider one would cut beyond its cell, and its
  // slab span more than the wedges can separate.
  for (let ring = 0; ring <= rings; ring++) {
    const beyond = Math.min(ring, rings - 1);
    const chord = 2 * wallInside(ring) * Math.sin(Math.PI / counts[beyond]);
    if (doorWidth + wallThickness >= chord) {
      throw new Error(`a doorway ${doorWidth} wide does not fit in wall ${ring}: its cells are ` +
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
    const ways = edges.get(here).filter((edge) => !visited.has(edge.to));
    if (!ways.length) { stack.pop(); continue; }
    const way = ways[Math.floor(random() * ways.length)];
    visited.add(way.to);
    passages.push([here, way.to]);
    open.push(way.wall);
    stack.push(way.to);
  }
  // The way out: through the outer wall, at a cell of the outermost ring.
  const outermost = cellOf(rings - 1, Math.floor(random() * counts[rings - 1]));
  const exitAngle = middleAngle(outermost);
  open.push({ ring: rings, angle: exitAngle });
  // Which cells have a torch.
  const lit = new Set([-1, ...cells.keys()].filter(() => random() < torches));

  // -- geometry -------------------------------------------------------------
  //
  // The walls are the divisions: the tree is a spatial partition built
  // from the maze's own surfaces, outermost first.
  //   - Root: a cylinder half a hall beyond the outer wall, and within it the
  //     slab the halls stand in, reaching half a hall above the tops and
  //     below the floor - pure divisions, so a ray that misses the maze, or
  //     passes over it, is done in two tests.
  //   - Then radially, middle first, by cylinders through the middle of each
  //     ring wall but the outer one: pure divisions, standing in stone,
  //     above every face. Between each two is a layer: corridor `ring`, with
  //     the halves of ring walls `ring` and `ring` + 1 that face it (the
  //     outermost corridor, all of the outer wall). The hub, wall 0's inner
  //     half and the open middle, is innermost, so it comes last.
  //   - Then by angle, within a layer: planes through the axis, middle
  //     first, at the corridor's cell boundaries - through the middle of
  //     each radial wall, standing or open - so pure divisions again, in
  //     stone or air, above every face. Each wedge is one cell. (The hub is
  //     one cell; its wedges just keep each doorway to itself.) In a wedge
  //     of a quarter turn or less a slab along the line from the middle
  //     meets it only once, so the slab alone is the wall or the doorway.
  //   - Then in a wedge: the floor, below it, and above, a chain through
  //     outsides: the inner wall's outside face, its inside that half
  //     wall's top and doorways; the outer wall's inside face, likewise;
  //     and past both, the corridor: the halves of the radial walls at its
  //     ends, each with its top below its slab.
  // So every doorway is cut twice, once in each layer its wall is half of,
  // and every radial wall twice, once in each cell it is the end of. And a
  // cell is a subtree, which a torch can light: a node holding the cell,
  // carrying its light, so the cell is its region.
  //
  // Faces are spelled as DESIGN.md says ("Spelling a solid's faces"): each
  // the surface of a node carrying the walls' material, entered on its
  // inside, the empty space in front of it an outside - so trace() reports
  // the face a ray struck. The pure divisions are all above the faces.
  const wall = material ?? 'wall';
  const jamb = doorMaterial ?? wall;
  const cap = topMaterial ?? wall;
  const ground = floorMaterial ?? wall;
  const margin = hallWidth / 2;
  const height = wallHeight + margin;
  const middleOf = (ring) => wallInside(ring) + wallThickness / 2;

  // A cylinder about the axis; facing in, its inside is everything beyond it.
  const cylinder = (radius, facingIn = false) =>
    ({ cylinder: { center: [0, 0, 0], axis: [0, 0, 1], radius, ...(facingIn ? { complement: true } : {}) } });
  // Along the line from the middle out at `angle`, centred on the middle:
  // every slab at one angle is the same planes to the last bit.
  const across = (angle, thickness, complement = false) =>
    ({ slab: { center: [0, 0, 0], axis: tangentOf(angle), thickness, ...(complement ? { complement: true } : {}) } });
  // Through the axis at `angle`; its inside is the half turn before it.
  const halfTurn = (angle) => ({ plane: { normal: tangentOf(angle), offset: 0 } });
  // Below the tops; below the floor; below the top of the halls.
  const top = { plane: { normal: [0, 0, 1], offset: wallHeight } };
  const floor = { plane: { normal: [0, 0, 1], offset: 0 } };
  const ceiling = { plane: { normal: [0, 0, 1], offset: height } };
  const withChildren = (node, nodeMaterial, inside, outside) => ({
    ...node,
    material: nodeMaterial,
    ...(inside ? { inside } : {}),
    ...(outside ? { outside } : {}),
  });

  // Angular BSP over `items` ({ kind, angle, half }: a slab's angle, and the
  // angle half its width spans nearest the axis) in the range low..high,
  // split at the middle; `leaf(items, low, high)` builds a wedge.
  const overlaps = (item, low, high) => {
    const into = (angle) => low + ((((angle - low) % TAU) + TAU) % TAU);
    const start = into(item.angle - item.half);
    return start < high || into(item.angle + item.half) < start;     // starts inside, or wraps into it
  };
  const crowded = (items) => new Set(items.map((item) => item.kind)).size < items.length;
  const angular = (items, low, high, leaf, depth = 0) => {
    if (!items.length || (!crowded(items) && high - low <= Math.PI / 2 + 1e-9) || depth > 12) return leaf(items, low, high);
    const divide = (low + high) / 2;
    return withChildren(
      halfTurn(divide),
      null,
      angular(items.filter((item) => overlaps(item, low, divide)), low, divide, leaf, depth + 1),
      angular(items.filter((item) => overlaps(item, divide, high)), divide, high, leaf, depth + 1),
    );
  };
  // The same, a cell to a wedge: split at the cell boundary nearest the
  // middle that leaves no side over a half turn (a plane through the axis
  // parts only half turns), or if there is none, at the middle, a cell
  // across it going both ways; and within a cell over a quarter turn, by
  // the middle as above.
  const byCell = (ringCells, items, leaf, wrap) => {
    const within = (low, high) => items.filter((item) => overlaps(item, low, high));
    const split = (first, last, low, high) => {
      if (first === last) {
        const cell = ringCells[first];
        const quarters = (here, from, to) => (to - from <= Math.PI / 2 + 1e-9
          ? leaf(cell, here)
          : withChildren(halfTurn((from + to) / 2), null,
            quarters(here.filter((item) => overlaps(item, from, (from + to) / 2)), from, (from + to) / 2),
            quarters(here.filter((item) => overlaps(item, (from + to) / 2, to)), (from + to) / 2, to)));
        return wrap(cell, quarters(within(low, high), low, high));
      }
      const fits = (angle) => angle - low <= Math.PI + 1e-9 && high - angle <= Math.PI + 1e-9;
      let best = -1;
      for (let index = first + 1; index <= last; index++) {
        const angle = ringCells[index].angle0;
        if (fits(angle) && (best < 0 || Math.abs(angle - (low + high) / 2) < Math.abs(ringCells[best].angle0 - (low + high) / 2))) best = index;
      }
      if (best >= 0) {
        const divide = ringCells[best].angle0;
        return withChildren(halfTurn(divide), null, split(first, best - 1, low, divide), split(best, last, divide, high));
      }
      const divide = (low + high) / 2;
      const straddling = ringCells.findIndex((cell) => cell.angle0 < divide && divide < cell.angle1);
      return withChildren(halfTurn(divide), null,
        split(first, straddling, low, divide), split(straddling, last, divide, high));
    };
    return split(0, ringCells.length - 1, 0, TAU);
  };
  const slabsAt = (kind, angles, radius, width) => angles.map((angle) =>
    ({ kind, angle, half: Math.asin(Math.min(1, width / 2 / radius)) + 1e-6 }));
  const ofKind = (items, kind) => items.filter((item) => item.kind === kind);

  // Ring wall `ring`'s doorways, and corridor `ring`'s standing radial walls.
  const doorsThrough = (ring) => open.filter((opening) => opening.ring === ring).map((opening) => opening.angle);
  const openRadial = new Set(open.filter((opening) => opening.radial !== undefined)
    .map((opening) => `${opening.radial}:${opening.angle}`));
  const standingIn = (ring) => (counts[ring] < 2 ? [] : cells
    .filter((cell) => cell.ring === ring && !openRadial.has(`${ring}:${cell.angle1}`))
    .map((cell) => cell.angle1));

  // A cell, in a wedge: the floor, and above it the rest. And if it has a
  // torch, a node holding all of its wedges, carrying the torch.
  const torchAt = (cell) => (cell < 0
    ? [0, 0, wallHeight * 0.8]
    : pointAt(Math.hypot(cells[cell].center[0], cells[cell].center[1]), middleAngle(cell), wallHeight * 0.8));
  const torchColor = [1, 0.75, 0.45].map((part) => +(part * 0.6 * hallWidth * hallWidth).toFixed(3));
  const floored = (above) => withChildren(floor, ground, null, above);
  const torchFor = (cell, subtree) => (lit.has(cell)
    ? { ...ceiling, lights: [{ pos: torchAt(cell), color: torchColor }], inside: subtree }
    : subtree);

  // Half a ring wall, in a wedge: below its tops, stone, but for its
  // doorways - slabs complemented, so the wall is their inside and the
  // opening their outside, the jambs faces of their own.
  const halfWall = (doors) => withChildren(top, cap, doors.reduceRight((rest, item) =>
    withChildren(across(item.angle, doorWidth, true), jamb, rest, null), null), null);
  // A corridor, in a wedge: its radial walls' slabs, each's inside the wall,
  // below its own top; past one, the next, and past the last, nothing. (A
  // top over them all would be crossed first, and a ray into the top of
  // any but the first would then pass the outsides of those before it,
  // which clear the hit: each top is the wall's, below its slab.)
  const corridor = (radials) => radials.reduceRight((rest, item) =>
    withChildren(across(item.angle, wallThickness), wall, withChildren(top, cap, null, null), rest), null);

  // The hub: the open middle, and beyond wall 0's inside face, its inner half.
  const hubLayer = () => {
    const hub = angular(
      slabsAt('outer', doorsThrough(0), wallInside(0), doorWidth), 0, TAU,
      (here) => floored(withChildren(cylinder(wallInside(0), true), wall, halfWall(here), null)));
    return torchFor(-1, hub);
  };
  // Corridor `ring`'s layer.
  const corridorLayer = (ring) => {
    const outermost = ring === rings - 1;
    const items = [
      ...slabsAt('inner', doorsThrough(ring), middleOf(ring), doorWidth),
      ...slabsAt('outer', doorsThrough(ring + 1), wallInside(ring + 1), doorWidth),
      ...slabsAt('radial', standingIn(ring), wallOutside(ring), wallThickness),
    ];
    const ringCells = cells.filter((cell) => cell.ring === ring);
    return byCell(ringCells, items, (cell, here) => {
      const outerWall = outermost      // all of the outer wall: within its outside face too
        ? withChildren(cylinder(wallOutside(rings)), wall, halfWall(ofKind(here, 'outer')), null)
        : halfWall(ofKind(here, 'outer'));
      return floored(withChildren(
        cylinder(wallOutside(ring)),
        wall,
        halfWall(ofKind(here, 'inner')),
        withChildren(
          cylinder(wallInside(ring + 1), true),
          wall,
          outerWall,
          corridor(ofKind(here, 'radial')),
        ),
      ));
    }, (cell, subtree) => torchFor(cellOf(ring, cell.index), subtree));
  };

  // The layers outward, divided through the middle of the ring wall between
  // each and the next, middle first.
  const layers = [hubLayer, ...Array.from({ length: rings }, (_, ring) => () => corridorLayer(ring))];
  const radial = (low, high) => {
    if (low === high) return layers[low]();
    const split = Math.ceil((low + high) / 2);                // low..split-1 | split..high
    return withChildren(cylinder(middleOf(split - 1)), null, radial(low, split - 1), radial(split, high));
  };
  const tree = withChildren(
    cylinder(wallOutside(rings) + margin),
    null,
    withChildren(
      { slab: { center: [0, 0, (height - margin) / 2], axis: [0, 0, 1], thickness: height + margin } },
      null,
      radial(0, layers.length - 1),
      null,
    ),
    null,
  );

  return {
    tree,
    cells,
    passages,
    openings: open,
    height,
    hub: { center: [0, 0, wallHeight / 2], radius: wallInside(0) },
    exit: { angle: exitAngle },
    radius: wallOutside(rings),
    torches: [...lit].sort((first, second) => first - second)
      .map((cell) => ({ cell, pos: torchAt(cell), color: torchColor })),
  };
}
