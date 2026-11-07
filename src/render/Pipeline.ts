import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
// @ts-ignore - n8ao ships without types
import { N8AOPass } from 'n8ao';
import { Settings } from '../game/Settings';

/** Renders the first-person viewmodel on top of the world after clearing depth. */
class ViewmodelPass extends Pass {
  constructor(public scene: THREE.Scene, public camera: THREE.Camera) {
    super();
    this.needsSwap = false;
  }
  render(renderer: THREE.WebGLRenderer, _w: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(readBuffer);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = ac;
  }
}

/** Camera motion blur + ADS depth of field, using the AO pass' scene depth. */
class WorldPostPass extends Pass {
  quad: FullScreenQuad;
  mat: THREE.ShaderMaterial;
  constructor() {
    super();
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uBlur: { value: 0 },
        uDof: { value: 0 },
        uFocus: { value: 30 },
        uNear: { value: 0.05 },
        uFar: { value: 12000 },
        uRes: { value: new THREE.Vector2(1, 1) },
        uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
        uRays: { value: 0 },
        uSunCol: { value: new THREE.Color(1, 0.8, 0.6) },
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform sampler2D tDepth;
        uniform mat4 uInvViewProj; uniform mat4 uPrevViewProj;
        uniform float uBlur; uniform float uDof; uniform float uFocus; uniform float uNear; uniform float uFar; uniform vec2 uRes;
        uniform vec2 uSunScreen; uniform float uRays; uniform vec3 uSunCol;
        varying vec2 vUv;
        float linDepth(float d){ float z = d * 2.0 - 1.0; return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear)); }
        void main(){
          vec4 base = texture2D(tDiffuse, vUv);
          float d = texture2D(tDepth, vUv).x;
          vec3 col = base.rgb;
          if (uBlur > 0.0) {
            vec4 ndc = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
            vec4 wp = uInvViewProj * ndc; wp /= wp.w;
            vec4 pp = uPrevViewProj * wp; pp /= pp.w;
            vec2 prevUv = pp.xy * 0.5 + 0.5;
            vec2 vel = (vUv - prevUv) * uBlur;
            float l = length(vel);
            vel = l > 0.04 ? vel / l * 0.04 : vel;
            vec3 acc = col; float n = 1.0;
            for (int i = 1; i < 10; i++) {
              vec2 o = vel * (float(i) / 9.0 - 0.5);
              acc += texture2D(tDiffuse, vUv + o).rgb; n += 1.0;
            }
            col = acc / n;
          }
          if (uDof > 0.0) {
            float ld = linDepth(d);
            float coc = clamp((ld - uFocus) / (uFocus * 2.0), 0.0, 1.0) * uDof;
            if (coc > 0.01) {
              vec3 acc = col; float n = 1.0;
              for (int i = 0; i < 12; i++) {
                float a = float(i) * 2.39996;
                float r = sqrt(float(i) + 0.5) / 3.5;
                vec2 o = vec2(cos(a), sin(a)) * r * coc * 7.0 / uRes;
                acc += texture2D(tDiffuse, vUv + o).rgb; n += 1.0;
              }
              col = mix(col, acc / n, clamp(coc * 2.0, 0.0, 1.0));
            }
          }
          // crepuscular rays: march toward the sun, accumulating unoccluded sky
          if (uRays > 0.0) {
            vec2 delta = (uSunScreen - vUv) / 32.0;
            vec2 p = vUv;
            float illum = 0.0, decay = 1.0;
            float jit = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
            p += delta * jit;
            for (int i = 0; i < 32; i++) {
              p += delta;
              if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) break;
              float sky = step(0.99999, texture2D(tDepth, p).x);
              illum += sky * decay;
              decay *= 0.955;
            }
            float falloff = 1.0 - smoothstep(0.0, 0.85, length((vUv - uSunScreen) * vec2(uRes.x / uRes.y, 1.0)));
            col += uSunCol * illum / 32.0 * uRays * falloff * 0.9;
          }
          gl_FragColor = vec4(col, base.a);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
  }
  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    this.mat.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
}

/** Filmic tonemapping + colour grade + lens effects. Outputs display-referred linear. */
class GradePass extends Pass {
  quad: FullScreenQuad;
  mat: THREE.ShaderMaterial;
  constructor() {
    super();
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uExposure: { value: 1.0 },
        uTime: { value: 0 },
        uVignette: { value: 0.32 },
        uDamage: { value: 0 },
        uFlash: { value: 0 },
        uCA: { value: 0.0015 },
        uGrain: { value: 0.035 },
        uSat: { value: 0.92 },
        uSuppression: { value: 0 },
        uRes: { value: new THREE.Vector2(1, 1) },
        uUnderwater: { value: 0 },
        uNVG: { value: 0 },
        uNVGPower: { value: 0 },
        uNVGGain: { value: 10 },
        uNVGFlash: { value: 0 },
        uNVGIllum: { value: 0 },
        tDepth: { value: null },
        uNear: { value: 0.05 },
        uFar: { value: 3000 },
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform float uExposure; uniform float uTime; uniform float uVignette;
        uniform float uDamage; uniform float uFlash; uniform float uCA; uniform float uGrain; uniform float uSat;
        uniform float uSuppression; uniform vec2 uRes; uniform float uUnderwater;
        uniform float uNVG; uniform float uNVGPower; uniform float uNVGGain; uniform float uNVGFlash;
        uniform float uNVGIllum; uniform sampler2D tDepth; uniform float uNear; uniform float uFar;
        varying vec2 vUv;
        // AgX-like filmic curve (Troy Sobotka's AgX, approximated - Benjamin Wrensch fit)
        vec3 agxContrast(vec3 x){ vec3 x2 = x*x; vec3 x4 = x2*x2;
          return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x + 0.4298*x2 + 0.1191*x - 0.00232; }
        vec3 agx(vec3 v){
          const mat3 m = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                              0.0784335999999992, 0.878468636469772, 0.0784336,
                              0.0792237451477643, 0.0791661274605434, 0.879142973793104);
          const mat3 mi = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                               -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                               -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
          v = m * v;
          v = clamp(log2(max(v, 1e-10)), -12.47393, 4.026069);
          v = (v + 12.47393) / 16.49999;
          v = agxContrast(v);
          // punchy-ish look
          v = pow(v, vec3(1.08));
          v = mi * v;
          return pow(max(v, 0.0), vec3(2.2));
        }
        float rand(vec2 c){ return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }
        void main(){
          vec2 uv = vUv;
          vec2 dc = uv - 0.5;
          float r2 = dot(dc, dc);
          float ca = uCA * (1.0 + uSuppression * 3.0 + uDamage * 2.0);
          vec3 c;
          c.r = texture2D(tDiffuse, uv - dc * ca * 4.0 * r2 * 4.0).r;
          c.g = texture2D(tDiffuse, uv).g;
          c.b = texture2D(tDiffuse, uv + dc * ca * 4.0 * r2 * 4.0).b;
          c *= uExposure;
          c = agx(c);
          // grade: cool shadows, neutral-warm highlights, slight desaturation
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c = mix(vec3(l), c, uSat * (1.0 - uSuppression * 0.4) * (1.0 - uDamage * 0.5));
          vec3 shadowTint = vec3(0.95, 1.0, 1.06);
          vec3 highTint = vec3(1.03, 1.0, 0.96);
          c *= mix(shadowTint, highTint, smoothstep(0.0, 0.7, l));
          c = pow(c, vec3(1.04));
          // underwater
          c = mix(c, vec3(0.03, 0.12, 0.14) + c * vec3(0.2, 0.5, 0.55), uUnderwater);
          // ---- night vision (image intensifier) ----
          if (uNVG > 0.001) {
            vec3 raw = texture2D(tDiffuse, uv).rgb * uExposure;
            // photocathode response leans red / near-IR
            float L = dot(raw, vec3(0.5, 0.4, 0.1));
            // halo: a little of the surrounding light blooms around bright points
            vec2 px = 2.5 / uRes;
            float h = dot(texture2D(tDiffuse, uv + vec2(px.x, 0.0)).rgb + texture2D(tDiffuse, uv - vec2(px.x, 0.0)).rgb
                        + texture2D(tDiffuse, uv + vec2(0.0, px.y)).rgb + texture2D(tDiffuse, uv - vec2(0.0, px.y)).rgb, vec3(0.125, 0.1, 0.025)) * uExposure;
            L = L * 0.8 + h * 0.2 + max(h - L, 0.0) * 0.35;
            // IR illuminator on the goggles: a soft cone around the view centre lighting near surfaces
            if (uNVGIllum > 0.0) {
              float zd = texture2D(tDepth, uv).x;
              if (zd < 0.99999) {
                float zn = zd * 2.0 - 1.0;
                float dist = 2.0 * uNear * uFar / (uFar + uNear - zn * (uFar - uNear));
                vec2 cq = dc * vec2(uRes.x / uRes.y, 1.0);
                float cone = 1.0 - smoothstep(0.12, 0.62, length(cq));
                float fall = 1.0 / (1.0 + dist * dist * 0.006);
                L += uNVGIllum * cone * fall * (0.012 + L * 1.5);
              }
            }
            // intensifier with automatic brightness control (soft saturation)
            float I = 1.0 - exp(-L * uNVGGain);
            I = I / (1.0 + I * 0.15) * 1.15;
            // tube contrast: deep shadows stay dark, lit surfaces and lights pop
            I = pow(I, 1.45) * 1.08;
            // scintillation: sparkling noise, strongest in the dark parts of the image
            float n1 = rand(floor(uv * uRes * 0.7) + fract(uTime * 37.0) * 91.0) - 0.5;
            float n2 = rand(uv * uRes + fract(uTime * 53.0) * 17.0) - 0.5;
            float spark = step(0.996, rand(floor(uv * uRes * 0.5) + floor(uTime * 30.0)));
            I += (n1 * 0.13 + n2 * 0.07) * (1.0 - I * 0.75) + spark * 0.35 * (1.0 - I);
            I *= (0.97 + 0.03 * sin(uTime * 73.0)) * uNVGPower;
            vec3 phos = vec3(0.24, 1.0, 0.38) * max(I, 0.0) + vec3(0.004, 0.018, 0.008) * uNVGPower;
            // binocular eyepiece mask: two overlapping circles, dark rim falloff inside each tube
            vec2 q = dc * vec2(uRes.x / uRes.y, 1.0);
            float dl = length(q - vec2(-0.17, 0.0)), dr = length(q - vec2(0.17, 0.0));
            float d = min(dl, dr);
            float tube = smoothstep(0.53, 0.47, d);
            phos *= tube * (0.72 + 0.28 * smoothstep(0.5, 0.18, d));
            phos += vec3(0.45, 1.0, 0.55) * uNVGFlash * tube;
            c = mix(c, phos, uNVG);
          }
          // vignette
          float vig = smoothstep(0.85, 0.2, length(dc * vec2(1.0, 0.85)) * (1.0 + uVignette));
          c *= mix(1.0, vig, 0.6 + uSuppression * 0.3);
          // damage: red edges + desat
          float edge = smoothstep(0.25, 0.75, length(dc));
          c = mix(c, vec3(0.35, 0.02, 0.02), uDamage * edge * 0.8);
          c += uFlash;
          // film grain
          float g = rand(uv * uRes + fract(uTime) * 100.0) - 0.5;
          c += g * uGrain * (1.0 - l * 0.6);
          gl_FragColor = vec4(max(c, 0.0), 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
  }
  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    this.mat.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
}

export class Pipeline {
  composer: EffectComposer;
  ao: any;
  plainRender: RenderPass;
  world: WorldPostPass;
  vm: ViewmodelPass;
  bloom: UnrealBloomPass;
  grade: GradePass;
  smaa: SMAAPass;
  output: OutputPass;
  private prevViewProj = new THREE.Matrix4();
  private tmpM = new THREE.Matrix4();
  renderScale = 1;
  /** dynamic-resolution multiplier on top of the user's render scale (0.6..1) */
  dynScale = 1;
  w = 1;
  h = 1;

  constructor(
    public renderer: THREE.WebGLRenderer,
    public scene: THREE.Scene,
    public camera: THREE.PerspectiveCamera,
    vmScene: THREE.Scene,
    vmCamera: THREE.PerspectiveCamera,
  ) {
    const size = renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(renderer);
    this.ao = new N8AOPass(scene, camera, size.x, size.y);
    this.ao.configuration.aoRadius = 2.2;
    this.ao.configuration.distanceFalloff = 0.6;
    this.ao.configuration.intensity = 2.6;
    this.ao.configuration.halfRes = true;
    this.ao.configuration.gammaCorrection = false;
    this.ao.configuration.color = new THREE.Color(0.02, 0.025, 0.03);
    this.ao.setQualityMode('Low');
    // (transparency-aware AO stays on: the sky dome writes no depth and the compositor needs it.
    // Its two extra transparent-only renders no longer re-render the shadow maps — see Game.)
    this.plainRender = new RenderPass(scene, camera);
    this.world = new WorldPostPass();
    this.vm = new ViewmodelPass(vmScene, vmCamera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.35, 0.55, 2.2);
    this.grade = new GradePass();
    this.smaa = new SMAAPass(size.x, size.y);
    this.output = new OutputPass();
    this.rebuild();
  }

  rebuild() {
    const c = this.composer;
    while (c.passes.length) c.removePass(c.passes[0]);
    const q = Settings.data;
    const useAO = q.ao;
    c.addPass(useAO ? this.ao : this.plainRender);
    if (useAO) c.addPass(this.world);
    c.addPass(this.vm);
    if (q.bloom) c.addPass(this.bloom);
    c.addPass(this.grade);
    if (q.antialias) c.addPass(this.smaa);
    c.addPass(this.output);
  }

  setSize(w: number, h: number) {
    this.w = w;
    this.h = h;
    const s = Settings.data.renderScale * this.dynScale;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, Settings.data.hiDpi ? 2 : 1) * s);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio, Settings.data.hiDpi ? 2 : 1) * s);
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.grade.mat.uniforms.uRes.value.set(w * pr, h * pr);
    this.world.mat.uniforms.uRes.value.set(w * pr, h * pr);
  }

  render(dt: number, fx: { dofFocus: number; dof: number; damage: number; flash: number; suppression: number; underwater: number; exposure?: number; rays?: number; sunDir?: THREE.Vector3; sunColor?: THREE.Color }) {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const g = this.grade.mat.uniforms;
    g.uTime.value += dt;
    g.uDamage.value = fx.damage;
    g.uFlash.value = fx.flash;
    g.uSuppression.value = fx.suppression;
    g.uUnderwater.value = fx.underwater;
    g.uExposure.value = fx.exposure ?? 1;
    const wu = this.world.mat.uniforms;
    if (Settings.data.ao) {
      wu.tDepth.value = this.ao.beautyRenderTarget.depthTexture;
      this.tmpM.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      wu.uInvViewProj.value.copy(this.tmpM).invert();
      wu.uPrevViewProj.value.copy(this.prevViewProj);
      this.prevViewProj.copy(this.tmpM);
      const mb = Settings.data.motionBlur ? Math.min(1, (1 / 60) / Math.max(dt, 1e-3)) * 0.6 : 0;
      wu.uBlur.value = mb;
      wu.uDof.value = fx.dof * (Settings.data.dof ? 1 : 0);
      wu.uFocus.value = fx.dofFocus;
      wu.uNear.value = cam.near;
      wu.uFar.value = cam.far;
      // god rays: project the sun to the screen and fade when it's behind the camera
      let rays = 0;
      if (fx.rays && fx.sunDir && Settings.data.godRays) {
        const sp = cam.position.clone().addScaledVector(fx.sunDir, 5000).project(cam);
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        const facing = fwd.dot(fx.sunDir);
        rays = fx.rays * THREE.MathUtils.smoothstep(facing, 0.1, 0.6);
        wu.uSunScreen.value.set(sp.x * 0.5 + 0.5, sp.y * 0.5 + 0.5);
        if (fx.sunColor) wu.uSunCol.value.copy(fx.sunColor);
      }
      wu.uRays.value = rays;
      this.world.enabled = wu.uBlur.value > 0 || wu.uDof.value > 0.01 || rays > 0.01;
    }
    this.composer.render(dt);
  }
}
