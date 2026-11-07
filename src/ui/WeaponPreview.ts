import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * Loadout-screen weapon preview: its own small WebGL canvas with studio lighting and a room
 * environment for reflections. The selected gun turns slowly; cards get white silhouette
 * thumbnails rendered from the same models (cached).
 */
export class WeaponPreview {
  readonly canvas = document.createElement('canvas');
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(24, 2, 0.05, 20);
  private models = new Map<string, THREE.Object3D>();
  private holder = new THREE.Group();
  private current: string | null = null;
  private thumbs = new Map<string, string>();
  private raf = 0;
  private t = 0;
  private white = new THREE.MeshBasicMaterial({ color: 0xffffff });

  constructor(private build: (id: string) => THREE.Object3D) {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.32;
    pm.dispose();
    const key = new THREE.DirectionalLight(0xfff2e0, 1.7);
    key.position.set(-1.5, 2.5, 2.5);
    const rim = new THREE.DirectionalLight(0xbcd2ff, 1.2);
    rim.position.set(2, 1, -2.5);
    const fill = new THREE.HemisphereLight(0xdfe6ee, 0x2a2620, 0.35);
    this.scene.add(key, rim, fill, this.holder);
    this.camera.position.set(0, 0.06, 2.3);
    this.camera.lookAt(0, 0, 0);
  }

  private model(id: string) {
    let m = this.models.get(id);
    if (!m) {
      const root = this.build(id);
      // side view, muzzle to the left, centred and scaled to a common length
      root.rotation.y = Math.PI / 2;
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const c = box.getCenter(new THREE.Vector3());
      const g = new THREE.Group();
      root.position.sub(c);
      g.add(root);
      g.scale.setScalar(1.15 / Math.max(size.x, 0.3));
      m = g;
      this.models.set(id, m);
    }
    return m;
  }

  /** Mount into a container and start turning the weapon `id`. */
  show(container: HTMLElement, id: string) {
    if (this.canvas.parentElement !== container) container.appendChild(this.canvas);
    if (this.current !== id) {
      this.holder.clear();
      this.holder.add(this.model(id));
      this.current = id;
      this.t = 0;
    }
    if (!this.raf) {
      let last = performance.now();
      const loop = (now: number) => {
        this.raf = this.canvas.isConnected ? requestAnimationFrame(loop) : 0;
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        this.t += dt;
        this.frame();
      };
      this.raf = requestAnimationFrame(loop);
    }
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame() {
    const r = this.canvas.parentElement?.getBoundingClientRect();
    if (!r || r.width < 2) return;
    const w = Math.round(r.width), h = Math.round(r.height);
    if (this.canvas.width !== Math.round(w * this.renderer.getPixelRatio()) || this.canvas.height !== Math.round(h * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    // a slow showroom turn: settles from a three-quarter view into the side profile and back
    const k = Math.min(1, this.t / 0.6);
    const ease = 1 - Math.pow(1 - k, 3);
    this.holder.rotation.y = Math.sin(this.t * 0.45) * 0.42 * ease + (1 - ease) * 0.9;
    this.holder.rotation.x = Math.sin(this.t * 0.31) * 0.05;
    this.holder.position.y = Math.sin(this.t * 0.8) * 0.006;
    this.renderer.render(this.scene, this.camera);
  }

  /** White silhouette of a weapon (data URL), for the carousel cards. */
  thumbnail(id: string) {
    const cached = this.thumbs.get(id);
    if (cached) return cached;
    const W = 320, H = 140;
    const prev = new THREE.Vector2();
    this.renderer.getSize(prev);
    const prevAspect = this.camera.aspect;
    this.renderer.setSize(W, H, false);
    this.camera.aspect = W / H;
    this.camera.updateProjectionMatrix();
    const keep = [...this.holder.children];
    this.holder.clear();
    this.holder.add(this.model(id));
    this.holder.rotation.set(0, 0, 0);
    this.holder.position.set(0, 0, 0);
    this.scene.overrideMaterial = this.white;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.render(this.scene, this.camera);
    const url = this.canvas.toDataURL('image/png');
    this.scene.overrideMaterial = null;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.holder.clear();
    for (const k of keep) this.holder.add(k);
    this.renderer.setSize(Math.max(1, prev.x), Math.max(1, prev.y), false);
    this.camera.aspect = prevAspect;
    this.camera.updateProjectionMatrix();
    this.thumbs.set(id, url);
    return url;
  }
}
