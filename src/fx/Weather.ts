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
  rain: THREE.LineSegments;
  private rainMat: THREE.ShaderMaterial;
  private fogSheets: THREE.Mesh[] = [];
  private t = 0;
  private intensity = 0;

  constructor(scene: THREE.Scene, baker: TextureBaker, private heightAt: (x: number, z: number) => number = () => 0) {
    this.snow = new Snowfall(scene);
    const N = 9000;
    const pos = new Float32Array(N * 2 * 3);
    const seed = new Float32Array(N * 2);
    const end = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const x = Math.random() * 50 - 25, y = Math.random() * 30, z = Math.random() * 50 - 25;
      for (let k = 0; k < 2; k++) {
        pos.set([x, y, z], (i * 2 + k) * 3);
        seed[i * 2 + k] = Math.random();
        end[i * 2 + k] = k;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    g.setAttribute('endp', new THREE.BufferAttribute(end, 1));
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uAlpha: { value: 0 }, uWind: { value: new THREE.Vector2(0, 0) } },
      vertexShader: /* glsl */ `
        attribute float seed; attribute float endp;
        uniform float uTime; uniform vec3 uCam; uniform vec2 uWind;
        varying float vA;
        void main(){
          vec3 p = position;
          float speed = 11.0 + seed * 4.0;
          p.y = mod(p.y - uTime * speed, 30.0);
          p.xz += uWind;
          vec3 box = vec3(50.0, 30.0, 50.0);
          vec3 wp = uCam + mod(p - uCam + box * 0.5 + vec3(0.0, 8.0, 0.0), box) - box * 0.5 - vec3(0.0, 8.0, 0.0);
          wp.y = uCam.y - 10.0 + p.y;
          wp += vec3(0.05, 0.42, 0.0) * endp;
          vA = (1.0 - endp * 0.7) * (0.35 + seed * 0.4);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uAlpha; varying float vA;
        void main(){ gl_FragColor = vec4(vec3(0.75, 0.8, 0.85), vA * uAlpha); }`,
      transparent: true,
      depthWrite: false,
    });
    // (particle budgets scale with the quality preset: random seeds, so a shorter draw range
    // thins the rain evenly)
    const q = Settings.data.quality;
    const qk = q === 'low' ? 0.35 : q === 'medium' ? 0.6 : q === 'high' ? 0.8 : 1;
    g.setDrawRange(0, Math.round(N * qk) * 2);
    this.rain = new THREE.LineSegments(g, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 30;
    this.rain.visible = false;
    this.rain.layers.set(1);
    scene.add(this.rain);

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
    return [...this.fogSheets, ...this.bank.sprites, this.rain, this.snow.points];
  }

  update(dt: number, cam: THREE.Vector3, weather: string, heightPx = 1000) {
    this.t += dt;
    // ---- wind: wandering direction, weather-dependent strength, gusts
    this.windAng += (Math.sin(this.t * 0.013) * 0.02 + (Math.random() - 0.5) * 0.01) * dt * 3;
    const base = weather === 'clear' ? 1.2 : weather === 'fair' ? 2.5 : weather === 'overcast' ? 4.5 : weather === 'rain' ? 6.5 : 7;
    this.gust += ((Math.sin(this.t * 0.37) * 0.5 + Math.sin(this.t * 0.11 + 2) * 0.5) * 0.35 - this.gust) * Math.min(1, dt);
    this.windSpeed = Math.max(0.5, base * (1 + this.gust) * (1 + this.storm * 1.7 + this.gale * 2.2));
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
    void heightPx;
    this.intensity += (target - this.intensity) * (1 - Math.exp(-dt * 0.8));
    this.rain.visible = this.intensity > 0.02;
    this.rainMat.uniforms.uTime.value = this.t;
    this.rainMat.uniforms.uCam.value.copy(cam);
    this.rainMat.uniforms.uAlpha.value = this.intensity * 0.55;
    this.rainMat.uniforms.uWind.value.add(new THREE.Vector2(this.wind.x * 0.45 * dt, this.wind.z * 0.45 * dt));
    for (let i = 0; i < this.fogSheets.length; i++) {
      const f = this.fogSheets[i];
      f.position.x += Math.sin(this.t * 0.05 + i) * dt * 0.8;
      (f.material as THREE.MeshBasicMaterial).opacity = weather === 'clear' || weather === 'fair' ? 0.18 : 0.4;
      f.position.x += this.wind.x * dt * 0.05;
      f.position.z += this.wind.z * dt * 0.05;
    }
  }
}
