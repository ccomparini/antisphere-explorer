# Revolution Quadrics: Spheroid, Slab, Cylinder, Paraboloid, Hyperboloid, Cone

They aren't really hyperconic sections, despite the name of this file.
Viva la revolution.

## Standard quadric

$H(R) = \mathrm{transpose}(R)\cdot K\cdot R + 2\cdot c\cdot R + d$

- $R$ = the 3D point being tested (a Euclidean vec3 position in 3-space).
- $K$ (a 3x3 matrix — controls the quadratic/curvature part),
- $c$ (a vector — controls the linear part, i.e. which way the whole thing is "tilted" or offset)
- $d$ (a scalar constant).

## What We Store (old/original and new/gemneralized out to revolution quadrics)

"Original" antisphere:  {n,a,k} (normal (vec3), distance along n from origin, curvature)
Handles planes and spheres.  5 total floats.

Generalized out to revolution quadrics: { n (vec3), k_par, k_perp, c (vec3), d }
- n       -- vec3, unit axis direction (derived-in-meaning from K, but stored explicitly)
- k_par   -- scalar curvature relative to 
- k_perp  -- scalar perpendicular curvature
- c       -- vec3, position/linear term (free vector, NOT generally parallel to n)
- d       -- scalar constant term of the quadratic equation


## Common Setup

- $K = k\_perp*I + (k\_par - k\_perp)*(n \otimes n)$   -- n = unit "axis" direction
- $c_n    = c \cdot n$            (component of c ALONG the axis, a scalar)
- $c\_perp = c - c_n*n$        (component of c PERPENDICULAR to the axis, a vector;
                           by construction $c\_perp \cdot n = 0$)

- $x      = R \cdot n$            (a point's coordinate along the axis)
- $R\_perp = R - x*n$          (a point's coordinate in the perpendicular plane)

- $H(R) = k\_par \cdot x^2 + k\_perp \cdot (R\_perp . R\_perp) + 2 \cdot c_n \cdot x + 2 \cdot c\_perp.R\_perp + d$

K's eigenvalues are always (k_par, k_perp, k_perp) -- k_perp repeated (any
perpendicular direction), k_par once (the axis itself).
K invertible  <=>  k_par != 0 AND k_perp != 0.
Center C = -inverse(K)*c exists ONLY when K is invertible; when it exists it is
still just ONE point (true for sphere, spheroid, AND hyperboloids/cone alike --
"one center" is not special to spheres, only the shape AROUND that center differs).
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

Let $\Delta k = k\_par - k\_perp$.
Then we can write the full symmetric 4x4 Q as:


$$
Q =
\begin{bmatrix}
k\_perp+\Delta k\,n_x^2 & \Delta k\,n_xn_y & \Delta k\,n_xn_z & c_x \\
\Delta k\,n_xn_y & k\_perp+\Delta k\,n_y^2 & \Delta k\,n_yn_z & c_y \\
\Delta k\,n_xn_z & \Delta k\,n_yn_z & k\_perp+\Delta k\,n_z^2 & c_z \\
c_x & c_y & c_z & d
\end{bmatrix}
$$


## Table

(note we dmostly on't care if K invertible - it already wasn't in the k=0 plane case)
| k_par        | k_perp       | extra condition        | Shape                    | K invertible? |
|--------------|--------------|-------------------------|---------------------------|----------------|
| k (>0)       | k (=k_par)   | --                      | Sphere                    | Yes            |
| k_par>0      | k_perp>0, unequal | --                 | Spheroid (oblate if k_par>k_perp, prolate if k_par<k_perp) | Yes |
| 0            | 0            | --                      | Plane                     | No (rank 0)    |
| k_par>0      | 0            | c_perp = 0              | Slab (pair of parallel planes) | No (rank 1) |
| k_par>0      | 0            | c_perp != 0             | Parabolic cylinder        | No (rank 1)    |
| 0            | k_perp>0     | c_n = 0                 | Cylinder (right circular) | No (rank 2)    |
| 0            | k_perp>0     | c_n != 0                | Paraboloid of revolution  | No (rank 2)    |
| opposite signs | opposite signs | E-term "wrong" along axis | Hyperboloid of ONE sheet | Yes |
| opposite signs | opposite signs | E-term "wrong" perpendicular | Hyperboloid of TWO sheets | Yes |
| opposite signs | opposite signs | E = 0 (boundary case)  | Cone (degenerate)          | Yes            |
| 0            | 0            | c = 0 AND d = 0 too (i.e. ALL of K,c,d are zero) | Degenerate: H(R)=0 for every R -- not a real primitive; treat as an error/uninitialized sentinel (see separate note on strict vs non-strict comparison and NaN-safe ray handling for this case) | No |

If K is invertible:
  Center:  C = -inverse(K) * c
  (For plain sphere K=k*I this reduces to the familiar C = a*n - n/(2k).)


## Physical meaning of k_par vs k_perp (for the bounded spheroid case)

Larger k = smaller radius in that direction (surface curves back on itself more
tightly); k=0 = flat, never curves (the plane/cylinder/slab limit).
  - k_par > k_perp  =>  OBLATE spheroid (flattened along axis, wide equator)
  - k_par < k_perp  =>  PROLATE spheroid (stretched along axis, narrow equator)
  - k_par = k_perp  =>  sphere (no preferred direction)
CAVEAT: k_par/k_perp give correct semi-axis lengths (semi-axis = sqrt(E/k_i)) but
are NOT the same as true local radius-of-curvature at a point (that mixes both:
radius-of-curvature-at-pole = a_perp^2/a_par for an ellipse).

## Degenerate-family shapes, derived directly (not limits)

PLANE K = 0 (both k_par=k_perp=0) reduces the quadric to 2*c.R + d = 0, i.e.
  n = c/|c|, offset a = -d/(2|c|) -- planes remain exactly representable, still
  reducible to the familiar compact {n,a} form as a special case.


SLAB (k_par>0, k_perp=0, c_perp=0): H depends only on x. Completing the square:
  (x + c_n)^2 = c_n^2 - d = E.  If E>0: two parallel planes at x = -c_n +/- sqrt(E),
  "inside" = the SLAB between them (-c_n-sqrt(E) <= x <= -c_n+sqrt(E)).
  Example verified: n=(0,1,0), k_par=1, k_perp=0, c=(0,-2,0), d=3
  -> H = (y-1)(y-3), planes at y=1 and y=3, inside = 1<=y<=3.

PARABOLIC CYLINDER (k_par>0, k_perp=0, c_perp!=0): the perpendicular linear term
  survives -> curved in the (x, c_perp-direction) plane, perfectly straight
  (extruded) along the remaining perpendicular direction.
  Example verified: c=(1,-2,0) (c_perp=(1,0,0)) -> x = (1-(y-2)^2)/2, a parabola
  extruded along z.

CYLINDER (k_par=0, k_perp>0, c_n=0): H depends only on R_perp -- a circle of
  radius sqrt(E/k_perp) in the perpendicular plane, swept along the ENTIRE axis
  (infinite right circular cylinder).
  Example verified: n=(0,1,0), k_perp=1, c=(1,0,0) (c_n=0), d=0
  -> (Rx+1)^2+Rz^2=1 for every y.

PARABOLOID OF REVOLUTION (k_par=0, k_perp>0, c_n!=0): x becomes a linear function
  of |R_perp - center|^2 -- circular cross-section, opens along the axis.
  Example verified: same as above but c=(1,0.5,0) (c_n=0.5)
  -> Ry = 1 - (Rx+1)^2 - Rz^2.

HYPERBOLOID OF ONE SHEET (opposite-sign k's, "wrong" term along axis): single
  connected surface, waist at its narrowest, unbounded, encircles the axis.
  Example verified: k_par=1 (y-axis), k_perp=-1, d=1 -> Rx^2+Rz^2 = y^2+1
  (circle of radius >=1 at every y, connected).

HYPERBOLOID OF TWO SHEETS (opposite-sign k's, "wrong" term perpendicular):
  two disconnected pieces, each opening away from the axis.
  Example verified: same k's, d=-1 -> y^2-(Rx^2+Rz^2)=1, requires |y|>=1.

CONE (opposite-sign k's, E=0 exactly): the degenerate boundary between the one-
  and two-sheet cases -- the asymptotic surface both approach as |d|->0.
  Example verified: d=0 -> Rx^2+Rz^2 = y^2, apex at origin, C (=-inverse(K)c) is
  literally the apex, a point ON the surface, not enclosed by any solid region.

PRACTICAL FLAG: "K invertible" tells you a single finite point C exists -- it does
NOT tell you that point is a meaningful bounded-solid center. For hyperboloid-of-
two-sheets, C sits in the empty gap BETWEEN the sheets; for the cone, C IS the
apex (on the surface, not inside anything). Only for sphere/spheroid does
"K invertible" also mean "C is the center of a bounded solid interior." Any
bounding-volume or texture-anchor code that assumes otherwise needs an explicit
shape-category check (via sign(k_par), sign(k_perp), sign(E)), not just
"does inverse(K) exist."

## Note on the "invertible" vs "complement" distinction (frequently conflated)
(cmc note:  frequent = I conflated this once and got confused)

"Invertible" = a property of the MATRIX K alone (does inverse(K) exist / are all
its eigenvalues nonzero). Purely about whether a single center point C exists.
"Complement" = negating the ENTIRE Q (K, c, AND d together) to flip inside<->outside
(H'(R) = -H(R), exact for any symmetric K). These are UNRELATED operations --
complement works identically (and equally well) whether or not K happens to be
invertible; e.g. a plane (K=0, about as non-invertible as possible) complements
just fine via n'=-n, a'=-a.

## Ray/line intersection: at most 3 pieces, with one documented exception

Since H(R(t)) is always at most degree-2 in t, a ray meets any of these surfaces
in AT MOST 2 points (splitting the ray into at most 3 in/out/in intervals) --
holds for every row in the table.
EXCEPTION: cylinders, cones, and hyperboloids of ONE sheet are RULED surfaces
(contain entire embedded straight lines). If a ray aligns exactly with one such
ruling, A=B=C=0 IDENTICALLY (not "zero roots" -- the whole polynomial vanishes,
H(R(t))=0 for every t: the entire ray lies exactly on the surface). Ray-
intersection code needs an epsilon-tolerance check for "A and B (and C) are all
~0" as its own case, both for this ruled-surface exception and for the fully-
degenerate all-zero-parameters sentinel node noted in the table above -- in both
cases, falling through to the ordinary quadratic-formula divide risks producing
NaN (0/0), which WGSL's fast-math assumption does NOT guarantee will be caught by
isNan()/comparisons downstream. Guard BEFORE the divide; do not try to detect
NaN after the fact.

## TRANSFORMS

### ROTATION
Rot is a 3x3 rotation matrix
- $ n'=\mathrm{Rot} \cdot n $
- $ k\_par'=k\_par $   (unchanged)
- $ k\_perp'=k\_perp $   (unchanged)
- $ c' = \mathrm{Rot} \cdot c $
- $ d' = d$ (unchanged)

### TRANSLATION
t is a 3-vector translation (x, y, z)
- $ n' = n $         (unchanged)
- $ k\_par' = k\_par $   (unchanged)
- $ k\_perp' = k\_perp $   (unchanged)
- $ c' = c - [k\_perp*t + (k\_par-k\_perp)*(n \cdot t)*n] $
- $ d' = d - 2(c \cdot t) + [k\_perp*(t \cdot t) + (k\_par-k\_perp)*(n \cdot t)^2] $

### SCALE
s is scalar - we scale all axes uniformly
- $ n' = n $         (unchanged)
- $ k\_par' = k\_par/s $
- $ k\_perp' = k\_perp/s $
- $ c' = c/s $
- $ d' = d/s $

## COMPLEMENT
- $ n' = n $         (unchanged)
- $ k\_par' = -k\_par $
- $ k\_perp' = -k\_perp $
- $ c' = -c $
- $ d' = -d $

Note: complement is the same as scaling by -1.

Net result: revolution quadrics need no new transform math at all — every rule already
derived for the spheroid case works.

## Terminology note

"Spheroid" = rotationally-symmetric ellipsoid: ONE axis of symmetry, TWO distinct
curvature values (k_par along the axis, k_perp -- repeated -- around it). This is
everything covered below. "Ellipsoid" is reserved for the fully general triaxial case
(three independent curvatures, no axis of symmetry, not yet worked out) -- use
"spheroid" until/unless that generalization is actually built.

