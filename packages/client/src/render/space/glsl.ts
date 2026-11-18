/** GLSL chunks shared by the space shaders: hashes, gradient noise and fractal sums. */
export const GLSL_NOISE = /* glsl */ `
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float gdot(vec3 i, vec3 f, vec3 o) { return dot(hash33(i + o) * 2.0 - 1.0, f - o); }
// Gradient noise, range about -1..1.
float gnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = mix(mix(gdot(i, f, vec3(0, 0, 0)), gdot(i, f, vec3(1, 0, 0)), u.x),
                mix(gdot(i, f, vec3(0, 1, 0)), gdot(i, f, vec3(1, 1, 0)), u.x), u.y);
  float b = mix(mix(gdot(i, f, vec3(0, 0, 1)), gdot(i, f, vec3(1, 0, 1)), u.x),
                mix(gdot(i, f, vec3(0, 1, 1)), gdot(i, f, vec3(1, 1, 1)), u.x), u.y);
  return mix(a, b, u.z) * 1.2;
}
// Fractal sum of gradient noise, range about -1..1 (mostly within +-0.6).
float fbm(vec3 p, int oct) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 9; i++) {
    if (i >= oct) break;
    s += a * gnoise(p);
    p = p * 2.03 + vec3(17.1, 3.7, 9.2);
    a *= 0.5;
  }
  return s;
}
// Ridged fractal noise, range 0..1, bright along sharp creases.
float ridged(vec3 p, int oct) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 9; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(gnoise(p));
    s += a * n * n;
    p = p * 2.07 + vec3(5.3, 11.9, 2.1);
    a *= 0.5;
  }
  return s;
}
`;
