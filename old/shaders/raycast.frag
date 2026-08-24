#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2 u_resolution;
uniform float u_time;

// test spheres;  in reality, pass these in
const int SPHERE_COUNT = 3;
vec4 spheres[SPHERE_COUNT];
float antiradii[SPHERE_COUNT];

// === Ray-Sphere Intersection ===
bool intersectSphere(
    vec3 rayOrigin,
    vec3 rayDir,
    vec4 sphereCenter,
    float antiradius,
    out float t,
    out vec3 normal
) {
    vec3 v = sphereCenter.xyz;
    float w = sphereCenter.w;

    float O_dot_v = dot(rayOrigin, v);
    float D_dot_v = dot(rayDir, v);
    float num = antiradius - O_dot_v - w;

    if (abs(D_dot_v) < 1e-6) {
        return false;
    }

    float t_linear = num / D_dot_v;

    if (abs(w) < 1e-6) {
        // Plane case
        if (t_linear < 0.0) return false;
        t = t_linear;
        normal = normalize(v);
        return true;
    } else {
        // Sphere case
        vec3 center = v / w;
        vec3 L = center - rayOrigin;
        float tca = dot(L, rayDir);
        float d2 = dot(L, L) - tca * tca;
        float r = abs(antiradius) / abs(w);
        float r2 = r * r;

        if (d2 > r2) {
            return false;
        }

        float thc = sqrt(r2 - d2);
        float t0 = tca - thc;
        float t1 = tca + thc;

        t = (t0 > 0.0) ? t0 : t1;
        if (t < 0.0) return false;

        vec3 hitPos = rayOrigin + t * rayDir;
        normal = normalize(hitPos - center);
        return true;
    }
}

// === Main Shader ===
void main() {
    // Set up the ray
    vec2 uv = (gl_FragCoord.xy / u_resolution) * 2.0 - 1.0;
    uv.x *= u_resolution.x / u_resolution.y; // Correct for aspect ratio

    vec3 rayOrigin = vec3(0.0, 0.0, 5.0); // Camera at (0, 0, 5)
    vec3 rayDir = normalize(vec3(uv, -1.5)); // Aim into the scene

    // Initialize scene
    spheres[0] = vec4(0.0, 0.0, 0.0, 1.0);  // Sphere at origin
    antiradii[0] = 1.0;                     // Radius 1

    spheres[1] = vec4(0.0, -1.0, 0.0, 0.0); // Plane y = 1 (upward normal)
    antiradii[1] = 1.0;

    spheres[2] = vec4(1.5, 0.0, 0.0, 1.0);  // Sphere offset right
    antiradii[2] = 0.5;                     // Smaller radius

    // Raycast
    float closestT = 1e10;
    vec3 closestNormal = vec3(0.0);
    bool hit = false;

    for (int i = 0; i < SPHERE_COUNT; ++i) {
        float t;
        vec3 n;
        if (intersectSphere(rayOrigin, rayDir, spheres[i], antiradii[i], t, n)) {
            if (t < closestT) {
                closestT = t;
                closestNormal = n;
                hit = true;
            }
        }
    }

    // Color based on normal
    if (hit) {
        vec3 color = 0.5 + 0.5 * closestNormal; // Map normal from [-1,1] to [0,1]
        fragColor = vec4(color, 1.0);
    } else {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0); // Background
    }
}


