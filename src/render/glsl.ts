/** Shared GLSL snippets: hashing, tileable noise, fbm, voronoi. */
export const GLSL_NOISE = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }

// Tileable value noise with integer period
float tnoise(vec2 p, vec2 per){
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  float a = hash12(mod(i, per));
  float b = hash12(mod(i + vec2(1.0,0.0), per));
  float c = hash12(mod(i + vec2(0.0,1.0), per));
  float d = hash12(mod(i + vec2(1.0,1.0), per));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
// Tileable gradient-ish noise (smoother, -1..1)
float tgnoise(vec2 p, vec2 per){
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  vec2 ga = hash22(mod(i, per))*2.0-1.0;
  vec2 gb = hash22(mod(i+vec2(1,0), per))*2.0-1.0;
  vec2 gc = hash22(mod(i+vec2(0,1), per))*2.0-1.0;
  vec2 gd = hash22(mod(i+vec2(1,1), per))*2.0-1.0;
  float va = dot(ga, f), vb = dot(gb, f-vec2(1,0)), vc = dot(gc, f-vec2(0,1)), vd = dot(gd, f-vec2(1,1));
  return mix(mix(va,vb,u.x), mix(vc,vd,u.x), u.y) * 1.4;
}
float tfbm(vec2 p, float per, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for(int i=0;i<8;i++){ if(i>=oct) break; s += a * tnoise(p, vec2(per)); n += a; p *= 2.0; per *= 2.0; a *= 0.5; }
  return s / n;
}
float tgfbm(vec2 p, float per, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for(int i=0;i<8;i++){ if(i>=oct) break; s += a * tgnoise(p, vec2(per)); n += a; p *= 2.0; per *= 2.0; a *= 0.5; }
  return s / n;
}
// Tileable voronoi: returns (F1, F2, cell id)
vec3 tvoronoi(vec2 p, vec2 per){
  vec2 i = floor(p); vec2 f = fract(p);
  float d1 = 8.0, d2 = 8.0; float id = 0.0;
  for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){
    vec2 g = vec2(float(x), float(y));
    vec2 c = mod(i + g, per);
    vec2 o = hash22(c);
    vec2 r = g + o - f;
    float d = dot(r,r);
    if(d < d1){ d2 = d1; d1 = d; id = hash12(c*1.7+3.1); } else if(d < d2){ d2 = d; }
  }
  return vec3(sqrt(d1), sqrt(d2), id);
}
// Non-tiling 3D value noise
float noise3(vec3 p){
  vec3 i = floor(p); vec3 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash13(i), hash13(i+vec3(1,0,0)), f.x), mix(hash13(i+vec3(0,1,0)), hash13(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(hash13(i+vec3(0,0,1)), hash13(i+vec3(1,0,1)), f.x), mix(hash13(i+vec3(0,1,1)), hash13(i+vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm3(vec3 p){ float s=0.0,a=0.5; for(int i=0;i<5;i++){ s+=a*noise3(p); p=p*2.02+vec3(1.7,9.2,3.1); a*=0.5; } return s; }
float noise2(vec2 p){ return tnoise(p, vec2(100000.0)); }
float fbm2(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<5;i++){ s+=a*noise2(p); p=p*2.03+vec2(1.7,9.2); a*=0.5; } return s; }
`;
