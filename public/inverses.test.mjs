// Tests for the shape inverses. Run with:
//   node --test inverses.test.mjs
//
// Each shape is built through compileScene, so what is inverted is exactly
// what a scene file produces, transforms and all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileScene, fromSphere, fromPlane, fromSpheroid, fromCylinder,
         fromSlab, fromCone, fromParaboloid, fromHyperboloid } from './antisphere-scene.js';

const primOf = (shape, extra = {}) =>
  compileScene({ materials: {}, lights: [], root: { ...shape, ...extra } }).nodes[1].prim;

const invert = (fn, prim) => fn(prim.axis, prim.k_par, prim.k_perp, prim.linear, prim.constant);

const close = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b)),
            `${a} is not ${b}`);
const closeVec = (a, b, eps = 1e-6) => a.forEach((v, i) => close(v, b[i], eps));
// An axis has no preferred direction; either way round describes the shape.
const closeAxis = (a, b) => {
  const flip = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < 0 ? -1 : 1;
  closeVec(a, b.map((v) => v * flip));
};

// -- each shape comes back as it went in ------------------------------------------

test('sphere', () => {
  const got = invert(fromSphere, primOf({ sphere: { center: [1, -2, 3], radius: 2.5 } }));
  assert.equal(got.inverseOk, true);
  closeVec(got.center, [1, -2, 3]);
  close(got.radius, 2.5);
});

test('plane, including an unnormalized normal', () => {
  const got = invert(fromPlane, primOf({ plane: { normal: [0, 0, 2], offset: 3 } }));
  assert.equal(got.inverseOk, true);
  closeVec(got.normal, [0, 0, 1]);
  close(got.offset, 1.5);                      // offset was per unit normal
});

test('spheroid, prolate and oblate', () => {
  for (const [axial, radial] of [[2, 0.7], [0.6, 1.9]]) {
    const got = invert(fromSpheroid, primOf({ spheroid: {
      center: [0, 1, -1], axis: [0, 1, 1], semiAxial: axial, semiRadial: radial } }));
    assert.equal(got.inverseOk, true, `${axial} by ${radial}`);
    closeVec(got.centre, [0, 1, -1]);
    closeAxis(got.axis, [0, Math.SQRT1_2, Math.SQRT1_2]);
    close(got.semiAxial, axial);
    close(got.semiRadial, radial);
  }
});

test('cylinder', () => {
  const got = invert(fromCylinder, primOf({ cylinder: {
    center: [2, 0, -3], axis: [0, 0, 1], radius: 0.8 } }));
  assert.equal(got.inverseOk, true);
  close(got.radius, 0.8);
  closeAxis(got.axis, [0, 0, 1]);
  // Any point on the axis is as good as any other; only the across part is fixed.
  closeVec([got.centre[0], got.centre[1]], [2, 0]);
});

test('slab', () => {
  const got = invert(fromSlab, primOf({ slab: {
    center: [0, 0, 4], axis: [0, 0, 1], thickness: 1.5 } }));
  assert.equal(got.inverseOk, true);
  close(got.thickness, 1.5);
  close(got.centre[2], 4);
});

test('cone', () => {
  const got = invert(fromCone, primOf({ cone: {
    apex: [1, 1, 2], axis: [0, 0, 1], slope: 0.75 } }));
  assert.equal(got.inverseOk, true);
  closeVec(got.apex, [1, 1, 2]);
  close(got.slope, 0.75);
});

test('paraboloid', () => {
  const got = invert(fromParaboloid, primOf({ paraboloid: {
    vertex: [0, 0, 1], axis: [0, 0, 1], focal: 0.6 } }));
  assert.equal(got.inverseOk, true);
  closeVec(got.vertex, [0, 0, 1]);
  close(got.focal, 0.6);
});

test('hyperboloid, one sheet and two', () => {
  for (const sheets of [1, 2]) {
    const got = invert(fromHyperboloid, primOf({ hyperboloid: {
      center: [0, 2, 0], axis: [0, 0, 1], radius: 1.2, semiAxial: 0.9, sheets } }));
    assert.equal(got.inverseOk, true, `${sheets} sheets`);
    assert.equal(got.sheets, sheets);
    closeVec(got.centre, [0, 2, 0]);
    close(got.radius, 1.2);
    close(got.semiAxial, 0.9);
  }
});

// -- through the transforms -------------------------------------------------------

test('a moved, turned and scaled shape inverts to where it ended up', () => {
  const got = invert(fromCylinder, primOf(
    { cylinder: { center: [0, 0, 0], axis: [0, 0, 1], radius: 1 } },
    { scale: 2, rotate: { axis: [1, 0, 0], degrees: 90 }, translate: [3, 0, 0] }));
  assert.equal(got.inverseOk, true);
  close(got.radius, 2);                        // scaled
  closeAxis(got.axis, [0, 1, 0]);              // turned onto +y
  closeVec([got.centre[0], got.centre[2]], [3, 0]);   // moved
});

test('scaling shows up in the lengths, not in the shape', () => {
  const at = (shape, fn, factor) => invert(fn, primOf(shape, { scale: factor }));

  const slab = at({ slab: { center: [0, 0, 2], axis: [0, 0, 1], thickness: 1.5 } }, fromSlab, 3);
  assert.equal(slab.inverseOk, true);
  close(slab.thickness, 4.5);
  close(slab.centre[2], 6);

  // A cone about its apex is scale-invariant, so only the apex moves.
  const cone = at({ cone: { apex: [1, 0, 0], axis: [0, 0, 1], slope: 0.5 } }, fromCone, 3);
  close(cone.slope, 0.5);
  closeVec(cone.apex, [3, 0, 0]);

  const dish = at({ paraboloid: { vertex: [0, 0, 1], axis: [0, 0, 1], focal: 0.6 } },
                  fromParaboloid, 3);
  close(dish.focal, 1.8);
  closeVec(dish.vertex, [0, 0, 3]);

  const waist = at({ hyperboloid: { center: [0, 0, 0], axis: [0, 0, 1],
                                    radius: 1.2, semiAxial: 0.9, sheets: 2 } },
                   fromHyperboloid, 3);
  close(waist.radius, 3.6);
  close(waist.semiAxial, 2.7);
  assert.equal(waist.sheets, 2);
});

test('a complemented shape is still the same shape', () => {
  const plain = invert(fromSphere, primOf({ sphere: { center: [1, 0, 0], radius: 2 } }));
  const flipped = invert(fromSphere, primOf({ sphere: { center: [1, 0, 0], radius: 2 },
                                              complement: true }));
  assert.equal(flipped.inverseOk, true);
  closeVec(flipped.center, plain.center);
  close(flipped.radius, plain.radius);
});

// -- what inverseOk is for ---------------------------------------------------------

test('the wrong inverse says so, and still gives its best effort', () => {
  const sphere = primOf({ sphere: { center: [0, 0, 0], radius: 1 } });
  const cone = primOf({ cone: { apex: [0, 0, 0], axis: [0, 0, 1], slope: 1 } });
  const cylinder = primOf({ cylinder: { center: [0, 0, 0], axis: [0, 0, 1], radius: 1 } });

  assert.equal(invert(fromPlane, sphere).inverseOk, false, 'a sphere is no plane');
  assert.equal(invert(fromCone, sphere).inverseOk, false, 'curvatures agree in sign');
  assert.equal(invert(fromSphere, cone).inverseOk, false, 'a cone is not isotropic');
  assert.equal(invert(fromSphere, cylinder).inverseOk, false);
  assert.equal(invert(fromCylinder, sphere).inverseOk, false);
  assert.equal(invert(fromSlab, cylinder).inverseOk, false, 'curvature is across, not along');
  assert.equal(invert(fromParaboloid, cylinder).inverseOk, false, 'nothing opens it');

  // Best effort means numbers, not exceptions: a plane read off a sphere
  // still points somewhere sensible.
  const asPlane = invert(fromPlane, primOf({ sphere: { center: [0, 0, 5], radius: 1 } }));
  assert.equal(asPlane.inverseOk, false);
  assert.equal(asPlane.normal.length, 3);
  assert.ok(Number.isFinite(asPlane.offset));
});

test('a cone and a hyperboloid are told apart by E, not by their curvatures', () => {
  const cone = primOf({ cone: { apex: [0, 0, 0], axis: [0, 0, 1], slope: 1 } });
  const hyper = primOf({ hyperboloid: { center: [0, 0, 0], axis: [0, 0, 1],
                                        radius: 1, semiAxial: 1 } });
  assert.equal(invert(fromCone, cone).inverseOk, true);
  assert.equal(invert(fromHyperboloid, cone).inverseOk, false, 'a cone has no waist');
  assert.equal(invert(fromHyperboloid, hyper).inverseOk, true);
  assert.equal(invert(fromCone, hyper).inverseOk, false, 'a hyperboloid misses its centre');
});

test('a quadric written by hand inverts to whatever it really is', () => {
  // The parabolic cylinder from the gallery: curvature along the axis only,
  // with c pulling perpendicular to it. It is no paraboloid and no slab.
  const trough = primOf({ quadric: { axis: [1, 0, 0], k_par: 1, k_perp: 0,
                                     c: [0, 0, -0.4], d: 0.4 } });
  assert.equal(invert(fromSlab, trough).inverseOk, false, 'c is not along the axis');
  assert.equal(invert(fromParaboloid, trough).inverseOk, false);
  assert.equal(invert(fromCylinder, trough).inverseOk, false);
});
