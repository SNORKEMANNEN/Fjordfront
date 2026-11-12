import * as THREE from 'three';
import { WEAPONS } from '../weapons/WeaponDefs';

/**
 * White side-view silhouettes of the game's own 3D weapon models, for the kill feed, the death card
 * and the menu kit card. Rendered with the main renderer into a small offscreen target (no second
 * WebGL context), read back once and cached as PNG data URLs; built lazily, a few per idle frame.
 */
export class Silhouettes {
  private cache = new Map<string, string>();
  private byName = new Map<string, string>();
  private rt: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 20);
  private white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private W = 192;
  private H = 64;

  constructor(private renderer: THREE.WebGLRenderer, private build: (id: string) => THREE.Object3D) {
    this.rt = new THREE.WebGLRenderTarget(this.W, this.H, { colorSpace: THREE.NoColorSpace });
    this.scene.overrideMaterial = this.white;
    for (const [id, d] of Object.entries(WEAPONS)) {
      this.byName.set(d.name.toLowerCase(), id);
      this.byName.set(d.short.toLowerCase(), id);
      this.byName.set(id, id);
    }
  }

  /** a weapon name / short name / id → data URL (null for things that are not guns) */
  get(nameOrId: string): string | null {
    const id = this.byName.get(nameOrId.toLowerCase());
    if (!id || id === 'knife') return null;
    const c = this.cache.get(id);
    if (c) return c;
    const url = this.render(id);
    if (url) this.cache.set(id, url);
    return url;
  }

  /** pre-build a few each call (from an idle callback) */
  warm(n = 2) {
    for (const id of Object.keys(WEAPONS)) {
      if (n <= 0) return false;
      if (id === 'knife' || this.cache.has(id)) continue;
      this.get(id);
      n--;
    }
    return true;
  }

  private render(id: string) {
    let root: THREE.Object3D;
    try {
      root = this.build(id);
    } catch {
      return null;
    }
    const holder = new THREE.Group();
    root.rotation.set(0, Math.PI / 2, 0);
    holder.add(root);
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(holder);
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    // muzzle points right in the feed (killer → victim)
    holder.scale.x = -1;
    holder.position.set(c.x, -c.y, -c.z);
    holder.position.x = c.x;
    this.scene.add(holder);
    const aspect = this.W / this.H;
    const half = Math.max(size.x / 2 / aspect, size.y / 2) * 1.08;
    this.cam.left = -half * aspect;
    this.cam.right = half * aspect;
    this.cam.top = half;
    this.cam.bottom = -half;
    this.cam.position.set(0, 0, 5);
    this.cam.lookAt(0, 0, 0);
    this.cam.updateProjectionMatrix();
    const r = this.renderer;
    const prevRT = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const prevTM = r.toneMapping;
    r.toneMapping = THREE.NoToneMapping;
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(this.scene, this.cam);
    const px = new Uint8Array(this.W * this.H * 4);
    r.readRenderTargetPixels(this.rt, 0, 0, this.W, this.H, px);
    r.setRenderTarget(prevRT);
    r.setClearColor(prevClear, prevAlpha);
    r.toneMapping = prevTM;
    this.scene.remove(holder);
    // flip rows (GL is bottom-up) into a canvas
    const cv = document.createElement('canvas');
    cv.width = this.W;
    cv.height = this.H;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(this.W, this.H);
    for (let y = 0; y < this.H; y++) {
      const src = (this.H - 1 - y) * this.W * 4;
      img.data.set(px.subarray(src, src + this.W * 4), y * this.W * 4);
    }
    // solid white where anything was drawn (keeps the edge anti-aliasing from the alpha)
    for (let i = 0; i < img.data.length; i += 4) {
      const a = img.data[i + 3];
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL('image/png');
  }
}
