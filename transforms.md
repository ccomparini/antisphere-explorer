# Antisphere Transforms: Compact {n,a,k}, R-lift/S-lift, and Matrix Q Forms

M = 4x4 homogeneous transform: 3x3 block A (rotation*scale) + translation column t,
bottom row [0,0,0,1]. For a similarity transform: A = s*Rot (s = uniform scale,
Rot = rotation matrix, transpose(Rot)=inverse(Rot)).

## 1. Compact {n, a, k} form (plain sphere/plane only -- K=k*I isotropic)

ROTATION about origin (A=Rot, t=0):
    n' = Rot * n ;  a' = a ;  k' = k

TRANSLATION by t (A=I):
    k' = k                                   (exact, always)
    V = (1 - 2*a*k)*n - 2*k*t
    n' = sign(1-2ak) * V / |V|                (general form; see note below)
    a' = (1 - sign(1-2ak)*|V|) / (2k)
  (Plane, k=0, handled directly, not as a limit: n'=n, a'=a + n.t, k'=0)

UNIFORM SCALE by s about origin (A=s*I), signed-k convention (current):
    n' = n ;  a' = s*a ;  k' = k/s            (works uniformly, any nonzero s)

COMPLEMENT (not a transform, but same family): negate all of {n,a,k}.
    H(-n,-a,-k)(R) = -H(n,a,k)(R), exact.

## 2. General K/c/d form (spheroid, and the sphere/plane as special cases of it)

Same three transforms, but expressed directly on K (3x3 symmetric) and c (3-vector),
d (scalar) -- no compression into a single a or n required, and this is what actually
stays correct once K is anisotropic (spheroid) rather than isotropic (sphere):

ROTATION about origin (A=Rot, t=0):
    K' = Rot * K * transpose(Rot)   (for spheroid K = k_perp*I + (k_par-k_perp)*(n⊗n),
                                      this reduces to n'=Rot*n, k_par'=k_par, k_perp'=k_perp)
    c' = Rot * c

TRANSLATION by t (A=I):
    K' = K                          (EXACT, unconditional, for ANY symmetric K --
                                      this is the master fact; everything else in this
                                      section follows from it)
    c' = c - K*t
    d' = d - 2*(c.t) + transpose(t)*K*t

UNIFORM SCALE by s about origin (A=s*I):
    K' = K/s   (spheroid: k_par'=k_par/s, k_perp'=k_perp/s, n unchanged)
    c' = c                          (UNCHANGED -- see below)
    d' = s*d

    Only the ratios matter: H and any positive multiple of it have the same
    surface and the same sign everywhere, so {K/s, c, s*d} and the congruence
    result {K/s^2, c/s, d} are the same quadric. What is NOT the same is
    dividing all three by s: that scales H uniformly and moves nothing at all.
    Section 1's {n,a,k} rule (a'=s*a, k'=k/s) is the one to check against --
    for a sphere it gives centre s*C and radius s*r, i.e. exactly K/s, c, s*d.

COMPLEMENT: negate all of {K, c, d} (equivalently, negate Q entirely). Not the
same as scaling by -1, which by the rule above reflects through the origin as
well: s=-1 gives H'(R) = -H(-R).
    H'(R) = -H(R), exact, for ANY symmetric K -- proven more general than the
    {n,a,k}-only version above, and reduces to it exactly when K=k*I.

## 3. Matrix Q form -- ONE rule, used identically for plain sphere/plane AND spheroid

Q = [ K   c ]      (4x4 symmetric; K=k*I with c built from n,a for plain sphere/plane,
    [ c^T d ]        K anisotropic with c stored directly for spheroid -- same Q shape
                     either way)

TRANSFORM RULE (all three transforms above are special cases of this one line):

    Q' = transpose(inverse(M)) * Q * inverse(M)

This is exactly what was expanded out, block by block, to get the K/c/d formulas in
section 2 -- so yes, confirmed: BOTH matrix forms (plain and spheroid) use this
identical congruence rule. There is no separate rule needed for the spheroid case;
section 2 IS this rule, pre-expanded for convenience.

# Antisphere Transforms: R-lift/S-lift Section, Revised for Practical (Object/GPU) Use

## 4. R-lift / S-lift transform rule

R-lift = (Rx,Ry,Rz, R.R, 1) is a QUADRATIC function of R, so it does not transform
via the object's 4x4 M directly the way a plain point does. But for a SIMILARITY
transform (A = s*Rot: rotation + uniform scale + translation -- exactly what this
whole system supports), R-lift transforms via a single fixed 5x5 matrix L(M):

    R'.R' = (s*Rot*R + t).(s*Rot*R + t)
          = s^2*(R.R) + 2*s*(transpose(Rot)*t).R + |t|^2

Every term on the right is either the original R.R (coefficient s^2), linear in R's
components (coefficient vector 2*s*transpose(Rot)*t), or constant (|t|^2) -- so
R-lift' is a LINEAR function of R-lift's 5 components:

    L(M) = [ s*Rot                    0     t     ]   <- rows 1-3: ordinary point transform
           [ 2*s*transpose(Rot)*t     s^2   |t|^2 ]   <- row 4: induced R.R transform
           [ 0 0 0                    0     1     ]   <- row 5: trivial

IMPORTANT PRACTICAL POINT: L(M) is FULLY DETERMINED by {Rot, s, t} -- the same 7-8
numbers you already store for an ordinary object transform.

Node's S-lift transforms via the same congruence pattern as the 4x4 Q form
(same underlying logic: R-lift.S-lift must equal R-lift'.S-lift' for corresponding
points):

    S-lift' = transpose(inverse(L(M))) * S-lift

    - S-lift  = node's stored, OBJECT-LOCAL, never-changing 5-vector
    - S-lift' = the WORLD-space 5-vector actually sent to the GPU; recomputed by
                JS only when the owning object's {Rot,s,t} changes

VERIFIED numerically (sphere center (2,0,0), r=1 -> S-lift=(-2,0,0,0.5,1.5);
translate by t=(1,0,0), Rot=I, s=1):
  - Via {n,a,k} recipe: n'=(1,0,0), a'=4, k'=0.5 -> S-lift'=(-3,0,0,0.5,4)
  - Via L(M) congruence: transpose(inverse(L(M))) * S-lift -> (-3,0,0,0.5,4)
  Identical, confirming the congruence rule is correct and general.

DOES NOT extend past similarity transforms: non-uniform scale/shear breaks the
"R.R stays linear in R-lift's 5 components" property this whole derivation depends
on (that's the same non-uniform-scale boundary flagged for the K/c/d spheroid form).

## Ray test at GPU/query time -- uses S-lift' directly, no matrix work at all

Given S-lift' = (s1,s2,s3,s4,s5) (already computed, already resident on GPU) and a
ray R(t) = O + t*v:

    A = s4 * (v.v)
    B = (s1,s2,s3).v + 2*s4*(O.v)
    C = (s1,s2,s3).O + s4*(O.O) + s5        [ = H(O), evaluated with S-lift' ]

Solve A*t^2 + B*t + C = 0 as usual (stable quadratic form, per earlier notes; guard
A==0 && B==0 for the degenerate/uninitialized case).

VERIFIED numerically against the translated-sphere example above (O=(0,0,0),
v=(1,0,0), S-lift'=(-3,0,0,0.5,4)): A=0.5, B=-3, C=4 -> t=2,4 -- matches the
translated sphere (new center (3,0,0)) exactly. Cross-checked against the
alternative "transform the ray into local space, test against original S-lift"
route: identical A,B,C both ways, as required.

## Cost tradeoff (per-node, per-object-transform-change vs. per-ray)

- Precompute S-lift' once per (node, transform-change): ~45 flops (the 5x5
  congruence), paid ONLY when the owning object's transform actually changes,
  never per-ray and never per-frame for static objects.
- Per-ray cost thereafter, using S-lift' directly (A,B,C formula above): ~32 flops,
  with ZERO matrix/inverse work in the hot path.
- Alternative (transform ray into node-local space per ray, test against
  never-recomputed local S-lift): ~63 flops per ray, but zero precompute cost ever.
- Break-even: precomputing wins as soon as a node is hit by >=2 rays before its
  transform next changes -- given eager per-transform-change recompute (not
  per-frame), this favors precompute strongly for any object that isn't
  recalculating its transform every single ray.

## Summary table

|              | Rotation (origin) | Translation      | Uniform scale     |
|--------------|-------------------|------------------|-------------------|
| {n,a,k}      | n'=Rot n          | k unchanged;     | n unchanged;      |
|              | a,k unchanged     | n,a via V-formula| a'=sa, k'=k/s     |
| {K,c,d}      | K'=Rot K Rot^T    | K unchanged;     | K'=K/s, c unchanged,|
|              | c'=Rot c          | c'=c-Kt, d' below| d'=s*d              |
| Q (4x4)      | Q'=M^-T Q M^-1, same rule in every case, M built from the above         |
| R-lift/S-lift| S-lift'=L(M)^-T S-lift, same L(M)-congruence rule in every case         |


## Practical architecture (established this session)

- Each node's S-lift is authored/stored ONCE, in OBJECT-LOCAL space (as if the parent
  object sat at identity transform). This never changes for a rigid node.
- Each object carries an ordinary rigid(+uniform-scale) transform: {Rot, s, t} --
  the same 7-8 numbers (quaternion or 3x3 Rot, plus scalar s, plus translation t)
  you'd already track for physics/animation/UI, nothing new introduced for this.
- JS (or a small compute pass) owns {Rot, s, t} and each node's local S-lift.
  Whenever an object's transform changes, JS recomputes S-lift' (WORLD space) for
  EACH of that object's nodes, via the L(M)-congruence below, and ships only the
  resulting 5-float S-lift' per node to the GPU.
- The GPU NEVER sees a 5x5 matrix, never sees {Rot,s,t}, and never recomputes
  anything transform-related. Its entire per-ray job is: take a node's S-lift'
  (5 floats, already sitting in world space) and run the A/B/C ray formula
  (section below) directly. No congruence, no matrix inverse, at ray-test time.
- Recomputation is EAGER, keyed to "this object's transform changed" -- not lazy,
  not per-frame, not per-traversal-visit. A static/unmoving object triggers zero
  recompute work, ever, regardless of how many rays hit its nodes.
- KNOWN OPEN ISSUE (not resolved here, per Chris: "I have a plan"): moving a node
  or group of nodes can change inside/outside relationships between nodes (e.g. in
  a CSG tree, or wherever multiple nodes' relative solid/empty regions interact).
  The per-node S-lift' recompute above handles EACH node's own shape/position
  correctly in isolation; it does NOT by itself address consistency of
  relationships BETWEEN nodes when one moves relative to another.


this is from the math conversation at https://claude.ai/chat/c211f116-4292-4293-b519-06a357138433

