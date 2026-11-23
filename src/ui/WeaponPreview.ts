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

  constructor(private build: (id: string, b?: Record<string, string>) => THREE.Object3D) {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // a dark studio for the reflections (Update 46): a neutral charcoal sweep with softboxes — a
    // big warm-white one overhead, tall cyan and violet strips behind for the rims, a faint aurora
    // bounce from the floor — so the guns read black with crisp highlights instead of silver
    const pm = new THREE.PMREMGenerator(this.renderer);
    const studio = new THREE.Scene();
    studio.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.MeshBasicMaterial({ color: 0x1f2329, side: THREE.BackSide })));
    const box = (w: number, h: number, p: [number, number, number], col: number, k: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(k), side: THREE.DoubleSide }));
      m.position.set(...p);
      m.lookAt(0, 0, 0);
      studio.add(m);
    };
    box(7, 2.6, [0, 6, 2.5], 0xfff4e8, 1.6);
    box(2.2, 7, [-6.5, 1.5, -2.5], 0x7fe6ff, 1.2);
    box(2.2, 7, [6.5, 1.5, -3], 0xa890ff, 1.0);
    box(6, 1.4, [0, -5, 2.5], 0x5cf2c6, 0.5);
    box(8, 3.2, [-1, 2.2, 7], 0xeef0f2, 0.7);
    this.scene.environment = pm.fromScene(studio, 0.02).texture;
    this.scene.environmentIntensity = 1.05;
    pm.dispose();
    void RoomEnvironment;
    // Nordlys showroom (Update 45): a soft warm key, two aurora rims (ice cyan and violet) that
    // draw the gun's silhouette out of the dark bench, and a low cool fill
    const key = new THREE.DirectionalLight(0xfff1e2, 4.2);
    key.position.set(-1.5, 2.5, 2.5);
    const rim = new THREE.DirectionalLight(0x7fe6ff, 2.0);
    rim.position.set(2.2, 1.2, -2.5);
    const rim2 = new THREE.DirectionalLight(0xa890ff, 1.1);
    rim2.position.set(-2.4, 0.6, -2.2);
    const under = new THREE.DirectionalLight(0x5cf2c6, 0.35);
    under.position.set(0, -2, 1);
    const fill = new THREE.HemisphereLight(0xe2e8ee, 0x262b31, 1.3);
    this.scene.add(key, rim, rim2, under, fill, this.holder);
    this.camera.position.set(0, 0.06, 2.3);
    this.camera.lookAt(0, 0, 0);
  }

  private model(id: string, b?: Record<string, string>) {
    const key = b && Object.keys(b).length ? `${id}|${JSON.stringify(b)}` : id;
    let m = this.models.get(key);
    if (!m) {
      // keep the cache small: gunsmith previews make a model per build
      if (this.models.size > 40) {
        for (const [k, o] of this.models) {
          if (k.includes('|') && !this.holder.children.includes(o)) {
            o.traverse((x) => { if ((x as THREE.Mesh).isMesh && x.parent?.name === 'attach') (x as THREE.Mesh).geometry.dispose(); });
            this.models.delete(k);
          }
          if (this.models.size <= 24) break;
        }
      }
      const root = this.build(id, b);
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
      this.models.set(key, m);
    }
    return m;
  }

  /** Mount into a container and start turning the weapon `id`. */
  show(container: HTMLElement, id: string, b?: Record<string, string>) {
    if (this.canvas.parentElement !== container) container.appendChild(this.canvas);
    const key = b && Object.keys(b).length ? `${id}|${JSON.stringify(b)}` : id;
    if (this.current !== key) {
      // a new gun starts its turn again; another build of the same gun keeps turning
      const sameGun = this.current?.split('|')[0] === id;
      this.holder.clear();
      this.holder.add(this.model(id, b));
      this.current = key;
      if (!sameGun) this.t = 0;
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
      // back off far enough that the whole gun (and its turn) fits a tall bench too
      const half = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      const dist = Math.max(2.3, 0.78 / (half * this.camera.aspect));
      this.camera.position.set(0, 0.06 * (dist / 2.3), dist);
      this.camera.lookAt(0, 0, 0);
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
    const prevPos = this.camera.position.clone();
    this.camera.position.set(0, 0.06, 2.3);
    this.camera.lookAt(0, 0, 0);
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
    this.camera.position.copy(prevPos);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.thumbs.set(id, url);
    return url;
  }
}
