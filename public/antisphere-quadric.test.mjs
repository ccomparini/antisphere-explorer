// Tests for revolution quadrics. Run with:
//   node --test antisphere-quadric.test.mjs
//
// Everything here goes through packNodes and reads the bytes back, so the
// struct layout is under test alongside the maths: H and the ray polynomial
// below are transcriptions of antisphere-raycast.wgsl's fAt() and trace(),
// and if the packing drifts from the shader these stop agreeing with the
// closed forms they are checked against.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene, packNodes } from './antisphere-scene.js';

const NODE_WORDS = 16;             // 64 bytes

// Every node of a one-primitive scene, as the GPU would see it.
function packed(shape, extra = {}) {
  const spec = { materials: {}, lights: [], root: { ...shape, ...extra } };
  const built = compileScene(spec);
  const f = new Float32Array(packNodes(built.nodes));
  const read = (i) => {
    const o = i * NODE_WORDS;
    return {
      axis: [f[o], f[o + 1], f[o + 2]],
      curvature_perp: f[o + 3],
      linear: [f[o + 4], f[o + 5], f[o + 6]],
      curvature_delta: f[o + 7],
      const_term: f[o + 8],
    };
  };
  return read(1);                  // node 1 is always the root
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// fAt(), transcribed.
function H(nd, R) {
  const along = dot(nd.axis, R);
  return nd.curvature_perp * dot(R, R) + nd.curvature_delta * along * along
       + dot(nd.linear, R) + nd.const_term;
}

// The A, B, C of trace(), transcribed. |D| is assumed 1, as there.
function abc(nd, O, D) {
  const axisDotDir = dot(nd.axis, D);
  const axisDotOrigin = dot(nd.axis, O);
  return {
    A: nd.curvature_perp + nd.curvature_delta * axisDotDir * axisDotDir,
    B: 2 * (nd.curvature_perp * dot(O, D) + nd.curvature_delta * axisDotOrigin * axisDotDir)
       + dot(nd.linear, D),
    C: nd.curvature_perp * dot(O, O) + nd.curvature_delta * axisDotOrigin * axisDotOrigin
       + dot(nd.linear, O) + nd.const_term,
  };
}

const near = (a, b, eps = 1e-5) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);
const inside = (nd, R) => assert.ok(H(nd, R) < 0, `${R} should be inside, H = ${H(nd, R)}`);
const outside = (nd, R) => assert.ok(H(nd, R) > 0, `${R} should be outside, H = ${H(nd, R)}`);
const onSurface = (nd, R) => near(H(nd, R), 0);

// -- the isotropic cases still mean what they did --------------------------------

test('a sphere is k(|R - C|^2 - r^2), exactly as before', () => {
  const C = [1, -2, 3], r = 2, k = 1 / (2 * r);
  const nd = packed({ sphere: { center: C, radius: r } });
  near(nd.curvature_perp, k);
  near(nd.curvature_delta, 0);                     // isotropic: no axis needed
  for (const R of [[0, 0, 0], [1, -2, 3], [3, 1, 2], [1, -2, 5], [-4, 4, 4]]) {
    const d2 = (R[0] - C[0]) ** 2 + (R[1] - C[1]) ** 2 + (R[2] - C[2]) ** 2;
    near(H(nd, R), k * (d2 - r * r));
  }
});

test('a plane is n.R - a, with linear as its unit normal', () => {
  const nd = packed({ plane: { normal: [0, 0, 2], offset: 3 } });   // unnormalized
  assert.deepEqual([nd.curvature_perp, nd.curvature_delta], [0, 0]);
  near(nd.linear[2], 1);                           // 2c = n
  near(nd.const_term, -1.5);                       // offset / |normal|
  for (const z of [-2, 0, 1.5, 4]) near(H(nd, [7, -7, z]), z - 1.5);
});

// -- the worked examples from hyperconic.md -------------------------------------

test('slab: H = (y - 1)(y - 3)', () => {
  const nd = packed({ quadric: { axis: [0, 1, 0], k_par: 1, k_perp: 0, c: [0, -2, 0], d: 3 } });
  for (const y of [-1, 0, 1, 2, 3, 5]) near(H(nd, [4, y, -6]), (y - 1) * (y - 3));
  inside(nd, [0, 2, 0]);
  outside(nd, [0, 0, 0]);
  onSurface(nd, [0, 1, 0]);
  onSurface(nd, [0, 3, 0]);
});

test('parabolic cylinder: x = (1 - (y - 2)^2) / 2, extruded along z', () => {
  const nd = packed({ quadric: { axis: [0, 1, 0], k_par: 1, k_perp: 0, c: [1, -2, 0], d: 3 } });
  for (const y of [0, 1, 2, 3.5]) {
    const x = (1 - (y - 2) ** 2) / 2;
    for (const z of [-5, 0, 5]) onSurface(nd, [x, y, z]);   // straight along z
  }
});

test('cylinder: (Rx + 1)^2 + Rz^2 = 1 at every y', () => {
  const nd = packed({ quadric: { axis: [0, 1, 0], k_par: 0, k_perp: 1, c: [1, 0, 0], d: 0 } });
  for (const y of [-10, 0, 10]) {
    onSurface(nd, [0, y, 0]);
    onSurface(nd, [-2, y, 0]);
    onSurface(nd, [-1, y, 1]);
    inside(nd, [-1, y, 0]);
    outside(nd, [1, y, 0]);
  }
});

test('paraboloid: Ry = 1 - (Rx + 1)^2 - Rz^2', () => {
  const nd = packed({ quadric: { axis: [0, 1, 0], k_par: 0, k_perp: 1, c: [1, 0.5, 0], d: 0 } });
  for (const [x, z] of [[0, 0], [-1, 0], [-2, 1], [0.5, -0.5]]) {
    onSurface(nd, [x, 1 - (x + 1) ** 2 - z * z, z]);
  }
});

test('hyperboloid of one sheet: Rx^2 + Rz^2 = y^2 + 1', () => {
  const nd = packed({ quadric: { axis: [0, 1, 0], k_par: 1, k_perp: -1, c: [0, 0, 0], d: 1 } });
  for (const y of [0, 1, -3]) {
    const r = Math.sqrt(y * y + 1);
    onSurface(nd, [r, y, 0]);
    onSurface(nd, [0, y, -r]);
  }
});

test('hyperboloid of two sheets: y^2 - (Rx^2 + Rz^2) = 1, so |y| >= 1', () => {
  const nd = packed({ quadric: { axis: [0, 1, 0], k_par: 1, k_perp: -1, c: [0, 0, 0], d: -1 } });
  onSurface(nd, [0, 1, 0]);
  onSurface(nd, [0, -1, 0]);
  assert.ok(H(nd, [0, 0, 0]) < 0);                 // the gap between the sheets
  for (const y of [1.5, -2]) onSurface(nd, [Math.sqrt(y * y - 1), y, 0]);
});

test('cone: Rx^2 + Rz^2 = y^2, apex at the origin', () => {
  const nd = packed({ quadric: { axis: [0, 1, 0], k_par: 1, k_perp: -1, c: [0, 0, 0], d: 0 } });
  for (const y of [0, 2, -3]) { onSurface(nd, [y, y, 0]); onSurface(nd, [0, y, -y]); }
});

test('a quadric that is zero everywhere is refused', () => {
  assert.throws(
    () => packed({ quadric: { axis: [0, 0, 1], k_par: 0, k_perp: 0, c: [0, 0, 0], d: 0 } }),
    /no surface/);
});

// -- the named shapes ------------------------------------------------------------

test('spheroid: semi-axes along and around the axis', () => {
  const nd = packed({ spheroid: { center: [0, 0, 1], axis: [0, 0, 1],
                                  semiAxial: 3, semiRadial: 1 } });   // prolate
  onSurface(nd, [0, 0, 4]);
  onSurface(nd, [0, 0, -2]);
  onSurface(nd, [1, 0, 1]);
  onSurface(nd, [0, -1, 1]);
  inside(nd, [0, 0, 1]);
  outside(nd, [1.2, 0, 1]);
  assert.ok(nd.curvature_delta < 0, 'prolate: curvature along the axis is the smaller');
});

test('cylinder, slab, cone, paraboloid and hyperboloid from their own words', () => {
  const tilted = [0, 1, 1];                        // an axis that is not a basis vector

  const cyl = packed({ cylinder: { center: [2, 0, 0], axis: [0, 0, 1], radius: 2 } });
  for (const z of [-9, 0, 9]) { onSurface(cyl, [4, 0, z]); inside(cyl, [2, 0, z]); }

  const sl = packed({ slab: { center: [0, 0, 5], axis: [0, 0, 1], thickness: 4 } });
  onSurface(sl, [30, -30, 3]); onSurface(sl, [0, 0, 7]);
  inside(sl, [0, 0, 5]); outside(sl, [0, 0, 7.5]);

  const cn = packed({ cone: { apex: [0, 0, 2], axis: [0, 0, 1], slope: 0.5 } });
  onSurface(cn, [1, 0, 4]);                        // radius 1 two along the axis
  onSurface(cn, [0, -2, 6]);
  inside(cn, [0, 0, 6]); outside(cn, [3, 0, 4]);

  const par = packed({ paraboloid: { vertex: [0, 0, 0], axis: [0, 0, 1], focal: 1 } });
  onSurface(par, [2, 0, 1]);                       // |R_perp|^2 = 4 f x
  onSurface(par, [0, 4, 4]);
  inside(par, [0, 0, 3]); outside(par, [0, 0, -1]);

  const one = packed({ hyperboloid: { center: [0, 0, 0], axis: tilted,
                                      radius: 1, semiAxial: 1, sheets: 1 } });
  const two = packed({ hyperboloid: { center: [0, 0, 0], axis: tilted,
                                      radius: 1, semiAxial: 1, sheets: 2 } });
  const n = [0, Math.SQRT1_2, Math.SQRT1_2];
  inside(one, [0, 0, 0]);                          // the waist encloses the centre
  outside(two, [0, 0, 0]);                         // the gap between the sheets
  onSurface(one, [1, 0, 0]);                       // waist radius, perpendicular
  onSurface(two, n);                               // the nearer sheet, along the axis
});

// -- transforms ------------------------------------------------------------------

test('translation moves every shape exactly', () => {
  const t = [1, -2, 0.5];
  const shapes = [
    { sphere: { center: [0, 0, 0], radius: 2 } },
    { spheroid: { center: [1, 0, 0], axis: [0, 1, 1], semiAxial: 2, semiRadial: 1 } },
    { cone: { apex: [0, 0, 0], axis: [0, 0, 1], slope: 1 } },
    { cylinder: { center: [0, 0, 0], axis: [1, 1, 0], radius: 1 } },
    { plane: { normal: [1, 2, 3], offset: 1 } },
  ];
  for (const shape of shapes) {
    const still = packed(shape);
    const moved = packed(shape, { translate: t });
    for (const R of [[0, 0, 0], [3, 1, -2], [-1, 4, 5], [0.5, 0.5, 0.5]]) {
      near(H(moved, R), H(still, R.map((v, i) => v - t[i])), 1e-4);
    }
  }
});

test('complement negates the function everywhere', () => {
  const shape = { hyperboloid: { center: [0, 1, 0], axis: [0, 0, 1],
                                 radius: 2, semiAxial: 1, sheets: 1 } };
  const plain = packed(shape);
  const flipped = packed(shape, { complement: true });
  for (const R of [[0, 0, 0], [3, 3, 3], [-2, 1, 4]]) near(H(flipped, R), -H(plain, R));
});

// -- rays --------------------------------------------------------------------------

test('the ray polynomial agrees with H along the ray', () => {
  const nd = packed({ spheroid: { center: [1, 0, 2], axis: [0, 1, 1],
                                  semiAxial: 2, semiRadial: 1 } });
  const O = [-4, 1, 0];
  const D = (([x, y, z]) => { const L = Math.hypot(x, y, z); return [x / L, y / L, z / L]; })([1, 0.2, 0.4]);
  const { A, B, C } = abc(nd, O, D);
  for (const t of [0, 0.5, 2, 7.25]) {
    near((A * t + B) * t + C, H(nd, O.map((v, i) => v + t * D[i])), 1e-4);
  }
});

test('a ray along a ruling makes every coefficient vanish', () => {
  // A cylinder's wall, and a cone's ruling: the whole ray lies in the
  // surface, so trace() must not reach for the quadratic formula.
  const cyl = packed({ cylinder: { center: [0, 0, 0], axis: [0, 0, 1], radius: 2 } });
  let { A, B, C } = abc(cyl, [2, 0, -5], [0, 0, 1]);
  for (const v of [A, B, C]) assert.ok(Math.abs(v) < 1e-12, `coefficient ${v} should vanish`);

  const cn = packed({ cone: { apex: [0, 0, 0], axis: [0, 0, 1], slope: 1 } });
  const ruling = [Math.SQRT1_2, 0, Math.SQRT1_2];
  ({ A, B, C } = abc(cn, [0, 0, 0], ruling));
  for (const v of [A, B, C]) assert.ok(Math.abs(v) < 1e-12, `coefficient ${v} should vanish`);

  // And an ordinary ray at the same cone still has real roots.
  const other = abc(cn, [0, 0, -3], [0, 0, 1]);
  assert.ok(Math.abs(other.A) > 1e-6);
});

// -- bounds, and what may be grouped ------------------------------------------------

test('a spheroid bounds a group member; unbounded shapes do not', () => {
  const group = (shape) => compileScene({
    materials: { clay: {} }, lights: [],
    objects: { thing: { ...shape, material: 'clay' },
               ball: { sphere: { center: [40, 0, 0], radius: 1 }, material: 'clay' } },
    root: { group: ['thing', 'ball'] },
  });
  // Bounded: sphere and spheroid.
  group({ spheroid: { center: [0, 0, 0], axis: [0, 0, 1], semiAxial: 3, semiRadial: 1 } });
  group({ sphere: { center: [0, 0, 0], radius: 1 } });
  // Unbounded: everything with an axis it runs off along.
  for (const shape of [
    { cylinder: { center: [0, 0, 0], axis: [0, 0, 1], radius: 1 } },
    { cone: { apex: [0, 0, 0], axis: [0, 0, 1], slope: 1 } },
    { paraboloid: { vertex: [0, 0, 0], axis: [0, 0, 1], focal: 1 } },
    { hyperboloid: { center: [0, 0, 0], axis: [0, 0, 1], radius: 1, semiAxial: 1 } },
    { slab: { center: [0, 0, 0], axis: [0, 0, 1], thickness: 1 } },
  ]) {
    assert.throws(() => group(shape), /no bounding sphere/, Object.keys(shape)[0]);
  }
});

test('a spheroid group is partitioned, and overlap is still caught', () => {
  const members = (dx) => ({
    materials: { clay: {} }, lights: [],
    objects: {
      a: { spheroid: { center: [0, 0, 0], axis: [0, 0, 1], semiAxial: 2, semiRadial: 1 },
           material: 'clay' },
      b: { spheroid: { center: [dx, 0, 0], axis: [0, 0, 1], semiAxial: 2, semiRadial: 1 },
           material: 'clay' },
    },
    root: { group: ['a', 'b'] },
  });
  const built = compileScene(members(6));
  assert.ok(built.nodes.length > 3, 'a split surface and both members');
  assert.throws(() => compileScene(members(1)), /not mutually exterior/);
});

// -- whole scenes ---------------------------------------------------------------------

test('a scene of every shape compiles, packs and keeps its provenance', () => {
  const spec = {
    materials: { clay: {} },
    lights: [{ pos: [0, 0, 5], color: [10, 10, 10] }],
    objects: {
      pod:   { spheroid: { center: [0, 0, 1], axis: [0, 0, 1], semiAxial: 2, semiRadial: 1 } },
      pipe:  { cylinder: { center: [3, 0, 0], axis: [0, 0, 1], radius: 0.5 } },
      floor: { slab: { center: [0, 0, -1], axis: [0, 0, 1], thickness: 0.5 } },
      spike: { cone: { apex: [-3, 0, 0], axis: [0, 0, 1], slope: 0.5 } },
      dish:  { paraboloid: { vertex: [0, 4, 0], axis: [0, 0, 1], focal: 1 } },
      waist: { hyperboloid: { center: [0, -4, 0], axis: [0, 0, 1], radius: 1, semiAxial: 2 } },
    },
    root: {
      sphere: { center: [0, 0, 0], radius: 40 }, material: 'clay',
      inside: { union: ['pod', 'pipe', 'floor', 'spike', 'dish', 'waist'] },
    },
  };
  const built = compileScene(spec);
  const bytes = packNodes(built.nodes);
  assert.equal(bytes.byteLength, built.nodes.length * 64);
  assert.equal(built.provenance.length, built.nodes.length);
  const owners = new Set(built.provenance.filter(Boolean).map((p) => p.owner));
  for (const key of Object.keys(spec.objects)) assert.ok(owners.has(key), key);
});

test('a node must name exactly one shape', () => {
  assert.throws(() => packed({}), /needs a shape/);
  assert.throws(() => packed({ sphere: { center: [0, 0, 0], radius: 1 },
                               cone: { apex: [0, 0, 0], axis: [0, 0, 1], slope: 1 } }),
                /more than one shape/);
  assert.throws(() => packed({ cone: { apex: [0, 0, 0], axis: [0, 0, 1], slope: 0 } }),
                /positive slope/);
});

// -- rotation and scale ---------------------------------------------------------------

// Rotating a shape must move its surface exactly: H'(R) = H(R turned back).
function turnedBack(axis, degrees, pivot, R) {
  const a = Math.hypot(...axis);
  const [x, y, z] = axis.map((v) => v / a);
  const th = -degrees * Math.PI / 180;              // the inverse turn
  const c = Math.cos(th), s = Math.sin(th);
  const u = R.map((v, i) => v - pivot[i]);
  const kdotu = x * u[0] + y * u[1] + z * u[2];
  const cross = [y * u[2] - z * u[1], z * u[0] - x * u[2], x * u[1] - y * u[0]];
  return [x, y, z].map((k, i) =>
    u[i] * c + cross[i] * s + k * kdotu * (1 - c) + pivot[i]);
}

test('rotation turns the surface and leaves the curvatures alone', () => {
  const shape = { spheroid: { center: [2, 0, 0], axis: [0, 0, 1],
                              semiAxial: 3, semiRadial: 1 } };
  const still = packed(shape);
  const turned = packed(shape, { rotate: { axis: [0, 1, 0], degrees: 90 } });
  near(turned.curvature_perp, still.curvature_perp);
  near(turned.curvature_delta, still.curvature_delta);
  // The axis was +Z; a quarter turn about +Y takes it to +X.
  near(Math.abs(turned.axis[0]), 1);
  for (const R of [[0, 0, 0], [1, 2, 3], [-4, 0, 2], [0.5, -1, 0]]) {
    near(H(turned, R), H(still, turnedBack([0, 1, 0], 90, [0, 0, 0], R)), 1e-4);
  }
});

test('rotation about a pivot turns the shape where it stands', () => {
  const shape = { cylinder: { center: [4, 0, 0], axis: [0, 0, 1], radius: 1 } };
  const pivot = [4, 0, 0];
  const turned = packed(shape, { rotate: { axis: [1, 0, 0], degrees: 90, pivot } });
  // The axis is now +Y, and the cylinder still runs through its own centre.
  near(Math.abs(turned.axis[1]), 1);
  for (const y of [-6, 0, 6]) {
    onSurface(turned, [5, y, 0]);
    inside(turned, [4, y, 0]);
  }
  // Radians say the same thing as degrees.
  const inRadians = packed(shape, { rotate: { axis: [1, 0, 0], radians: Math.PI / 2, pivot } });
  for (const R of [[5, 1, 0], [4, -2, 0.5]]) near(H(inRadians, R), H(turned, R));
});

test('scale resizes about the origin, or about a pivot', () => {
  const sphere = packed({ sphere: { center: [2, 0, 0], radius: 1 } }, { scale: 3 });
  onSurface(sphere, [9, 0, 0]);                     // centre 6, radius 3
  onSurface(sphere, [3, 0, 0]);
  inside(sphere, [6, 0, 0]);
  near(sphere.curvature_perp, 1 / 6);

  const inPlace = packed({ sphere: { center: [2, 0, 0], radius: 1 } },
                         { scale: { factor: 3, pivot: [2, 0, 0] } });
  onSurface(inPlace, [5, 0, 0]);                    // centre stays, radius 3
  onSurface(inPlace, [-1, 0, 0]);

  // A plane keeps its normal and moves its offset; a cone about its apex
  // doesn't change at all.
  const plane = packed({ plane: { normal: [0, 0, 1], offset: 2 } }, { scale: 4 });
  for (const z of [-3, 0, 8, 12]) near(H(plane, [1, 1, z]), z - 8);
  // A cone about its apex is scale-invariant: same surface, H scaled by 1/s.
  // Points exactly on it are no test of that - zero times anything is zero -
  // so compare off it, where the sign has something to say.
  const shape = { cone: { apex: [0, 0, 0], axis: [0, 0, 1], slope: 0.5 } };
  const cone = packed(shape), scaled = packed(shape, { scale: 5 });
  for (const R of [[1, 0, 3], [0, 3, 1], [2, 2, -9], [0.2, 0, 8]]) {
    assert.notEqual(Math.sign(H(cone, R)), 0, `${R} should be off the surface`);
    assert.equal(Math.sign(H(scaled, R)), Math.sign(H(cone, R)), `${R}`);
    near(H(scaled, R) * 5, H(cone, R), 1e-4);
  }
});

test('scale, rotate and translate apply in that order', () => {
  const shape = { sphere: { center: [1, 0, 0], radius: 1 } };
  const moved = packed(shape, {
    scale: 2,                                       // centre (2,0,0), radius 2
    rotate: { axis: [0, 0, 1], degrees: 90 },       // centre (0,2,0)
    translate: [0, 0, 5],                           // centre (0,2,5)
  });
  onSurface(moved, [0, 4, 5]);
  onSurface(moved, [0, 0, 5]);
  inside(moved, [0, 2, 5]);
  near(moved.curvature_perp, 1 / 4);

  // Nesting is how any other order is said.
  const other = packed({ union: [{ ...shape, translate: [0, 0, 5] }] }, { scale: 2 });
  onSurface(other, [4, 0, 10]);                     // translated first, then scaled
});

test('transforms compose through use, and leave a prototype alone', () => {
  const built = compileScene({
    materials: {}, lights: [],
    objects: { bar: { cylinder: { center: [0, 0, 0], axis: [0, 0, 1], radius: 1 } },
               tipped: { use: 'bar', rotate: { axis: [1, 0, 0], degrees: 90 },
                         translate: [0, 0, 3] } },
    root: { sphere: { center: [0, 0, 0], radius: 40 }, inside: { union: ['bar', 'tipped'] } },
  });
  const f = new Float32Array(packNodes(built.nodes));
  const axisOf = (i) => [f[i * 16], f[i * 16 + 1], f[i * 16 + 2]];
  const axes = built.nodes.map((_, i) => axisOf(i));
  assert.ok(axes.some((a) => Math.abs(a[2]) > 0.99), 'the upright bar is still upright');
  assert.ok(axes.some((a) => Math.abs(a[1]) > 0.99), 'the tipped one lies along Y');
});

test('bad transforms are refused', () => {
  const shape = { sphere: { center: [0, 0, 0], radius: 1 } };
  assert.throws(() => packed(shape, { scale: 0 }), /positive factor/);
  assert.throws(() => packed(shape, { scale: -2 }), /positive factor/);
  assert.throws(() => packed(shape, { rotate: { degrees: 90 } }), /needs an axis/);
  assert.throws(() => packed(shape, { rotate: { axis: [0, 0, 0], degrees: 90 } }), /no direction/);
  assert.throws(() => packed(shape, { rotate: { axis: [0, 0, 1] } }), /degrees or radians/);
  assert.throws(() => packed(shape, { rotate: { axis: [0, 0, 1], degrees: 1, radians: 1 } }),
                /degrees or radians/);
  assert.throws(() => packed(shape, { rotate: { axis: [0, 0, 1], degrees: 90, pivot: [1, 2] } }),
                /\[x, y, z\] point/);
});

test('a rotated group still checks its members and bounds them', () => {
  const scene = (degrees) => ({
    materials: {}, lights: [],
    objects: {
      a: { spheroid: { center: [-3, 0, 0], axis: [0, 0, 1], semiAxial: 2, semiRadial: 1 } },
      b: { spheroid: { center: [3, 0, 0], axis: [0, 0, 1], semiAxial: 2, semiRadial: 1 } },
    },
    root: { group: ['a', 'b'], rotate: { axis: [0, 1, 0], degrees } },
  });
  compileScene(scene(0));
  compileScene(scene(37));                          // the group is built, then turned
});
