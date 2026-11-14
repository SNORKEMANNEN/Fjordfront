import { windAmpUniform } from '../world/Vegetation';
import * as THREE from 'three';
import { Settings } from '../game/Settings';
import { TextureBaker } from '../render/TextureBaker';
import { Snowfall, SNOW } from './Snow';
import { shoreDist } from '../world/MapLayout';

/**
 * Weather: rain streaks, snow showers (flakes + snow settling on surfaces), wind and fog banks.
 *
 *  wind      — direction wanders slowly, strength depends on the weather, with gusts. It drives the
 *              bullet drift (strongest on the sniper), snow/rain drift and the fog banks.
 *  snow      — showers come and go; while it snows the cover on roofs/ground builds up (patchy
 *              first) and melts slowly afterwards. The winter map starts fully covered.
 *  fog banks — every few minutes a wall of sea fog forms over the fjord (west) and rolls inland
 *              across the map with the wind, thickening the fog for whoever it engulfs.
 */
export class Weather {
  wind = new THREE.Vector3(3, 0, 1);
  windSpeed = 3;
  private windAng = Math.random() * Math.PI * 2;
  private gust = 0;
  snow: Snowfall;
  /** current snowfall 0..1 (showers) */
  snowRate = 0;
  /** settled snow 0..1 */
  snowCover = 0;
  /** base cover for the map variant (winter ≈ 0.95) */
  baseCover = 0;
  private bank: { sprites: THREE.Sprite[]; front: number; speed: number; life: number; active: boolean };
  private bankT = 60;
  /** 0..1 how deep the camera is inside a fog bank */
  inBank = 0;
  /** mid-match snowstorm intensity 0..1 (heavy snow, gale, whiteout) — driven by the game */
  storm = 0;
  /** Atlantic gale (Brosund's storm preset / event) 0..1: wind without the snow */
  gale = 0;
  rain: THREE.Mesh;
  private rainMat: THREE.ShaderMaterial;
  splash: THREE.Points;
  private splashMat: THREE.ShaderMaterial;
  /** rain colour follows the light (set by the game: dim at night, bright by day) */
  rainLight = 1;
  private fogSheets: THREE.Mesh[] = [];
  private t = 0;
  private intensity = 0;

  constructor(scene: THREE.Scene, baker: TextureBaker, private heightAt: (x: number, z: number) => number = () => 0) {
    this.snow = new Snowfall(scene);
    // ---- rain (Update 41): soft camera-facing streaks (a motion-blurred drop each), tilted and
    // carried by the wind, thinned into sweeping sheets by the gusts, and gone wherever something
    // solid is overhead (roofs, eaves, bridges, the tunnel) via the baked sky-occlusion height map
    const N = 7000;
    const pos = new Float32Array(N * 4 * 3);
    const seed = new Float32Array(N * 4);
    const corner = new Float32Array(N * 4 * 2);
    const idx = new Uint32Array(N * 6);
    for (let i = 0; i < N; i++) {
      const x = Math.random() * 36 - 18, y = Math.random() * 24, z = Math.random() * 36 - 18, sd = Math.random();
      const cs = [[-1, 0], [1, 0], [1, 1], [-1, 1]];
      for (let k = 0; k < 4; k++) {
        pos.set([x, y, z], (i * 4 + k) * 3);
        seed[i * 4 + k] = sd;
        corner.set(cs[k], (i * 4 + k) * 2);
      }
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    g.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uAlpha: { value: 0 }, uWind: { value: new THREE.Vector2(0, 0) },
        uWindV: { value: new THREE.Vector3() }, uGust: { value: 0 }, uPix: { value: 0.002 }, uCol: { value: new THREE.Color(0.8, 0.84, 0.88) },
        uSnowMap: SNOW.uSnowMap, uSnowBox: SNOW.uSnowBox,
      },
      vertexShader: /* glsl */ `
        attribute float seed; attribute vec2 corner;
        uniform float uTime; uniform vec3 uCam; uniform vec2 uWind; uniform vec3 uWindV; uniform float uGust; uniform float uAlpha; uniform float uPix;
        uniform sampler2D uSnowMap; uniform vec4 uSnowBox;
        varying float vA; varying vec2 vC;
        void main(){
          vec3 p = position;
          float speed = 8.5 + seed * 4.0;
          p.y = mod(p.y - uTime * speed, 24.0);
          p.xz += uWind * (0.85 + seed * 0.3);
          vec3 box = vec3(36.0, 24.0, 36.0);
          vec3 wp = uCam + mod(p - uCam + box * 0.5 + vec3(0.0, 8.0, 0.0), box) - box * 0.5 - vec3(0.0, 8.0, 0.0);
          wp.y = uCam.y - 8.0 + p.y;
          // falling along its velocity: straight down plus the wind
          vec3 dir = normalize(vec3(uWindV.x * 0.9, -speed, uWindV.z * 0.9));
          float len = 0.22 + seed * 0.32;
          float dist = length(uCam - wp);
          // (toCam × dir keeps the quad's winding facing the camera — the other order gets back-face culled)
          vec3 sx = cross(uCam - wp, dir); vec3 side = sx / max(length(sx), 1e-4);
          // physical width ~4–8 mm, but never thinner than ~1.1 px (thin far drops fade instead,
          // so they read as a light haze of streaks rather than vanishing between pixel centres)
          float wPhys = 0.004 + seed * 0.004, wMin = dist * uPix * 0.55;
          float w = max(wPhys, wMin);
          float thin = clamp(wPhys / wMin, 0.25, 1.0);
          vec3 pos = wp - dir * len * corner.y + side * w * corner.x;
          // nothing falls under a roof, a bridge or in the tunnel
          float occ = 1.0;
          if (uSnowBox.w > 0.5) {
            vec2 suv = vec2((wp.x - uSnowBox.x) / uSnowBox.z, 1.0 - (wp.z - uSnowBox.y) / uSnowBox.z);
            if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
              float top = texture2D(uSnowMap, suv).r;
              occ = smoothstep(top - 0.5, top + 0.15, wp.y);
            }
          }
          // gusts drive denser sheets of rain across in the wind direction
          vec2 wd = normalize(uWindV.xz + vec2(1e-3, 0.0));
          float sheet = 0.5 + 0.5 * sin(dot(wp.xz, wd) * 0.32 - uTime * (1.4 + length(uWindV.xz) * 0.25) + seed * 1.3);
          float keep = step(seed, uAlpha);
          vec4 mv = viewMatrix * vec4(pos, 1.0);
          float d = -mv.z;
          float fade = smoothstep(0.35, 1.6, d) * (1.0 - smoothstep(11.0, 17.0, d));
          vA = keep * occ * fade * thin * mix(1.0, 0.25 + 0.75 * sheet, uGust) * (0.55 + seed * 0.45);
          vC = corner;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uCol; varying float vA; varying vec2 vC;
        void main(){
          float across = 1.0 - abs(vC.x); across *= across;
          float along = smoothstep(0.0, 0.2, vC.y) * (1.0 - smoothstep(0.45, 1.0, vC.y));
          float a = vA * across * along * 0.6;
          if (a < 0.003) discard;
          gl_FragColor = vec4(uCol, a);
        }`,
      transparent: true,
      depthWrite: false,
    });
    // (particle budgets scale with the quality preset: random seeds, so a shorter draw range
    // thins the rain evenly)
    const q = Settings.data.quality;
    const qk = q === 'low' ? 0.5 : q === 'medium' ? 0.7 : q === 'high' ? 0.85 : 1;
    g.setDrawRange(0, Math.round(N * qk) * 6);
    this.rain = new THREE.Mesh(g, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 30;
    this.rain.visible = false;
    this.rain.layers.set(1);
    scene.add(this.rain);
    // ---- splashes: tiny rings blooming on whatever the rain hits (ground, roofs, car tops,
    // water), placed on the sky-occlusion map's top surface around you
    const M = 1600;
    const sp = new Float32Array(M * 3), ss = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 13;
      sp.set([Math.cos(a) * r, 0, Math.sin(a) * r], i * 3);
      ss[i] = Math.random();
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    sg.setAttribute('seed', new THREE.BufferAttribute(ss, 1));
    this.splashMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uAlpha: { value: 0 }, uScale: { value: 600 }, uCol: this.rainMat.uniforms.uCol, uSnowMap: SNOW.uSnowMap, uSnowBox: SNOW.uSnowBox },
      vertexShader: /* glsl */ `
        attribute float seed; uniform float uTime; uniform vec3 uCam; uniform float uAlpha; uniform float uScale;
        uniform sampler2D uSnowMap; uniform vec4 uSnowBox;
        varying float vA; varying float vPh;
        void main(){
          // each splash re-rolls its spot every cycle (a hash of the cycle number)
          float rate = 1.6 + seed * 1.4;
          float cyc = floor(uTime * rate + seed * 7.0);
          float ph = fract(uTime * rate + seed * 7.0);
          vec2 jit = vec2(fract(sin(cyc * 12.9898 + seed * 78.233) * 43758.5), fract(sin(cyc * 39.346 + seed * 11.135) * 24634.6)) - 0.5;
          vec2 xz = uCam.xz + position.xz + jit * 3.0;
          float y = -1000.0;
          if (uSnowBox.w > 0.5) {
            vec2 suv = vec2((xz.x - uSnowBox.x) / uSnowBox.z, 1.0 - (xz.y - uSnowBox.y) / uSnowBox.z);
            if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) y = texture2D(uSnowMap, suv).r;
          }
          vec3 wp = vec3(xz.x, max(y, 0.0) + 0.03, xz.y);
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          float d = -mv.z;
          // only the ones you could see land: near enough, above the eye line drop-off, not far below
          float ok = step(seed, uAlpha) * step(-40.0, y) * step(ph, 0.22) * (1.0 - smoothstep(9.0, 14.0, d)) * step(abs(wp.y - uCam.y), 6.0);
          vA = ok;
          vPh = ph / 0.22;
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (0.05 + vPh * 0.11) * uScale / max(d, 0.5);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uCol; varying float vA; varying float vPh;
        void main(){
          vec2 c = gl_PointCoord - 0.5; c.y *= 2.2; // flattened: lying on the surface
          float r = length(c);
          float ring = smoothstep(0.5, 0.36, r) * smoothstep(0.18, 0.34, r);
          float a = vA * ring * (1.0 - vPh) * 0.55;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uCol * 1.1, a);
        }`,
      transparent: true,
      depthWrite: false,
    });
    sg.setDrawRange(0, Math.round(M * qk));
    this.splash = new THREE.Points(sg, this.splashMat);
    this.splash.frustumCulled = false;
    this.splash.renderOrder = 29;
    this.splash.visible = false;
    this.splash.layers.set(1);
    scene.add(this.splash);

    // low fog sheets over forests & the inlet
    const tex = baker.raw('fx.fogsheet', `void main(){ vec2 p = vUv; float n = tfbm(p * 3.0, 3.0, 5);
      float edge = smoothstep(0.0, 0.3, p.x) * smoothstep(1.0, 0.7, p.x) * smoothstep(0.0, 0.3, p.y) * smoothstep(1.0, 0.7, p.y);
      gl_FragColor = vec4(vec3(1.0), smoothstep(0.35, 0.75, n) * edge); }`, 256, false);
    const fm = new THREE.MeshBasicMaterial({ map: tex, color: 0xc9d0d4, transparent: true, opacity: 0.35, depthWrite: false, fog: true });
    for (const [x, y, z, s] of [[140, 20, -60, 140], [0, 7, -80, 120], [60, 34, 82, 160], [-60, 3, 60, 120], [120, 28, 40, 110]] as const) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s * 0.6), fm);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, y, z);
      m.renderOrder = 25;
      scene.add(m);
      this.fogSheets.push(m);
    }
    // fog bank billboards (reused)
    const bankTex = baker.raw('fx.fogbank', `void main(){ vec2 p = vUv*2.0-1.0; float r = length(p);
      float n = tfbm(vUv * 3.0, 3.0, 5);
      float a = smoothstep(1.0, 0.25, r) * (0.45 + 0.75 * n);
      gl_FragColor = vec4(vec3(1.0), clamp(a * a, 0.0, 1.0)); }`, 256, false);
    const sprites: THREE.Sprite[] = [];
    for (let i = 0; i < 90; i++) {
      const sm = new THREE.SpriteMaterial({ map: bankTex, color: 0xd6dde2, transparent: true, opacity: 0, depthWrite: false, fog: true });
      const sp = new THREE.Sprite(sm);
      sp.userData = { dx: (Math.random() - 0.5) * 110, z: -320 + (i / 90) * 640 + (Math.random() - 0.5) * 10, y: 4 + Math.random() * 14, s: 38 + Math.random() * 40, o: 0.25 + Math.random() * 0.2, ph: Math.random() * 6 };
      sp.scale.setScalar(sp.userData.s);
      sp.visible = false;
      sp.renderOrder = 26;
      scene.add(sp);
      sprites.push(sp);
    }
    // fog banks are big transparent layers (overdraw): fewer, slightly denser ones on the lower presets
    const keep = q === 'low' ? 3 : q === 'medium' ? 2 : 1;
    const used = sprites.filter((_, i) => i % keep === 0);
    for (const sp of sprites) if (!used.includes(sp)) scene.remove(sp);
    for (const sp of used) sp.userData.o = Math.min(0.6, sp.userData.o * (1 + (keep - 1) * 0.35));
    this.snow.setBudget(qk);
    this.bank = { sprites: used, front: -400, speed: 3, life: 0, active: false };
  }

  /** Map variant / match start. */
  reset(winter: boolean, weather: string) {
    this.baseCover = winter ? 0.95 : 0;
    this.snowCover = winter ? 0.95 : weather === 'snow' ? 0.2 : 0;
    this.snowRate = weather === 'snow' ? 0.6 : 0;
    this.bankT = 25 + Math.random() * 90;
    this.bank.active = false;
    this.bank.sprites.forEach((s) => (s.visible = false));
    this.windAng = Math.random() * Math.PI * 2;
  }

  /** Start a fog bank now (also used by tests). */
  rollFog() {
    const b = this.bank;
    b.active = true;
    b.front = -330;
    b.life = 0;
    b.speed = 2.6 + this.windSpeed * 0.35;
  }

  /** Fog bank geometry: a band about 120 m deep centred on `front` (world x), drifting east. */
  objects() {
    return [...this.fogSheets, ...this.bank.sprites, this.rain, this.splash, this.snow.points];
  }

  update(dt: number, cam: THREE.Vector3, weather: string, heightPx = 1000) {
    this.t += dt;
    // ---- wind: wandering direction, weather-dependent strength, gusts
    this.windAng += (Math.sin(this.t * 0.013) * 0.02 + (Math.random() - 0.5) * 0.01) * dt * 3;
    const base = weather === 'clear' ? 1.2 : weather === 'fair' ? 2.5 : weather === 'overcast' ? 4.5 : weather === 'rain' ? 6.5 : 7;
    this.gust += ((Math.sin(this.t * 0.37) * 0.5 + Math.sin(this.t * 0.11 + 2) * 0.5) * 0.35 - this.gust) * Math.min(1, dt);
    this.windSpeed = Math.max(0.5, base * (1 + this.gust) * (1 + this.storm * 1.7 + this.gale * 2.2));
    windAmpUniform.value += (Math.min(2.2, 0.75 + this.windSpeed * 0.09) - windAmpUniform.value) * (1 - Math.exp(-dt * 1.5));
    this.wind.set(Math.cos(this.windAng) * this.windSpeed, 0, Math.sin(this.windAng) * this.windSpeed);
    // ---- snow showers & settling
    const want = Math.max(this.storm, weather === 'snow' ? 0.35 + 0.65 * Math.max(0, Math.sin(this.t * 0.021) * 0.6 + Math.sin(this.t * 0.0071 + 1) * 0.6) : 0);
    this.snowRate += (Math.min(1, want) - this.snowRate) * (1 - Math.exp(-dt * 0.3));
    if (this.snowRate > 0.05) this.snowCover = Math.min(Math.max(this.baseCover, 0.8), this.snowCover + dt * 0.0045 * this.snowRate);
    else this.snowCover = Math.max(this.baseCover, this.snowCover - dt * 0.0008);
    SNOW.uSnow.value = this.snowCover;
    this.snow.intensity = this.snowRate * (1 + this.storm * 0.8);
    this.snow.update(dt, this.t, cam, this.wind, heightPx);
    // ---- fog banks off the fjord
    const bk = this.bank;
    this.bankT -= dt;
    if (!bk.active && this.bankT <= 0) {
      this.bankT = 180 + Math.random() * 200;
      if (weather !== 'clear' && Math.random() < (weather === 'fair' ? 0.35 : 0.75)) this.rollFog();
    }
    this.inBank = 0;
    if (bk.active) {
      bk.life += dt;
      bk.front += bk.speed * dt;
      const fadeIn = Math.min(1, bk.life / 20), fadeOut = 1 - Math.max(0, (bk.front - 150) / 120);
      const k = Math.max(0, Math.min(fadeIn, fadeOut));
      for (const sp of bk.sprites) {
        const u = sp.userData;
        const x = bk.front + u.dx + Math.sin(this.t * 0.05 + u.ph) * 6;
        const z = u.z + Math.cos(this.t * 0.04 + u.ph) * 5;
        // hugs the water over the fjord, sits a little above the ground inland
        const ground = shoreDist(x, z) < 0 ? 0 : Math.max(0, this.heightAt(x, z));
        sp.position.set(x, ground + u.y, z);
        (sp.material as THREE.SpriteMaterial).opacity = u.o * k;
        sp.visible = k > 0.01;
      }
      const d = Math.abs(cam.x - bk.front);
      this.inBank = k * Math.max(0, 1 - Math.max(0, d - 35) / 45) * Math.max(0, 1 - Math.max(0, cam.y - 30) / 30);
      if (k <= 0 && bk.life > 25) {
        bk.active = false;
        bk.sprites.forEach((s) => (s.visible = false));
      }
    }
    const target = weather === 'rain' ? 1 : 0;
    // a match that starts in the rain is already raining; a change mid-match eases in
    this.intensity = this.t < 0.5 ? target : this.intensity + (target - this.intensity) * (1 - Math.exp(-dt * 0.8));
    this.rain.visible = this.intensity > 0.02;
    this.splash.visible = this.rain.visible;
    const ru = this.rainMat.uniforms;
    ru.uTime.value = this.t;
    ru.uCam.value.copy(cam);
    ru.uAlpha.value = Math.min(1, this.intensity * (0.75 + this.gale * 0.25));
    ru.uWind.value.add(new THREE.Vector2(this.wind.x * 0.75 * dt, this.wind.z * 0.75 * dt));
    ru.uWindV.value.copy(this.wind);
    ru.uPix.value = 1.55 / Math.max(240, heightPx);
    ru.uGust.value = Math.min(1, 0.35 + this.gust * 0.8 + this.gale * 0.5);
    const lc = 0.25 + 0.75 * Math.min(1, this.rainLight);
    ru.uCol.value.setRGB(0.8 * lc, 0.84 * lc, 0.88 * lc);
    const su = this.splashMat.uniforms;
    su.uTime.value = this.t;
    su.uCam.value.copy(cam);
    su.uAlpha.value = this.intensity;
    su.uScale.value = heightPx * 0.9;
    for (let i = 0; i < this.fogSheets.length; i++) {
      const f = this.fogSheets[i];
      f.position.x += Math.sin(this.t * 0.05 + i) * dt * 0.8;
      (f.material as THREE.MeshBasicMaterial).opacity = weather === 'clear' || weather === 'fair' ? 0.18 : 0.4;
      f.position.x += this.wind.x * dt * 0.05;
      f.position.z += this.wind.z * dt * 0.05;
    }
  }
}
