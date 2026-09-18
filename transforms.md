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
    c' = c/s
    d' = d/s   (or leave d unnormalized -- see overall-scale-ambiguity note in the
                spheroid summary; d only matters up to the same positive multiple as K,c)

COMPLEMENT: negate all of {K, c, d} (equivalently, negate Q entirely).
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

## 4. R-lift / S-lift form -- there IS a direct transform rule, not just "recompute"

R-lift = (Rx,Ry,Rz, R.R, 1). This is a QUADRATIC (not linear) function of R, so it does
NOT transform via M directly the way a plain point does. But for a SIMILARITY
transform specifically (A = s*Rot -- i.e. rotation + uniform scale + translation,
which is exactly the class this whole system supports), R-lift DOES transform via a
single fixed 5x5 matrix, call it L(M), because the "extra" quadratic term R.R is
itself invariant under rotation and picks up only LINEAR terms from translation and a
simple scalar factor from scaling:

    R'.R' = (s*Rot*R + t).(s*Rot*R + t) = s^2*(R.R) + 2*s*(transpose(Rot)*t).R + |t|^2

Since every term on the right is either the original R.R (coefficient s^2), linear in
R's components (coefficient vector 2*s*transpose(Rot)*t), or constant (|t|^2), the
whole of R-lift' is a LINEAR function of R-lift's 5 components. Writing L(M) as the
5x5 matrix such that R-lift' = L(M) * R-lift:

    L(M) = [ s*Rot         0     t     ]   (rows 1-3: the ordinary point transform,
            [ 2*s*transpose(Rot)*t   s^2   |t|^2 ]   row 4: the induced R.R transform,
            [ 0 0 0        0     1     ]   row 5: trivial

Then, exactly parallel to the Q congruence rule (same logic: R-lift.S-lift must equal
R-lift'.S-lift' for corresponding points):

    S-lift' = transpose(inverse(L(M))) * S-lift

VERIFIED numerically: sphere center (2,0,0), r=1 -> n=(1,0,0), a=3, k=0.5,
S-lift=(-2,0,0,0.5,1.5). Translating by t=(1,0,0) (s=1, Rot=I):
  - Via the {n,a,k} recipe (section 1): n'=(1,0,0), a'=4, k'=0.5
    -> S-lift' = (-3, 0, 0, 0.5, 4)
  - Via L(M) congruence: built L(M) and inverse(L(M)) explicitly, computed
    transpose(inverse(L(M))) * S-lift directly
    -> got (-3, 0, 0, 0.5, 4)
  Identical. Confirms the lifted form has a genuine, non-derived transform rule for
  similarity transforms -- it's just a 5-dimensional analog of the same congruence
  idea, not reducible to a simpler dot-product trick, and it does NOT extend past
  similarity transforms (non-uniform scale/shear breaks the "R.R stays linear in
  R-lift" property this whole section depends on).

## Summary table

|              | Rotation (origin) | Translation      | Uniform scale     |
|--------------|-------------------|------------------|-------------------|
| {n,a,k}      | n'=Rot n          | k unchanged;     | n unchanged;      |
|              | a,k unchanged     | n,a via V-formula| a'=sa, k'=k/s     |
| {K,c,d}      | K'=Rot K Rot^T    | K unchanged;     | K'=K/s, c'=c/s,   |
|              | c'=Rot c          | c'=c-Kt, d' below| d'=d/s            |
| Q (4x4)      | Q'=M^-T Q M^-1, same rule in every case, M built from the above         |
| R-lift/S-lift| S-lift'=L(M)^-T S-lift, same L(M)-congruence rule in every case         |



