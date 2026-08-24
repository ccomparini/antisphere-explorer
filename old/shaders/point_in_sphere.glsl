
// written by https://chatgpt.com/c/67cb57b5-9f2c-8002-9b26-f5306f38c2c4

// Returns:
//   -1.0 => point is outside
//    0.0 => point is exactly on the surface
//   +1.0 => point is inside
float pointInSphere(vec3 point, vec4 sphereCenter, float antiradius) {
    vec3 v = sphereCenter.xyz;
    float w = sphereCenter.w;

    if (abs(w) < 1e-6) {
        // Plane case
        float d = dot(point, normalize(v)) - antiradius;
        return (d > 1e-5) ? -1.0 : (d < -1e-5) ? 1.0 : 0.0;
    } else {
        // Regular sphere
        vec3 center = v / w;
        float r = abs(antiradius) / abs(w);
        float dist2 = dot(point - center, point - center);
        float r2 = r * r;
        return (dist2 < r2 - 1e-5) ? 1.0 :
               (dist2 > r2 + 1e-5) ? -1.0 : 0.0;
    }
}

