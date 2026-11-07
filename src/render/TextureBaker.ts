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

export class TextureBaker {
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private cache = new Map<string, SurfaceTextures>();
  targets = new Map<string, THREE.WebGLRenderTarget>();
  maxAniso: number;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
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

  private run(frag: string, rt: THREE.WebGLRenderTarget, uniforms: Record<string, THREE.IUniform> = {}) {
    const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    this.quad.material = mat;
    const prev = this.renderer.getRenderTarget();
    const prevAuto = this.renderer.autoClear;
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, this.cam);
    this.renderer.setRenderTarget(prev);
    this.renderer.autoClear = prevAuto;
    mat.dispose();
  }

  /** Bake a surface definition (GLSL body of `surf`). heightScale controls normal strength. */
  surface(name: string, surfGLSL: string, size = 1024, heightScale = 4.0): SurfaceTextures {
    const hit = this.cache.get(name);
    if (hit) return hit;
    const common = `
      ${GLSL_NOISE}
      varying vec2 vUv;
      uniform float uSize;
      vec3 srgb(vec3 c){ return pow(c, vec3(2.2)); }
      vec3 hex(float r, float g, float b){ return pow(vec3(r,g,b)/255.0, vec3(2.2)); }
      ${surfGLSL}
    `;
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
    const rtA = this.target(size, true);
    const rtB = this.target(size, false);
    this.run(fragA, rtA, { uSize: { value: size } });
    this.run(fragB, rtB, { uSize: { value: size }, uHS: { value: heightScale } });
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
    this.run(frag, rt, { uSize: { value: size } });
    this.cache.set(name, { albedo: rt.texture, normal: rt.texture });
    return rt.texture;
  }
}
