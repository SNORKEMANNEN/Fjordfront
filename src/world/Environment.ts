import * as THREE from 'three';
import { Water } from 'three/examples/jsm/objects/Water.js';
import { Sky } from '../render/Sky';
import { HeightFog, installHeightFog } from '../render/HeightFog';
import { Settings } from '../game/Settings';
import { clamp, lerp, smoothstep } from '../core/math';

export type Weather = 'clear' | 'overcast' | 'rain' | 'snow';
export type TimePreset = 'dynamic' | 'dawn' | 'day' | 'golden' | 'blue' | 'night';

const PRESET_HOUR: Record<Exclude<TimePreset, 'dynamic'>, number> = { dawn: 9.0, day: 12.6, golden: 16.25, blue: 17.35, night: 23.2 };

const lerpC = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, clamp(t, 0, 1));
const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);

/**
 * Sun, moon, sky, image based lighting, fog and water with a real-time
 * time of day modelled on Lofoten in autumn (sunrise ≈ 08:40, noon sun ≈ 16°).
 */
export class Environment {
  sunDir = new THREE.Vector3(-0.55, 0.36, 0.62).normalize();
  /** direction of the active key light (sun by day, moon by night) */
  lightDir = new THREE.Vector3();
  sunColor = new THREE.Color(1.0, 0.86, 0.68);
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sky: Sky;
  water: Water;
  fog: HeightFog;
  weather: Weather = 'overcast';
  hour = 14;
  timeScale = 0; // game hours per real second
  elevation = 10; // sun elevation (deg)
  day = 1;
  golden = 0;
  night = 0;
  exposure = 1;
  rays = 0;
  cloudShadow = 0.5;
  /** winter map: colder light, darker water */
  winter = false;
  /** fog-bank multiplier on the fog density (1 = none) */
  fogBoost = 1;
  private baseFog = 0.002;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private shadowCenter = new THREE.Vector3();
  private lastEnvElev = 999;
  private envTimer = 0;
  private moonDir = new THREE.Vector3();
  onLighting: () => void = () => {};

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, waterNormals: THREE.Texture) {
    installHeightFog();
    this.sky = new Sky(this.sunDir, this.sunColor);
    scene.add(this.sky.mesh);

    this.sun = new THREE.DirectionalLight(this.sunColor, 3.2);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70;
    sc.near = 1; sc.far = 600;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = 2;
    this.applyShadowRes();
    this.sun.shadow.camera.layers.enable(1);
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xb8c6d4, 0x4a4a3c, 0.35);
    scene.add(this.hemi);

    this.fog = new HeightFog(new THREE.Color(0.56, 0.61, 0.65), 0.0028, 0.03);
    scene.fog = this.fog;

    waterNormals.wrapS = waterNormals.wrapT = THREE.RepeatWrapping;
    this.water = new Water(new THREE.PlaneGeometry(9000, 9000), {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals,
      sunDirection: this.sunDir.clone(),
      sunColor: this.sunColor.clone().multiplyScalar(0.9),
      waterColor: new THREE.Color(0x0b2a2c),
      distortionScale: 2.2,
      fog: true,
      alpha: 1,
    });
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = 0;
    // planar reflection re-renders the scene: refresh it every third frame
    {
      const reflect = this.water.onBeforeRender;
      let wf = 0;
      this.water.onBeforeRender = function (this: THREE.Object3D, ...args: Parameters<THREE.Object3D['onBeforeRender']>) {
        if (wf++ % 3 === 0) reflect.apply(this, args);
      };
    }
    this.water.name = 'water';
    (this.water.material as THREE.ShaderMaterial).uniforms.size.value = 3.5;
    scene.add(this.water);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.setTime(Settings.data.timeOfDay ?? 'dynamic');
    const w = Settings.data.weather;
    this.setWeather(w === 'auto' ? (Math.random() < 0.3 ? 'rain' : Math.random() < 0.5 ? 'overcast' : 'clear') : w);
  }

  applyShadowRes() {
    const r = Settings.data.shadowRes;
    this.sun.castShadow = Settings.data.shadows;
    if (this.sun.shadow.mapSize.x !== r) {
      this.sun.shadow.mapSize.set(r, r);
      this.sun.shadow.map?.dispose();
      (this.sun.shadow as any).map = null;
    }
  }

  setTime(p: TimePreset): void {
    this.blueHour = p === 'blue' ? 1 : 0;
    if (p === 'dynamic') {
      // mostly daylight; one match in five is a night op (goggles: N), one in seven the blue hour
      const r = Math.random();
      if (r < 0.14) {
        this.setTime('blue');
        return;
      }
      this.hour = r < 0.34 ? 22.8 : [10.5, 13.5, 14.8, 15.2][Math.floor(Math.random() * 4)];
      this.timeScale = 1 / 180; // one game hour every three minutes
    } else {
      this.hour = PRESET_HOUR[p] ?? 12.6; // unknown preset (e.g. a bad URL / stored value): daytime, never NaN
      this.timeScale = 0;
    }
    this.applyLighting(true);
  }

  setWeather(w: Weather) {
    this.weather = w;
    const u = this.sky.uniforms;
    u.uCover.value = w === 'clear' ? 0.4 : w === 'overcast' ? 0.62 : w === 'snow' ? 0.8 : 0.86;
    const wu = (this.water.material as THREE.ShaderMaterial).uniforms;
    wu.distortionScale.value = w === 'rain' ? 3.5 : w === 'snow' ? 2.8 : 2.2;
    this.applyLighting(true);
  }

  /** Sun position for the current hour: elevation peaks ~16° at 12:45, azimuth 180° (south) at noon. */
  private solar() {
    const h = this.hour;
    const el = 30.5 * Math.cos((2 * Math.PI * (h - 12.75)) / 24) - 14.5;
    const az = 180 + (h - 12.75) * 15;
    return { el, az };
  }

  private dirFrom(azDeg: number, elDeg: number, out: THREE.Vector3) {
    const a = THREE.MathUtils.degToRad(azDeg), e = THREE.MathUtils.degToRad(elDeg);
    return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
  }

  /** Recompute every light / colour from the hour and weather. */
  applyLighting(forceEnv = false) {
    const { el, az } = this.solar();
    this.elevation = el;
    this.dirFrom(az, Math.max(el, -6), this.sunDir);
    this.dirFrom(az + 160, 28, this.moonDir);
    const day = (this.day = smoothstep(-5, 7, el));
    const golden = (this.golden = smoothstep(13, 3, el) * smoothstep(-4, 1.5, el));
    const night = (this.night = 1 - smoothstep(-9, -2, el));
    // snow showers light like a bright overcast; the winter map is colder all round
    const w = this.weather === 'snow' ? 'overcast' : this.weather;
    const snowy = this.weather === 'snow';
    const wDim = w === 'clear' ? 1 : w === 'overcast' ? (snowy ? 0.55 : 0.62) : 0.32;
    const wGold = w === 'clear' ? 1 : w === 'overcast' ? 0.55 : 0.15;

    // ---- sky palette ----
    const dayZen = w === 'clear' ? C(0.14, 0.26, 0.46) : w === 'overcast' ? C(0.2, 0.27, 0.36) : C(0.22, 0.25, 0.29);
    const dayHor = w === 'clear' ? C(0.6, 0.68, 0.76) : w === 'overcast' ? C(0.6, 0.64, 0.67) : C(0.45, 0.48, 0.5);
    const goldZen = C(0.1, 0.16, 0.32), goldHor = C(0.9, 0.5, 0.28).lerp(dayHor, 1 - wGold);
    // pitch-dark nights: a barely-there sky, the land lit only by lamps and windows (goggles: N)
    const nightZen = C(0.0015, 0.0025, 0.007), nightHor = C(0.005, 0.007, 0.013);
    const u = this.sky.uniforms;
    let zen = lerpC(dayZen, goldZen, golden), hor = lerpC(dayHor, goldHor, golden);
    zen = lerpC(zen, nightZen, night);
    hor = lerpC(hor, nightHor, night);
    // twilight (sun just below the horizon): deep blue hour
    const blue = smoothstep(1, -3, el) * (1 - night);
    zen.lerp(C(0.05, 0.09, 0.2), blue * 0.7);
    hor.lerp(C(0.35, 0.3, 0.42), blue * 0.6);
    u.uZenith.value.copy(zen);
    u.uHorizon.value.copy(hor);
    u.uSunDir.value.copy(this.sunDir);
    u.uNight.value = night;
    u.uAurora.value = night * (w === 'rain' ? 0.0 : w === 'overcast' ? 0.12 : 0.35);
    u.uMoonDir.value.copy(this.moonDir);

    // ---- sun / moon key light ----
    const sunCol = lerpC(this.winter ? C(0.95, 0.95, 1.0) : C(1.0, 0.93, 0.82), C(1.0, 0.58, 0.3), golden * wGold);
    this.sunColor.copy(sunCol);
    u.uSunColor.value.copy(sunCol).multiplyScalar(day * (0.5 + 0.5 * wDim));
    const sunI = (0.6 + 3.0 * smoothstep(0, 14, el)) * day * wDim + golden * 0.6 * wGold;
    if (night > 0.5) {
      this.lightDir.copy(this.moonDir);
      this.sun.color.setRGB(0.55, 0.66, 0.95);
      this.sun.intensity = 0.045 * (w === 'clear' ? 1 : 0.4);
    } else {
      this.lightDir.copy(this.sunDir);
      if (el < 1.5) this.lightDir.y = Math.max(this.lightDir.y, 0.04);
      this.sun.color.copy(sunCol);
      this.sun.intensity = sunI;
    }
    // ---- ambient ----
    const skyAmb = lerpC(lerpC(C(0.72, 0.78, 0.86), C(0.6, 0.55, 0.62), golden), C(0.05, 0.065, 0.11), night);
    if (this.winter) skyAmb.lerp(C(0.72, 0.8, 0.95), 0.4 * (1 - night));
    this.hemi.color.copy(skyAmb);
    this.hemi.groundColor.copy(lerpC(this.winter ? C(0.62, 0.64, 0.68) : C(0.29, 0.29, 0.24), C(0.05, 0.05, 0.06), night));
    this.hemi.intensity = lerp(w === 'clear' ? 0.4 : w === 'overcast' ? 0.5 : 0.6, 0.06, night);

    // ---- fog ----
    const dayFog = w === 'clear' ? C(0.56, 0.63, 0.7) : w === 'overcast' ? C(0.52, 0.56, 0.59) : C(0.4, 0.43, 0.45);
    let fogCol = lerpC(dayFog, C(0.6, 0.43, 0.33).lerp(dayFog, 1 - wGold), golden);
    fogCol = lerpC(fogCol, C(0.004, 0.005, 0.008), night);
    fogCol.lerp(C(0.22, 0.22, 0.3), blue * 0.5);
    if (snowy || this.winter) fogCol.lerp(C(0.72, 0.76, 0.82).multiplyScalar(lerp(1, 0.06, night)), snowy ? 0.55 : 0.25);
    this.fog.color.copy(fogCol);
    u.uFogColor.value.copy(fogCol).multiplyScalar(1.05);
    this.baseFog = (w === 'clear' ? 0.0012 : w === 'overcast' ? (snowy ? 0.0038 : 0.0022) : 0.0042) * (1 - golden * 0.25 + night * 0.3);
    this.fog.density = Math.min(0.09, this.baseFog * this.fogBoost);
    this.fog.falloff = w === 'rain' ? 0.022 : 0.03;
    this.fog.sunAz = az;
    this.fog.sunEl = el;
    this.fog.scatter = day * (0.5 + 0.5 * wDim) * (1 + golden * 0.8);
    this.fog.sync();

    // ---- water ----
    const wu = (this.water.material as THREE.ShaderMaterial).uniforms;
    wu.sunDirection.value.copy(night > 0.5 ? this.moonDir : this.sunDir);
    wu.sunColor.value.copy(night > 0.5 ? C(0.5, 0.6, 0.85).multiplyScalar(0.4) : sunCol.clone().multiplyScalar((w === 'rain' ? 0.25 : w === 'overcast' ? 0.6 : 1) * day));
    wu.waterColor.value.copy(lerpC(this.winter ? C(0.02, 0.07, 0.09) : C(0.043, 0.165, 0.173), C(0.004, 0.012, 0.02), night));

    // ---- grading & effects ----
    this.exposure = lerp(1, 1.1, night) * lerp(1, 0.95, golden);
    this.rays = (w === 'clear' ? 1 : w === 'overcast' ? 0.45 : 0) * day * (0.35 + golden * 0.9);
    this.cloudShadow = (w === 'clear' ? 0.55 : w === 'overcast' ? 0.35 : 0) * day;

    this.gradeTint.setRGB(1, 1, 1);
    this.gradeSat = 1;
    if (this.blueHour > 0) this.applyBlueHour(az);
    // (re-baking the sky probe is a frame spike: only every 2.5° of sun travel, ~30 s in dynamic time)
    if (forceEnv || Math.abs(el - this.lastEnvElev) > 2.5) this.updateEnvMap();
    this.onLighting();
  }

  /** Blue hour preset (strength 0..1): the sun just gone, everything a deep saturated blue */
  blueHour = 0;
  /** colour grade for the current light (the blue hour pushes saturation and a cold tint) */
  gradeTint = new THREE.Color(1, 1, 1);
  gradeSat = 1;
  /**
   * The Nordic blue hour: sky and snow a deep, saturated blue, a soft cold light from the whole
   * sky, the lamps and windows already lit warm (night factor high enough for every fixture),
   * a few stars, no aurora, calm water.
   */
  private applyBlueHour(az: number) {
    const k = this.blueHour;
    const u = this.sky.uniforms;
    const w = this.weather;
    const veil = w === 'clear' ? 1 : w === 'overcast' ? 0.75 : 0.6;
    u.uZenith.value.lerp(C(0.006, 0.022, 0.13).multiplyScalar(veil), k);
    u.uHorizon.value.lerp(C(0.05, 0.12, 0.42).multiplyScalar(0.6 + 0.4 * veil), k);
    u.uNight.value = lerp(u.uNight.value, 0.45, k); // a few stars come out
    u.uAurora.value *= 1 - k;
    u.uSunColor.value.multiplyScalar(1 - k);
    // lamps, windows, street lights: on (they key off `night`)
    this.night = lerp(this.night, 0.86, k);
    this.day = lerp(this.day, 0.0, k);
    this.golden *= 1 - k;
    // key light: the bright western sky after sunset, cold and soft
    this.dirFrom(az + 10, 22, this.lightDir);
    this.sun.color.lerp(C(0.38, 0.52, 1.0), k);
    this.sun.intensity = lerp(this.sun.intensity, 0.32, k);
    // ambient: blue from above, blue snow light from below
    this.hemi.color.lerp(C(0.28, 0.45, 1.0), k);
    this.hemi.groundColor.lerp(this.winter ? C(0.2, 0.32, 0.7) : C(0.08, 0.12, 0.26), k);
    this.hemi.intensity = lerp(this.hemi.intensity, this.winter ? 0.5 : 0.48, k);
    // fog: a blue haze that swallows the far fjord walls
    const fog = C(0.035, 0.085, 0.27).multiplyScalar(0.7 + 0.3 * veil);
    this.fog.color.lerp(fog, k);
    u.uFogColor.value.lerp(fog.clone().multiplyScalar(1.05), k);
    this.baseFog = lerp(this.baseFog, w === 'clear' ? 0.0026 : 0.004, k);
    this.fog.density = Math.min(0.09, this.baseFog * this.fogBoost);
    this.fog.scatter *= 1 - k;
    this.fog.sync();
    const wu = (this.water.material as THREE.ShaderMaterial).uniforms;
    wu.sunColor.value.lerp(C(0.15, 0.25, 0.55), k);
    wu.waterColor.value.lerp(C(0.004, 0.02, 0.07), k);
    this.exposure = lerp(this.exposure, this.winter ? 1.18 : 1.32, k);
    // the tone curve washes deep blues toward grey: push them back (cold tint, more saturation)
    this.gradeTint.setRGB(1, 1, 1).lerp(C(0.78, 0.92, 1.22), k);
    this.gradeSat = lerp(1, 1.45, k);
    // a clearer sky: thin, dim cloud
    u.uCover.value = Math.min(u.uCover.value, w === 'clear' ? 0.2 : 0.5);
    this.rays *= 1 - k;
    this.cloudShadow *= 1 - k;
  }

  /** Bake the sky into a PMREM environment for image-based lighting. */
  updateEnvMap() {
    this.lastEnvElev = this.elevation;
    const envScene = new THREE.Scene();
    const skyClone = new THREE.Mesh(this.sky.mesh.geometry, this.sky.mesh.material);
    envScene.add(skyClone);
    const ground = new THREE.Mesh(
      new THREE.SphereGeometry(5000, 16, 8, 0, Math.PI * 2, Math.PI / 2 + 0.05, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.08, 0.09, 0.08).multiplyScalar(1 - this.night * 0.85), side: THREE.BackSide }),
    );
    envScene.add(ground);
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromScene(envScene, 0, 1, 20000);
    this.scene.environment = this.envRT.texture;
    (this.scene as any).environmentIntensity = (this.weather === 'rain' ? 0.6 : 0.85) * lerp(1, 0.08, this.night) * (this.blueHour > 0 ? 3.2 : 1);
    ground.geometry.dispose();
  }

  update(dt: number, cam: THREE.Camera) {
    this.sky.update(dt, cam.position);
    (this.water.material as THREE.ShaderMaterial).uniforms.time.value += dt * 0.55;
    if (this.timeScale > 0) {
      this.hour = (this.hour + dt * this.timeScale) % 24;
      this.envTimer -= dt;
      if (this.envTimer <= 0) {
        this.envTimer = 0.5;
        this.applyLighting();
      }
    }
    // shadow camera follows the player, snapped to texels to avoid shimmering
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    const texel = (sc.right - sc.left) / this.sun.shadow.mapSize.x;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).setY(0).normalize();
    this.shadowCenter.copy(cam.position).addScaledVector(fwd, 30);
    const lightRot = new THREE.Matrix4().lookAt(new THREE.Vector3(), this.lightDir.clone().negate(), new THREE.Vector3(0, 1, 0));
    const inv = lightRot.clone().invert();
    const ls = this.shadowCenter.clone().applyMatrix4(inv);
    ls.x = Math.round(ls.x / texel) * texel;
    ls.y = Math.round(ls.y / texel) * texel;
    ls.applyMatrix4(lightRot);
    this.sun.target.position.copy(ls);
    this.sun.position.copy(ls).addScaledVector(this.lightDir, 300);
    this.sun.target.updateMatrixWorld();
  }

  /** Fog banks thicken the fog without a full lighting pass. */
  setFogBoost(b: number) {
    if (Math.abs(b - this.fogBoost) < 0.01) return;
    this.fogBoost = b;
    this.fog.density = Math.min(0.09, this.baseFog * b);
    this.fog.sync();
  }

  /** "HH:MM" for the HUD. */
  clock() {
    const h = Math.floor(this.hour), m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
