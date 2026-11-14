# Revolution Quadrics in the Antisphere framework: Spheroid, Slab, Cylinder, Paraboloid, Hyperboloid, Cone

Related reading: https://en.wikipedia.org/wiki/Quadric
This version, however, is in the antisphere framework,
where surfaces are defined in terms of curve.

## Standard quadric

$H(R) = \mathrm{transpose}(R)\cdot K\cdot R + 2\cdot c\cdot R + d$

- $R$ = the 3D point being tested (a Euclidean vec3 position in 3-space).
- $K$ (a 3x3 matrix — controls the quadratic/curvature part),
- $c$ (a vector — controls the linear part, i.e. which way the whole thing is "tilted" or offset)
- $d$ (a scalar constant).

## What We Store (old/original and new/generalized out to revolution quadrics)

"Original" antisphere:
- n - normal (vec3)
- a - distance along n from origin (scalar)
- k - curvature (scalar, note signed)

Handles planes and spheres.  5 total floats.

Generalized out to revolution quadrics: { n (vec3), k_par, k_perp, c (vec3), d }
- n       -- vec3, unit axis direction (derived-in-meaning from K, but stored explicitly)
- k_par   -- scalar curvature along n
- k_perp  -- scalar curvature perpendicular to n
- c       -- vec3, position/linear term (free vector, NOT generally parallel to n)
- d       -- scalar constant term of the quadratic equation

Handles the quadrics of revolution, and one family beyond them: the
parabolic cylinder (see below, and "What the nine numbers can't reach").
9 total floats.  k_par and k_perp may be 0 (both 0 is a plane) or negative.

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

### The parabolic cylinder, in full

The one shape here that is not a surface of revolution: a parabola pushed
straight along a line perpendicular to its plane, rather than spun about its
own axis. A trough, or a half-pipe, where the paraboloid of revolution is a
bowl. It curves in one direction only, and is straight in the other: its
vertex is a line, and its focus a focal line (a solar trough focuses onto a
pipe, where a dish focuses onto a point).

With k_perp = 0, $\mathbf K = k_\parallel \vec n\vec n^{\mathsf T}$ is zero across
the whole plane perpendicular to $\vec n$. In the paraboloid's case
(k_par = 0) only the axis is in K's null space, and only c's axial part can
survive completing the square; here the null space is a plane, and the part
of $\vec c$ in it - $\vec c_\perp$ - can't be absorbed into a centre. So three
directions play three roles:

- $\vec n$, the axis, is the direction the parabola **curves** in. (In the
  paraboloid, $\vec n$ is the axis of symmetry, the way it opens: the roles
  swap.)
- $\vec m = \vec c_\perp/|\vec c_\perp|$ is the direction the trough
  **opens** towards, sign flipped: inside lies along $-\vec c_\perp$.
- $\vec e = \vec n\times\vec m$ is the direction it **runs** along, which
  $H$ ignores: $H(\vec r + t\vec e) = H(\vec r)$.

Written about its vertex line, through $\vec v$, opening along $\vec m$, with
focal length $f$ (the surface is $x^2 = 4fy$, as the paraboloid's is
$|\vec r_\perp|^2 = 4fx$):

$$
\begin{aligned}
x &= (\vec r - \vec v)\cdot\vec n, \qquad y = (\vec r - \vec v)\cdot\vec m \\
H(\vec r) &= x^2 - 4fy \\
k_\parallel &= 1, \qquad k_\perp = 0 \\
\vec c &= -(\vec n\cdot\vec v)\,\vec n - 2f\,\vec m \\
d &= (\vec n\cdot\vec v)^2 + 4f\,(\vec m\cdot\vec v)
\end{aligned}
$$

which is `about(n, 1, 0, v, -4f m, 0)` in `public/antisphere-scene.js`'s
terms. **Inside** ($H < 0$, so $y > x^2/4f$) is the region the trough
cups: where water would stand in it. Going back from the nine numbers:
$\vec m = -\vec c_\perp/|\vec c_\perp|$, $f = |\vec c_\perp|/(2k_\parallel)$,
and the vertex line is where $\vec r\cdot\vec n = -c_n/k_\parallel$ and $H = 0$.

The scene gallery's `exhibit-quadric` (`public/scenes/scene-gallery.json`)
is one: $\vec n = \hat x$, $\vec c = (0, 0, -0.4)$, $d = 0.4$, so
$H = x^2 - 0.8z + 0.4$ - vertex line $z = 0.5$ along $y$, opening up,
$f = 0.2$. It has no named primitive; scenes write it as a `"quadric"`
(`scene-format.md`, Primitives).

Like the cylinder it is a **ruled surface** - every line along $\vec e$
through a point of it lies in it - so a ray along $\vec e$ starting on it
stays on it (see the next section). Unlike the cylinder, its rulings run in
that one direction only.

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

## Ray/line intersection: at most 3 pieces, with one documented exception

Since H(R(t)) is always at most degree-2 in t, a ray meets any of these surfaces
in AT MOST 2 points (splitting the ray into at most 3 in/out/in intervals) --
holds for every row in the table.
EXCEPTION: cylinders, parabolic cylinders, cones, and hyperboloids of ONE
sheet are RULED surfaces (planes and slabs trivially so)
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
s is a positive scalar - we scale all axes uniformly about the origin
- $ n' = n $         (unchanged)
- $ k\_par' = k\_par/s $
- $ k\_perp' = k\_perp/s $
- $ c' = c $         (unchanged)
- $ d' = s\,d $

Substituting $R/s$ for $R$ gives $H(R/s) = k\_perp (R \cdot R)/s^2 + \ldots + 2(c
\cdot R)/s + d$; clearing the leading $1/s^2$ is where $c$ stays put and $d$ picks
up the $s$.

Dividing all four by $s$ - as this section used to say - scales $H$ itself and
leaves the surface exactly where it was, since the surface is where $H$ vanishes.
That no-op is invisible to any check that only looks at signs, so it is worth
stating plainly.

Sanity check on a sphere of centre $C$ and radius $r$, where $k = 1/2r$, $c = -kC$
and $d = k(|C|^2 - r^2)$: scaling it to centre $sC$ and radius $sr$ gives exactly
$k/s$, the same $c$, and $s\,d$.

## COMPLEMENT
- $ n' = n $         (unchanged)
- $ k\_par' = -k\_par $
- $ k\_perp' = -k\_perp $
- $ c' = -c $
- $ d' = -d $

Note: complement is NOT scaling by -1, though it looks that way if the scale
rule above is misread as dividing everything by $s$. Under the rule as stated,
$s = -1$ gives $H'(R) = -H(-R)$: the shape reflected through the origin *and*
complemented. The complement on its own is the negation above.

Net result: revolution quadrics need no new transform math at all — every rule already
derived for the spheroid case works.

## What the nine numbers can't reach

$\mathbf K$'s eigenvalues are always $(k_\parallel, k_\perp, k_\perp)$: two always
equal. When $\mathbf K$ inverts, $\vec c$ only moves the centre, so the shape
keeps the circular symmetry the repeated eigenvalue gives it - a quadric of
revolution. When it doesn't, the part of $\vec c$ in $\mathbf K$'s null space
survives: along the axis (k_par = 0) that is the paraboloid of revolution,
still symmetric; across a plane (k_perp = 0) it is the parabolic cylinder,
the one shape with no axis of revolution.

Out of reach, since each needs three independent eigenvalues or a sign
pattern such as $(+, -, 0)$: the triaxial ellipsoid; elliptic cylinders,
cones and paraboloids; the hyperbolic paraboloid (the saddle); the
hyperbolic cylinder; and a pair of intersecting planes. A full symmetric
$\mathbf K$ would reach them all, at 6 numbers for the quadratic part instead of
4, and at the cost of the cheap $\delta = 0$ test for spheres and planes.
Relatedly, only similarity transforms keep a node in this form
(`transforms.md`): a non-uniform scale or shear takes it out.

## Terminology note

"Spheroid" = rotationally-symmetric ellipsoid: ONE axis of symmetry, TWO distinct
curvature values (k_par along the axis, k_perp -- repeated -- around it). This is
everything covered below. "Ellipsoid" is reserved for the fully general triaxial case
(three independent curvatures, no axis of symmetry, not yet worked out) -- use
"spheroid" until/unless that generalization is actually built.

