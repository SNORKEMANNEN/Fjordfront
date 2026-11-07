/**
 * Procedural surface definitions. Every surf() is tileable over uv∈[0,1].
 * Comment on each states the real-world size one tile represents.
 */
export const SURF = {
  // 4m tile — Norwegian coastal grass: muted green, straw, clover, tiny stones
  grass: /* glsl */ `
  void surf(vec2 uv, out vec3 al, out float r, out float h, out float ao){
    float big = tfbm(uv*4.0, 4.0, 5);
    float mid = tfbm(uv*16.0, 16.0, 4);
    // blade streaks: anisotropic noise
    float bl = tnoise(vec2(uv.x*220.0, uv.y*70.0), vec2(220.0,70.0));
    float bl2 = tnoise(vec2(uv.x*90.0+3.1, uv.y*300.0), vec2(90.0,300.0));
    float blades = max(bl, bl2);
    vec3 g1 = hex(74.,92.,44.), g2 = hex(103.,118.,54.), straw = hex(150.,138.,88.), dark = hex(42.,56.,30.);
    al = mix(g1, g2, smoothstep(0.3,0.7,big));
    al = mix(al, straw, smoothstep(0.62,0.85,mid)*0.55);
    al = mix(al*0.7, al*1.15, blades);
    float dirtp = smoothstep(0.68,0.8,tfbm(uv*6.0+7.0,6.0,4));
    al = mix(al, hex(86.,72.,52.), dirtp*0.6);
    al = mix(al, dark, smoothstep(0.55,0.2,blades)*0.35);
    h = blades*0.6 + mid*0.4 - dirtp*0.3;
    r = mix(0.92, 0.78, blades);
    ao = mix(0.7, 1.0, blades);
  }`,
  // 4m tile — grey gneiss/granite with banding, fractures and lichen
  rock: /* glsl */ `
  void surf(vec2 uv, out vec3 al, out float r, out float h, out float ao){
    float n = tgfbm(uv*5.0, 5.0, 6)*0.5+0.5;
    float band = sin((uv.y*6.2831*3.0) + tgfbm(uv*3.0, 3.0, 4)*5.0)*0.5+0.5;
    vec3 v = tvoronoi(uv*7.0, vec2(7.0));
    float crack = smoothstep(0.0, 0.06, v.y - v.x);
    vec3 v2 = tvoronoi(uv*19.0, vec2(19.0));
    float crack2 = smoothstep(0.0, 0.04, v2.y - v2.x);
    float facet = v.z;
    vec3 c1 = hex(112.,110.,106.), c2 = hex(150.,147.,140.), c3 = hex(84.,82.,80.);
    al = mix(c1, c2, n);
    al = mix(al, c3, band*0.35);
    al *= 0.85 + facet*0.3;
    float speck = step(0.82, tnoise(uv*400.0, vec2(400.0)));
    al = mix(al, hex(190.,186.,178.), speck*0.3);
    // lichen
    float lich = smoothstep(0.66, 0.74, tfbm(uv*9.0+5.0, 9.0, 5));
    float lich2 = smoothstep(0.7, 0.76, tfbm(uv*13.0+11.0, 13.0, 5));
    al = mix(al, hex(156.,150.,110.), lich*0.8);
    al = mix(al, hex(170.,120.,60.), lich2*0.55);
    al *= mix(0.45, 1.0, crack) * mix(0.75, 1.0, crack2);
    h = n*0.6 + facet*0.25 + crack*0.35 + crack2*0.1 + lich*0.05;
    r = mix(0.88, 0.72, n) + lich*0.08;
    ao = mix(0.55, 1.0, crack);
  }`,
  // 3m tile — forest floor: needles, moss, twigs
  forest: /* glsl */ `
  void surf(vec2 uv, out vec3 al, out float r, out float h, out float ao){
    float big = tfbm(uv*3.0, 3.0, 5);
    float moss = smoothstep(0.45, 0.6, tfbm(uv*5.0+2.0, 5.0, 5));
    float needles = 0.0;
    for(int i=0;i<3;i++){
      float a = float(i)*2.1;
      vec2 ruv = mat2(cos(a),-sin(a),sin(a),cos(a))*uv;
      needles = max(needles, tnoise(vec2(ruv.x*600.0, ruv.y*40.0), vec2(600.0,40.0)));
    }
    vec3 nd = mix(hex(92.,64.,40.), hex(140.,98.,60.), needles);
    vec3 ms = mix(hex(60.,82.,36.), hex(96.,116.,50.), tfbm(uv*30.0,30.0,3));
    al = mix(nd, ms, moss);
    al *= 0.75 + big*0.4;
    h = moss*0.5 + needles*0.3 + big*0.2;
    r = mix(0.9, 0.95, moss);
    ao = mix(0.75, 1.0, needles);
  }`,
  // 3m tile — beach gravel & pebbles
  gravel: /* glsl */ `
  void surf(vec2 uv, out vec3 al, out float r, out float h, out float ao){
    vec3 v = tvoronoi(uv*40.0, vec2(40.0));
    float peb = smoothstep(0.55, 0.15, v.x);
    vec3 v2 = tvoronoi(uv*110.0+0.37, vec2(110.0));
    float peb2 = smoothstep(0.5, 0.1, v2.x);
    vec3 pc = mix(hex(120.,116.,108.), hex(178.,170.,156.), v.z);
    pc = mix(pc, hex(90.,86.,82.), step(0.8, v.z));
    vec3 sand = mix(hex(128.,118.,100.), hex(160.,148.,124.), tfbm(uv*20.0, 20.0, 4));
    al = mix(sand, pc, peb);
    al = mix(al, mix(hex(100.,96.,90.), hex(150.,144.,134.), v2.z), peb2*(1.0-peb)*0.8);
    h = peb*0.8 + peb2*0.25*(1.0-peb);
    r = mix(0.85, 0.6, peb);
    ao = mix(0.6, 1.0, max(peb, peb2*0.5)+0.3);
  }`,
  // 6m tile — worn asphalt with aggregate, cracks, patches
  asphalt: /* glsl */ `
  void surf(vec2 uv, out vec3 al, out float r, out float h, out float ao){
    float agg = tnoise(uv*1400.0, vec2(1400.0));
    float agg2 = tnoise(uv*500.0+1.3, vec2(500.0));
    float stain = tfbm(uv*4.0, 4.0, 5);
    vec3 v = tvoronoi(uv*5.0, vec2(5.0));
    float crack = 1.0 - smoothstep(0.0, 0.015, v.y - v.x);
    crack *= smoothstep(0.55, 0.7, tfbm(uv*8.0+3.0, 8.0, 3));
    float patchm = smoothstep(0.62, 0.64, tfbm(uv*2.0+9.0, 2.0, 3));
    al = mix(hex(46.,46.,48.), hex(64.,63.,62.), agg*0.5 + agg2*0.3);
    al *= 0.8 + stain*0.4;
    al = mix(al, hex(36.,36.,38.), patchm*0.8);
    al *= 1.0 - crack*0.6;
    h = agg*0.08 + agg2*0.08 - crack*0.8 + patchm*0.05;
    r = mix(0.9, 0.75, agg) - patchm*0.1;
    ao = 1.0 - crack*0.5;
  }`,
  // 2.4m x 2.4m tile — vertical board-and-batten, painted (uPaint)
  paintedWood: (paint: [number, number, number], wear = 1.0) => /* glsl */ `
  void surf(vec2 uv, out vec3 al, out float r, out float h, out float ao){
    float boards = 12.0;
    float x = uv.x * boards;
    float bi = floor(x); float bx = fract(x);
    float batten = smoothstep(0.0, 0.06, bx) * smoothstep(1.0, 0.94, bx); // board edge
    float bat = 1.0 - smoothstep(0.86, 0.9, abs(bx-0.5)*2.0);
    // grain
    float grain = tnoise(vec2(uv.x*boards*8.0 + bi*7.0, uv.y*3.0 + bi*0.37), vec2(boards*8.0, 3.0));
    float grain2 = tnoise(vec2(uv.x*boards*30.0, uv.y*14.0 + bi), vec2(boards*30.0, 14.0));
    vec3 paint = hex(${paint[0].toFixed(1)}, ${paint[1].toFixed(1)}, ${paint[2].toFixed(1)});
    float dirt = tfbm(vec2(uv.x*6.0, uv.y*1.5), 6.0, 5);
    // vertical rain streaks
    float streak = tnoise(vec2(uv.x*boards*3.0, uv.y*1.0+bi*0.3), vec2(boards*3.0, 1.0));
    float chip = smoothstep(0.74, 0.78, tfbm(uv*vec2(20.0, 10.0) + bi, 20.0, 5)) * ${wear.toFixed(2)};
    vec3 wood = mix(hex(120.,108.,94.), hex(150.,138.,120.), grain);
    al = paint * (0.9 + grain2*0.08) * (0.95 + dirt*0.08);
    al *= 1.0 - streak*0.06*(1.0-uv.y);
    al = mix(al, wood, chip);
    al *= mix(0.55, 1.0, batten);
    h = batten*0.6 + bat*0.2 + grain2*0.05 - chip*0.1;
    r = mix(0.55, 0.85, chip) + dirt*0.1;
    ao = mix(0.6, 1.0, batten);
  }`,
  // 2m tile — weathered grey deck planks (horizontal), gaps, nails
  planks: /* glsl */ `
  void surf(vec2 uv, out vec3 al, out float r, out float h, out float ao){
    float n = 10.0;
    float y = uv.y * n; float pi = floor(y); float py = fract(y);
    float off = hash12(vec2(pi, 3.0));
    float px = fract(uv.x * 2.0 + off);
    float gap = smoothstep(0.0, 0.05, py) * smoothstep(1.0, 0.95, py);
    float endg = smoothstep(0.0, 0.006, px) * smoothstep(1.0, 0.994, px);
    float grain = tnoise(vec2(uv.x*80.0, uv.y*n*6.0 + pi*1.7), vec2(80.0, n*6.0));
    float rings = sin((uv.x*40.0 + tnoise(vec2(uv.x*6.0, pi), vec2(6.0, 1000.0))*6.0)*6.2831)*0.5+0.5;
    float var = hash12(vec2(pi, floor(uv.x*2.0+off)));
    vec3 c = mix(hex(108.,100.,90.), hex(150.,140.,124.), var);
    c = mix(c, hex(92.,80.,62.), smoothstep(0.6,0.9,tfbm(uv*5.0,5.0,4))*0.5);
    al = c * (0.82 + grain*0.2 + rings*0.06);
    // nails
    vec2 nuv = vec2(fract(uv.x*2.0+off)*2.0, py);
    float nail = 1.0 - smoothstep(0.015, 0.03, length(vec2(fract(nuv.x) - 0.5, (nuv.y-0.5)*0.2)));
    al = mix(al, hex(60.,50.,44.), nail);
    float m = gap*endg;
    al *= mix(0.25, 1.0, m);
    h = m*0.7 + grain*0.15 + rings*0.05;
    r = 0.88 - nail*0.3;
    ao = mix(0.4, 1.0, m);
  }`,
  // 4m tile — weathered concrete with formwork seams and stains
  concrete: /* glsl */ `
  void surf(vec2 uv, out vec3 al, out float r, out float h, out float ao){
    float n = tfbm(uv*8.0, 8.0, 6);
    float pores = step(0.85, tnoise(uv*500.0, vec2(500.0)));
    float seams = 1.0 - (1.0-smoothstep(0.0, 0.004, abs(fract(uv.y*2.0)-0.5)-0.496)) * 0.0;
    float sh = smoothstep(0.495, 0.5, abs(fract(uv.y*2.0)-0.5));
    float sv = smoothstep(0.497, 0.5, abs(fract(uv.x*1.0)-0.5));
    float seam = max(sh, sv);
    float streaks = tnoise(vec2(uv.x*40.0, uv.y*2.0), vec2(40.0, 2.0)) * tfbm(uv*3.0, 3.0, 3);
    float moss = smoothstep(0.62, 0.72, tfbm(uv*4.0+1.0, 4.0, 5)) * (1.0-uv.y);
    al = mix(hex(128.,126.,120.), hex(165.,162.,154.), n);
    al *= 1.0 - streaks*0.35;
    al = mix(al, hex(80.,92.,58.), moss*0.6);
    al *= 1.0 - pores*0.3 - seam*0.35;
    h = n*0.4 - pores*0.3 - seam*0.6;
    r = 0.92 - n*0.05;
    ao = 1.0 - seam*0.4;
  }`,
  // 2m tile — corrugated steel (vertical ridges), painted base white (tinted by material), rust
  corrugated: /* glsl */ `
  void surf(vec2 uv, out vec3 al, out float r, out float h, out float ao){
    float ridges = 16.0;
    float s = sin(uv.x * ridges * 6.2831);
    float prof = smoothstep(-0.6, 0.6, s);
    float rust = smoothstep(0.7, 0.84, tfbm(uv*vec2(5.0, 3.0), 5.0, 6)) * 0.8;
    float rust2 = smoothstep(0.5, 0.9, tnoise(vec2(uv.x*ridges*2.0, uv.y*1.5), vec2(ridges*2.0, 1.5))) * smoothstep(0.4, 0.0, uv.y);
    float dirt = tfbm(uv*6.0+4.0, 6.0, 4);
    float scratches = smoothstep(0.93, 0.99, tnoise(vec2(uv.x*400.0, uv.y*6.0), vec2(400.0, 6.0)));
    vec3 paint = vec3(0.82) * (0.88 + dirt*0.2);
    vec3 rc = mix(hex(110.,58.,30.), hex(150.,90.,50.), tfbm(uv*20.0,20.0,3));
    float rm = max(rust, rust2*0.45);
    al = mix(paint, rc, rm);
    al = mix(al, vec3(0.6), scratches*0.3);
    al *= 0.8 + prof*0.25;
    h = prof;
    r = mix(0.5, 0.9, rm);
    ao = mix(0.75, 1.0, prof);
  }`,
  // 2m tile — clay/concrete roof tiles (dark)
  roofTiles: /* glsl */ `
  void surf(vec2 uv, out vec3 al, out float r, out float h, out float ao){
    float rows = 7.0, cols = 6.0;
    float ry = uv.y * rows; float ri = floor(ry); float fy = fract(ry);
    float rx = uv.x * cols + mod(ri, 2.0) * 0.5; float ci = floor(rx); float fx = fract(rx);
    float wave = sin(fx * 6.2831) * 0.5 + 0.5;
    float lip = smoothstep(0.0, 0.15, fy);
    float var = hash12(vec2(ci, ri));
    vec3 c = mix(hex(46.,44.,44.), hex(70.,64.,60.), var);
    float moss = smoothstep(0.62, 0.7, tfbm(uv*5.0, 5.0, 5)) * (1.0 - lip*0.5);
    c = mix(c, hex(84.,96.,52.), moss*0.6);
    al = c * (0.7 + wave*0.35) * mix(0.45, 1.0, lip);
    h = wave * 0.5 + fy * 0.5;
    r = 0.7 - wave*0.15 + moss*0.2;
    ao = mix(0.5, 1.0, lip);
  }`,
  // 2m tile — pine bark: vertical plates, deep fissures (uv.y = up)
  bark: /* glsl */ `
  void surf(vec2 uv, out vec3 al, out float r, out float h, out float ao){
    vec2 p = vec2(uv.x * 6.0, uv.y * 3.0);
    vec3 v = tvoronoi(p, vec2(6.0, 3.0));
    float plate = smoothstep(0.0, 0.18, v.y - v.x);
    float fib = tnoise(vec2(uv.x*80.0, uv.y*8.0), vec2(80.0, 8.0));
    vec3 c = mix(hex(76.,52.,38.), hex(120.,84.,58.), v.z);
    c = mix(c, hex(150.,92.,58.), smoothstep(0.7,0.9,v.z)*0.6);
    al = c * (0.8 + fib*0.3) * mix(0.3, 1.0, plate);
    float lich = smoothstep(0.7, 0.8, tfbm(uv*vec2(4.0,8.0), 4.0, 4));
    al = mix(al, hex(120.,126.,96.), lich*0.5*plate);
    h = plate * 0.8 + fib * 0.2;
    r = 0.95;
    ao = mix(0.45, 1.0, plate);
  }`,
  // 2m tile — painted steel plate with rivets/wear (white base for tinting)
  paintedMetal: /* glsl */ `
  void surf(vec2 uv, out vec3 al, out float r, out float h, out float ao){
    float n = tfbm(uv*6.0, 6.0, 5);
    float wear = smoothstep(0.66, 0.74, tfbm(uv*12.0+7.0, 12.0, 5));
    float rust = smoothstep(0.7, 0.8, tfbm(uv*7.0+2.0, 7.0, 5));
    vec2 g = fract(uv * 2.0);
    float panel = smoothstep(0.0, 0.01, g.x) * smoothstep(1.0, 0.99, g.x) * smoothstep(0.0, 0.01, g.y) * smoothstep(1.0, 0.99, g.y);
    vec2 rv = fract(uv * 2.0 * vec2(10.0, 1.0));
    float rivet = (1.0 - smoothstep(0.08, 0.14, length(vec2((rv.x-0.5), (g.y < 0.5 ? g.y - 0.04 : g.y - 0.96)*10.0))));
    al = vec3(0.8) * (0.85 + n*0.25);
    al = mix(al, hex(70.,70.,72.), wear*0.8);
    al = mix(al, hex(120.,64.,34.), rust*0.7);
    al *= mix(0.5, 1.0, panel);
    h = n*0.2 + rivet*0.6 + panel*0.3 - wear*0.05;
    r = mix(0.6, 0.4, wear) + rust*0.3;
    ao = mix(0.6, 1.0, panel);
  }`,
  // 3m tile — stacked stone wall for foundations
  stoneWall: /* glsl */ `
  void surf(vec2 uv, out vec3 al, out float r, out float h, out float ao){
    vec3 v = tvoronoi(uv*vec2(5.0, 8.0), vec2(5.0, 8.0));
    float st = smoothstep(0.0, 0.12, v.y - v.x);
    float n = tfbm(uv*12.0, 12.0, 5);
    vec3 c = mix(hex(96.,94.,90.), hex(150.,146.,138.), v.z);
    al = mix(hex(60.,58.,54.), c * (0.8 + n*0.35), st);
    h = st * (0.7 + n*0.3);
    r = 0.9;
    ao = mix(0.35, 1.0, st);
  }`,
  // 0.5m tile — camo fabric (M98-inspired woodland), weave
  camoFabric: /* glsl */ `
  void surf(vec2 uv, out vec3 al, out float r, out float h, out float ao){
    float a = tfbm(uv*3.0, 3.0, 4), b = tfbm(uv*3.0+5.0, 3.0, 4), c = tfbm(uv*4.0+11.0, 4.0, 4);
    vec3 col = hex(92.,96.,74.);
    col = mix(col, hex(50.,60.,40.), smoothstep(0.48,0.52,a));
    col = mix(col, hex(78.,64.,48.), smoothstep(0.55,0.59,b));
    col = mix(col, hex(30.,32.,28.), smoothstep(0.6,0.64,c));
    float wx = sin(uv.x*6.2831*120.0)*0.5+0.5, wy = sin(uv.y*6.2831*120.0)*0.5+0.5;
    float weave = mix(wx, wy, step(0.5, fract(uv.x*60.0 + floor(uv.y*120.0)*0.5)));
    float wrinkle = tgfbm(uv*vec2(2.0, 6.0), 2.0, 4);
    al = col * (0.85 + weave*0.15);
    h = weave*0.25 + wrinkle*0.8;
    r = 0.95;
    ao = 0.9 + weave*0.1;
  }`,
  // 0.3m tile — synthetic glove: dark textured leather with stitch panels
  glove: /* glsl */ `
  void surf(vec2 uv, out vec3 al, out float r, out float h, out float ao){
    float n = tnoise(uv*120.0, vec2(120.0));
    float n2 = tfbm(uv*8.0, 8.0, 4);
    float panel = smoothstep(0.48, 0.5, abs(fract(uv.x*2.0)-0.5));
    al = mix(hex(34.,32.,30.), hex(58.,54.,48.), n2) * (0.85 + n*0.2);
    al = mix(al, hex(70.,66.,60.), panel*0.5);
    h = n*0.3 - panel*0.4 + n2*0.2;
    r = 0.7 - n*0.1;
    ao = 1.0 - panel*0.3;
  }`,
  // 0.25m tile — weapon polymer with stipple texture
  polymer: /* glsl */ `
  void surf(vec2 uv, out vec3 al, out float r, out float h, out float ao){
    float st = tnoise(uv*90.0, vec2(90.0));
    float st2 = tnoise(uv*30.0+3.0, vec2(30.0));
    float wear = smoothstep(0.7, 0.8, tfbm(uv*4.0, 4.0, 4));
    al = mix(vec3(0.026), vec3(0.04), st2) * (1.0 + wear*0.5);
    h = st*0.5 + st2*0.3;
    r = mix(0.72, 0.55, wear) - st*0.08;
    ao = 0.9 + st*0.1;
  }`,
  // 0.25m tile — anodized/cerakote metal micro detail with scratches
  gunMetal: /* glsl */ `
  void surf(vec2 uv, out vec3 al, out float r, out float h, out float ao){
    float n = tfbm(uv*20.0, 20.0, 5);
    float sc = 0.0;
    for(int i=0;i<4;i++){
      float a = float(i)*1.3+0.4;
      vec2 ruv = mat2(cos(a),-sin(a),sin(a),cos(a))*uv;
      sc = max(sc, smoothstep(0.985, 1.0, tnoise(vec2(ruv.x*900.0, ruv.y*10.0), vec2(900.0, 10.0))));
    }
    sc *= smoothstep(0.4, 0.7, tfbm(uv*3.0, 3.0, 3));
    al = mix(vec3(0.03), vec3(0.045), n);
    al = mix(al, vec3(0.25), sc*0.6);
    h = n*0.1 - sc*0.2;
    r = mix(0.5, 0.35, n) - sc*0.15;
    ao = 1.0;
  }`,
};
