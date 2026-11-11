import * as THREE from 'three';
import { GLSL_NOISE } from './glsl';

/**
 * Bakes procedural textures on the GPU. Each surface is a GLSL function
 *   void surf(vec2 uv, out vec3 albedo, out float rough, out float h, out float ao)
 * The baker produces two textures:
 *   A: rgb = albedo (sRGB storage), a = roughness
 *   B: rgb = tangent space normal (from height gradient), a = height
 */
export interface SurfaceTextures {
  albedo: THREE.Texture;
  normal: THREE.Texture;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

interface BakeJob {
  name: string;
  /** compiled lazily (in parallel with every other job when the baker is deferred) */
  mat: THREE.ShaderMaterial | null;
  build: () => THREE.ShaderMaterial;
  /** surface jobs: MRT pass into the float scratch targets, then copy (albedo) + normal passes */
  kind: 'surface' | 'raw' | 'legacyA' | 'legacyB';
  rt: THREE.WebGLRenderTarget;
  rtB?: THREE.WebGLRenderTarget;
  size: number;
  hs?: number;
}

/**
 * Bakes procedural textures on the GPU.
 *
 * Each surface used to be two full-screen passes that evaluated the (noise-heavy) surface function
 * six times per texel — once for the albedo and five more (centre + four neighbours) to derive the
 * normal map — each pass a freshly compiled program. Now one multiple-render-target pass evaluates
 * it once per texel, writing albedo and an exact float height field; a cheap shared pass derives the
 * normal from neighbouring height texels (identical sample positions, so identical normals) and a
 * shared copy pass stores the albedo in the mip-mapped sRGB texture. 6× less GPU work, half the
 * shader compiles.
 *
 * While `defer` is set (during loading) bakes are only recorded; `flush()` then compiles every
 * program at once — on driver threads where KHR_parallel_shader_compile exists, without blocking the
 * page — and runs them. Jobs are kept so a lost-and-restored GPU context can re-bake everything.
 */
export class TextureBaker {
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private cache = new Map<string, SurfaceTextures>();
  targets = new Map<string, THREE.WebGLRenderTarget>();
  maxAniso: number;
  /** record bakes instead of running them (see flush) */
  defer = false;
  /** every bake ever requested (re-run after a context restore) */
  private jobs: BakeJob[] = [];
  private pending: BakeJob[] = [];
  private scratch = new Map<number, THREE.WebGLRenderTarget>();
  private floatType: THREE.TextureDataType | null;
  private copyMat: THREE.ShaderMaterial;
  private normalMat: THREE.ShaderMaterial;
  /** halve every surface's resolution (low preset: a quarter of the video memory) */
  sizeScale = 1;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const ext = renderer.extensions;
    this.floatType = ext.has('EXT_color_buffer_float') ? THREE.FloatType : null;
    this.copyMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: `uniform sampler2D tSrc; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tSrc, vUv); }`,
      uniforms: { tSrc: { value: null } },
      depthTest: false, depthWrite: false,
    });
    this.normalMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: `uniform sampler2D tH; uniform float uSize; uniform float uHS; varying vec2 vUv;
        void main(){
          float e = 1.0 / uSize;
          float hc = texture2D(tH, vUv).r;
          float hx = texture2D(tH, vUv + vec2(e, 0.0)).r - texture2D(tH, vUv - vec2(e, 0.0)).r;
          float hy = texture2D(tH, vUv + vec2(0.0, e)).r - texture2D(tH, vUv - vec2(0.0, e)).r;
          vec3 n = normalize(vec3(-hx * uHS * uSize / 512.0, -hy * uHS * uSize / 512.0, 1.0));
          gl_FragColor = vec4(n * 0.5 + 0.5, hc);
        }`,
      uniforms: { tH: { value: null }, uSize: { value: 1 }, uHS: { value: 1 } },
      depthTest: false, depthWrite: false,
    });
  }

  private target(size: number, srgb: boolean, mip = true) {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      generateMipmaps: mip,
      minFilter: mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
    });
    rt.texture.anisotropy = this.maxAniso;
    return rt;
  }

  /** float MRT scratch (albedo+roughness, height) per size, reused by every surface */
  private scratchFor(size: number) {
    let rt = this.scratch.get(size);
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(size, size, {
        count: 2,
        type: this.floatType!,
        format: THREE.RGBAFormat,
        generateMipmaps: false,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
        depthBuffer: false,
      });
      for (const t of rt.textures) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.minFilter = t.magFilter = THREE.NearestFilter;
      }
      this.scratch.set(size, rt);
    }
    return rt;
  }

  private draw(mat: THREE.Material, rt: THREE.WebGLRenderTarget) {
    this.quad.material = mat;
    const prev = this.renderer.getRenderTarget();
    const prevAuto = this.renderer.autoClear;
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, this.cam);
    this.renderer.setRenderTarget(prev);
    this.renderer.autoClear = prevAuto;
  }

  private execute(j: BakeJob) {
    const mat = j.mat ?? j.build();
    j.mat = null;
    if (j.kind === 'surface') {
      const tmp = this.scratchFor(j.size);
      this.draw(mat, tmp);
      this.copyMat.uniforms.tSrc.value = tmp.textures[0];
      this.draw(this.copyMat, j.rt);
      const nu = this.normalMat.uniforms;
      nu.tH.value = tmp.textures[1];
      nu.uSize.value = j.size;
      nu.uHS.value = j.hs ?? 4;
      this.draw(this.normalMat, j.rtB!);
    } else this.draw(mat, j.rt);
    mat.dispose();
  }

  private submit(j: BakeJob) {
    this.jobs.push(j);
    if (this.defer) this.pending.push(j);
    else this.execute(j);
  }

  /** bakes waiting for flush() */
  get pendingCount() {
    return this.pending.length;
  }

  /**
   * Compile every pending bake program at once (parallel, non-blocking where the driver can), then
   * run them. `progress` gets 0..1 (compile ≈ 80 %, baking the rest).
   */
  async flush(progress: (k: number) => void = () => {}) {
    const jobs = this.pending.splice(0);
    this.defer = false;
    if (!jobs.length) return;
    const scene = new THREE.Scene();
    const geo = this.quad.geometry;
    for (const j of jobs) {
      j.mat = j.build();
      const m = new THREE.Mesh(geo, j.mat);
      m.frustumCulled = false;
      scene.add(m);
    }
    for (const m of [this.copyMat, this.normalMat]) {
      const q = new THREE.Mesh(geo, m);
      q.frustumCulled = false;
      scene.add(q);
    }
    await compileWithProgress(this.renderer, scene, this.cam, (k) => progress(k * 0.8));
    let i = 0;
    for (const j of jobs) {
      this.execute(j);
      // let the loading screen breathe every few bakes
      if (++i % 6 === 0) {
        progress(0.8 + (0.2 * i) / jobs.length);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    progress(1);
  }

  /** After a lost GPU context comes back every render target is empty: bake them all again. */
  rebakeAll() {
    for (const rt of this.scratch.values()) rt.dispose();
    this.scratch.clear();
    for (const j of this.jobs) {
      j.mat = null;
      this.execute(j);
    }
  }

  /** Bake a surface definition (GLSL body of `surf`). heightScale controls normal strength. */
  surface(name: string, surfGLSL: string, size = 1024, heightScale = 4.0): SurfaceTextures {
    const hit = this.cache.get(name);
    if (hit) return hit;
    size = Math.max(128, Math.round(size * this.sizeScale));
    const common = `
      ${GLSL_NOISE}
      varying vec2 vUv;
      uniform float uSize;
      vec3 srgb(vec3 c){ return pow(c, vec3(2.2)); }
      vec3 hex(float r, float g, float b){ return pow(vec3(r,g,b)/255.0, vec3(2.2)); }
      ${surfGLSL}
    `;
    const rtA = this.target(size, true);
    const rtB = this.target(size, false);
    if (this.floatType) {
      // one evaluation per texel: albedo·ao + roughness and the exact height, into float MRT scratch
      const frag = `${common}
        layout(location = 0) out highp vec4 outA;
        layout(location = 1) out highp vec4 outH;
        void main(){ vec3 al; float r, h, ao; surf(vUv, al, r, h, ao); outA = vec4(al * ao, r); outH = vec4(h, 0.0, 0.0, 1.0); }`;
      this.submit({
        name, kind: 'surface', rt: rtA, rtB, size, hs: heightScale, mat: null,
        build: () => new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: frag, uniforms: { uSize: { value: size } }, depthTest: false, depthWrite: false }),
      });
    } else {
      // no float render targets: the original two passes (height re-evaluated for the normal)
      const fragA = `${common}
        void main(){ vec3 al; float r, h, ao; surf(vUv, al, r, h, ao); gl_FragColor = vec4(al * ao, r); }`;
      const fragB = `${common}
        uniform float uHS;
        float H(vec2 uv){ vec3 al; float r, h, ao; surf(fract(uv), al, r, h, ao); return h; }
        void main(){
          float e = 1.0 / uSize;
          float hc = H(vUv);
          float hx = H(vUv + vec2(e, 0.0)) - H(vUv - vec2(e, 0.0));
          float hy = H(vUv + vec2(0.0, e)) - H(vUv - vec2(0.0, e));
          vec3 n = normalize(vec3(-hx * uHS * uSize / 512.0, -hy * uHS * uSize / 512.0, 1.0));
          gl_FragColor = vec4(n * 0.5 + 0.5, hc);
        }`;
      this.submit({ name, kind: 'legacyA', rt: rtA, size, mat: null, build: () => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: fragA, uniforms: { uSize: { value: size } }, depthTest: false, depthWrite: false }) });
      this.submit({ name, kind: 'legacyB', rt: rtB, size, mat: null, build: () => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: fragB, uniforms: { uSize: { value: size }, uHS: { value: heightScale } }, depthTest: false, depthWrite: false }) });
    }
    const res = { albedo: rtA.texture, normal: rtB.texture };
    this.targets.set(name + ':A', rtA);
    this.targets.set(name + ':B', rtB);
    this.cache.set(name, res);
    return res;
  }

  /** Debug: average colour of a baked target (reads a small block). */
  sample(key: string) {
    const rt = this.targets.get(key);
    if (!rt) return null;
    const buf = new Uint8Array(16 * 16 * 4);
    this.renderer.readRenderTargetPixels(rt, 100, 100, 16, 16, buf);
    const avg = [0, 0, 0, 0];
    for (let i = 0; i < 256; i++) for (let c = 0; c < 4; c++) avg[c] += buf[i * 4 + c] / 256;
    return avg.map((v) => Math.round(v));
  }

  /** Bake an RGBA texture straight from a GLSL main() body writing gl_FragColor. */
  raw(name: string, mainGLSL: string, size = 512, srgb = true, w?: number, h?: number): THREE.Texture {
    const hit = this.cache.get(name);
    if (hit) return hit.albedo;
    const frag = `${GLSL_NOISE}
      varying vec2 vUv; uniform float uSize;
      vec3 srgb(vec3 c){ return pow(c, vec3(2.2)); }
      vec3 hex(float r, float g, float b){ return pow(vec3(r,g,b)/255.0, vec3(2.2)); }
      ${mainGLSL}`;
    const rt = this.target(size, srgb);
    if (w && h) rt.setSize(w, h);
    this.submit({ name, kind: 'raw', rt, size, mat: null, build: () => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms: { uSize: { value: size } }, depthTest: false, depthWrite: false }) });
    this.cache.set(name, { albedo: rt.texture, normal: rt.texture });
    return rt.texture;
  }
}

/**
 * renderer.compile() + wait until every program reports ready (KHR_parallel_shader_compile:
 * compiled on driver threads, the page keeps animating; without it the wait is the old blocking
 * compile). Reports the fraction of programs ready.
 */
export async function compileWithProgress(renderer: THREE.WebGLRenderer, scene: THREE.Object3D, camera: THREE.Camera, progress: (k: number) => void = () => {}, targetScene: THREE.Scene | null = null) {
  const mats = renderer.compile(scene, camera, targetScene) as unknown as Set<THREE.Material>;
  const total = Math.max(1, mats.size);
  const props = renderer.properties;
  const parallel = renderer.extensions.has('KHR_parallel_shader_compile');
  await new Promise<void>((resolve) => {
    const check = () => {
      for (const m of mats) {
        const prog = (props.get(m) as any).currentProgram;
        if (!prog || !parallel || prog.isReady()) mats.delete(m);
      }
      progress(1 - mats.size / total);
      if (mats.size === 0) resolve();
      else setTimeout(check, 8);
    };
    check();
  });
}
