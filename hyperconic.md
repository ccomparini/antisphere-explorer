# Antisphere: Spheroid Extension (K/c/d form, physical meaning, transforms, complement)

## Terminology note

"Spheroid" = rotationally-symmetric ellipsoid: ONE axis of symmetry, TWO distinct
curvature values (k_par along the axis, k_perp -- repeated -- around it). This is
everything covered below. "Ellipsoid" is reserved for the fully general triaxial case
(three independent curvatures, no axis of symmetry, not yet worked out) -- use
"spheroid" until/unless that generalization is actually built.

## Motivation

The plain antisphere {n, a, k} compresses "position" and "shape" into one direction n,
which only works because a sphere has NO preferred direction of its own -- the isotropic
curvature block K = k*I means inverse(K) is also a multiple of I, so the center
C = -inverse(K)*c is automatically parallel to c, and one vector n could serve double
duty. A spheroid has a real geometric axis, generally NOT aligned with the direction to
the center once translated to a general position -- so the compressed format breaks
down and a more explicit form is needed.

## The K/c/d representation, and Q spelled out

Quadric form: transpose(X) * Q * X = 0, X = (Rx,Ry,Rz,1)

  K = k_perp * I + (k_par - k_perp) * (n outer n)

    - n          = unit "axis of revolution" (symmetry axis) of the spheroid
    - k_par      = curvature ALONG the axis n (through the two "poles")
    - k_perp     = curvature in every direction PERPENDICULAR to n (around the "equator")
    - k_par = k_perp  =>  K reduces to k*I  =>  ordinary isotropic sphere (special case)

  c, d          = linear and constant terms. For the spheroid these are stored/derived
                  directly -- NOT compressed into a single scalar "a" the way the plain
                  sphere does, because that compression is exactly what breaks under
                  translation once an axis exists (see below).

Writing K out with n=(nx,ny,nz), the full symmetric 4x4 Q is:

  Q = [ k_perp + (k_par-k_perp)*nx*nx,   (k_par-k_perp)*nx*ny,          (k_par-k_perp)*nx*nz,          cx ]
      [ (k_par-k_perp)*nx*ny,            k_perp + (k_par-k_perp)*ny*ny, (k_par-k_perp)*ny*nz,          cy ]
      [ (k_par-k_perp)*nx*nz,            (k_par-k_perp)*ny*nz,          k_perp + (k_par-k_perp)*nz*nz, cz ]
      [ cx,                              cy,                            cz,                             d ]

  (For the running worked example n=(0,1,0), k_perp=0.5, k_par=1, C=(2,0,0), giving
  c=(-1,0,0), d=1.5, this evaluates to the diagonal:
     Q = [[0.5,  0,   0,  -1 ],
          [0,    1,   0,   0 ],
          [0,    0,  0.5,  0 ],
          [-1,   0,   0,  1.5]]
   -- diagonal only because n happened to be axis-aligned; in general the
   off-diagonal (k_par-k_perp)*ni*nj terms are nonzero.)

  Center:  C = -inverse(K) * c
  (For plain sphere K=k*I this reduces to the familiar C = a*n - n/(2k).)

  Semi-axis length along any unit direction u:  sqrt(E / k_u), where k_u is k_par if
  u=n, k_perp if u is perpendicular to n, and E is the shared constant obtained by
  completing the square (E depends on K, c, d together).

  Plane case: K = 0 (both k_par=k_perp=0) reduces the quadric to 2*c.R + d = 0, i.e.
  n = c/|c|, offset a = -d/(2|c|) -- planes remain exactly representable, still
  reducible to the familiar compact {n,a} form as a special case.

Storage cost: axis n (2 true dof) + k_par + k_perp (2) + c (3) + d (1, often
normalizable away) =~ 7-8 numbers for a general-position spheroid, vs. 5 for a sphere.

## Physical meaning of k_par vs k_perp

Larger k = smaller radius in that direction = surface curves back on itself more
tightly (k=0 = flat = never curves, the plane limit).

  - k_par > k_perp  =>  OBLATE   (flattened along the axis, wide equator)
                        e.g. an M&M, a hamburger patty, Earth's actual shape
  - k_par < k_perp  =>  PROLATE  (stretched along the axis, narrow equator)
                        e.g. an American football / rugby ball, a watermelon
  - k_par = k_perp  =>  sphere (no preferred direction at all)

CAVEAT: k_par / k_perp are the coefficients in the quadratic form evaluated along
those directions -- they determine both semi-axis lengths correctly, but they are NOT
the same as the true local radius of curvature at a specific surface point (that true
value mixes both semi-axes together, e.g. radius-of-curvature-at-pole = a_perp^2/a_par
for an ellipse). Use k_par/k_perp for shape/storage/transforms; derive true
point-curvature separately if ever needed (e.g. adaptive tessellation density).

REJECTED ANALOGY (worth remembering NOT to reach for this again): "two k's <-> two
foci of an ellipse, like one k <-> one center for a sphere." Does not hold. A 2D
ellipse has 2 foci; a 3D spheroid's foci sweep out a whole CIRCLE (not 2 points); a
general triaxial ellipsoid's foci form curves, not points. The "2" in k_par/k_perp
counts distinct curvature values (a degree-of-freedom count for K), which is a
different kind of "2" than a focus count -- don't build further intuition on that
match, it's coincidental. Separately, "one center" is not special to spheres --
C=-inverse(K)*c gives exactly one center for spheres, spheroids, AND general
ellipsoids alike; only the shape *around* that center changes.

## Transforms (all verified numerically against n=(0,1,0), k_perp=0.5, k_par=1, C=(2,0,0))

ROTATION about origin (block A=Rot, t=0):
    K' = Rot * K * transpose(Rot)  =>  n' = Rot*n ; k_par, k_perp unchanged
    c' = Rot * c
  (ordinary rigid-vector rule; verified: 90-degree rotation about z sends
   n=(0,1,0) -> (-1,0,0) and recovers C' = Rot*C correctly)

TRANSLATION by t (block A=I):
    K' = K                      <-- EXACT, unconditional, for ANY symmetric K
    c' = c - K*t
    d' = d - 2(c.t) + transpose(t)*K*t
  Verified with a translation NOT aligned to the axis (t=(1,0,1)): c changes
  direction substantially, but K is bit-for-bit unchanged, and the recovered
  center C' = -inverse(K)*c' comes out to exactly C+t, with shape (E) preserved.

UNIFORM SCALE by s about origin (block A=s*I):
  Canonical version, consistent with the plain-sphere k'=k/s rule:
    n unchanged
    k_par'  = k_par / s
    k_perp' = k_perp / s
    C' = s * C
  Verified: s=2 doubles both semi-axes (1 -> 2, 1/sqrt(2) -> sqrt(2)) and doubles
  the center position.
  Negative s: K depends on n only via (n outer n), so sign(s) does NOT flip n for
  the shape test (unlike the plain-sphere case) -- (n outer n) is identical for n
  and -n. If n is also used elsewhere as a texture/orientation pole, track sign(s)
  separately for that purpose only.

## THE KEY RESULT: why the axis n does not swim under translation

n is defined as the eigenvector of K belonging to K's single NON-repeated eigenvalue
(K's three eigenvalues are k_par, k_perp, k_perp). This is a purely algebraic property
of K alone -- it does NOT reference c, the center, or the origin.

Since translation gives K' = K exactly (the literal same matrix), and eigenvectors are
a pure function of a matrix's entries, n' computed from K' is FORCED to equal n --
not approximately, as a direct logical consequence of K'=K.

Contrast with the OLD plain-sphere {n,a,k} encoding: there, n was defined via c
(n = c/|c|, since c was constrained parallel to n by construction). c DOES change
under translation (c' = c - K*t) -- so a direction derived from c necessarily swims.
That was the mechanism behind the original texture-anchor "swimming" bug.

The fix is NOT "translation doesn't affect direction in general" (c's direction very
much still shifts). The fix is that n was moved to depend on K (provably
translation-invariant) instead of on c (provably NOT translation-invariant). Position
information now lives entirely in c/C; shape+orientation information lives entirely
in K; translation only ever touches the former.

## Complement (CSG solid/empty flip)

GENERAL RULE: negate every coefficient of Q -- equivalently, K'=-K, c'=-c, d'=-d.

Proof: H(R) = transpose(R)*K*R + 2c.R + d. Negating all three terms gives H'(R) =
-H(R), EXACTLY, for ANY symmetric K (isotropic, spheroid-anisotropic, or fully
general triaxial) -- nothing in this derivation depends on K's structure, so it is
MORE general than the old plain-sphere-only "negate n,a,k" rule.

Verified numerically on the worked spheroid example: H(center)=-0.5 (inside) before
negation, +0.5 (outside) after -- exact sign flip.

Center is UNCHANGED by complement: C' = -inverse(K')*c' = -inverse(-K)*(-c) =
-inverse(K)*c = C. Complement flips solid/empty everywhere but leaves center, axis,
and the k_par/k_perp RATIO (oblate-vs-prolate character) all unchanged -- only the
sign of both curvatures flips together, in lockstep.

Reduces correctly to previously-established special cases:
  - Plane (K=0): reduces to c'=-c, d'=-d, i.e. n'=-n, a'=-a -- the original plane
    complement rule.
  - Plain sphere (K=k*I): reduces to negating {n,a,k} together, exactly as derived
    several turns before the spheroid extension existed.

OPEN CAVEAT: this derivation never assumed K is positive-(semi)definite. If K has
mixed-sign eigenvalues (a hyperboloid, not yet explored), Q'=-Q is still the exact
algebraic complement of the region H(R)<=0, but that region is unbounded, so
"complement" means something topologically different there than for a bounded
ellipsoid/spheroid interior. Not resolved, just flagged.

## Open items / not yet covered here

- General (fully triaxial) ELLIPSOIDS: three distinct curvatures, no shared axis of
  revolution, K has no repeated eigenvalue -- eigendecomposition still recovers the
  3 principal directions, but there is no single privileged "n" and all 3 matter
  individually. Do not call the spheroid case "ellipsoid" until this is built.
- Ray intersection for the spheroid (A,B,C in terms of n,c,k_par,k_perp) was already
  derived and verified in a separate note.
- Opposite-sign k_par/k_perp gives a hyperboloid (1 or 2 sheets) rather than a
  spheroid -- noted as falling out of the same formula, not yet explored.
