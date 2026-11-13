/**
 * How the ground of a landable body is coloured and lit, as shader text. The ground tiles near
 * the camera (`material.ts`) and the far view of the body in the space layer
 * (`space/planetShader.ts`) both include it, so the two cannot drift apart: a tile that is fed
 * the far map's normal and tone comes out the same colour as the far view behind it.
 *
 * `tone` is the 0..1 value the shared terrain gives with every height; `kind` is the terrain's
 * own number for the class of the body (0 rocky, 1 ice, 2 desert).
 */

/** Terrain kind of a body class, as `TerrainParams.kind` has it. */
export const groundKind = (cls: string): number => (cls === 'ice' ? 1 : cls === 'desert' ? 2 : 0);

export const GROUND_GLSL = /* glsl */ `
// Bends a direction the way the cube sphere is laid out, for looking it up in a far map.
vec3 cubeWarp(vec3 d) {
  vec3 a = abs(d);
  return atan(d / max(a.x, max(a.y, a.z))) * 1.2732395447351628;
}

// Diffuse reflectance of the ground. Linear colour; follows the body's base colour.
vec3 groundAlbedo(float tone, vec3 base, int kind) {
  if (kind == 1) {
    // Ice: bright plains; where the tone is low, dust has gathered on ridge crests.
    vec3 ice = mix(base, vec3(0.93, 0.96, 1.0), 0.35) * (0.34 + 0.70 * tone);
    vec3 dust = base * vec3(0.36, 0.27, 0.21);
    return mix(dust, ice, smoothstep(0.34, 0.68, tone));
  }
  if (kind == 2) {
    // Desert: pale sand on dune crests and highlands over darker ground.
    return base * (0.42 + 1.15 * tone) * mix(vec3(0.94, 0.97, 1.03), vec3(1.05, 1.0, 0.93), smoothstep(0.35, 0.8, tone));
  }
  // Rocky: dark plains, brighter highlands, fresh ejecta brightest; plains a shade cooler.
  return base * (0.30 + 1.50 * tone) * mix(vec3(0.95, 0.98, 1.05), vec3(1.04, 1.0, 0.95), smoothstep(0.15, 0.65, tone));
}

// Light leaving the ground toward the viewer. n: ground normal, up: straight up at the place,
// l: toward the star, v: toward the viewer (unit vectors in one frame). sun: the star's
// irradiance on a surface facing it, ambient: light from everywhere else, as three's lights
// have them. Dust scatters back toward the light more than a matte surface does, so part of the
// law is Lommel-Seeliger's: the ground stays readable under a low sun and toward the horizon.
vec3 groundLit(vec3 albedo, vec3 n, vec3 up, vec3 l, vec3 v, vec3 sun, vec3 ambient, int kind) {
  float mu0 = max(dot(n, l), 0.0);
  float mu = max(dot(n, v), 0.0);
  // Past the terminator the body itself hides the star, whatever way a slope faces.
  float day = smoothstep(-0.012, 0.008, dot(up, l));
  float dusty = min(2.0 * mu0 / (mu0 + mu + 0.02), 1.5);
  float f = mix(mu0, dusty, 0.3) * day;
  vec3 col = albedo * 0.3183098861837907 * (sun * f + ambient);
  if (kind == 1) {
    // Ice has a broad sheen.
    vec3 h = normalize(l + v);
    col += sun * 0.02 * pow(max(dot(n, h), 0.0), 24.0) * day * step(0.0, dot(n, l));
  }
  return col;
}
`;
