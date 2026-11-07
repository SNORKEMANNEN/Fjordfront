import * as THREE from 'three';

/**
 * Picture-in-picture rifle scope: the world is rendered through a narrow camera
 * into a render target and shown on the eyepiece lens with a mil-dot reticle,
 * eye-relief shadow and lens tint. The rest of the screen keeps the normal FOV.
 */
export class Scope {
  rt: THREE.WebGLRenderTarget;
  cam = new THREE.PerspectiveCamera(4, 1, 0.1, 12000);
  mat: THREE.ShaderMaterial;
  private originalMat: THREE.Material | null = null;
  private lens: THREE.Mesh | null = null;
  active = false;

  constructor(size = 512) {
    this.rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, samples: 2 });
    this.rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { tView: { value: this.rt.texture }, uShadow: { value: 0 }, uOffset: { value: new THREE.Vector2() }, uExposure: { value: 1 }, uReticle: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tView; uniform float uShadow; uniform vec2 uOffset; uniform float uExposure; uniform float uReticle;
        varying vec2 vUv;
        vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
        float line(float d, float w){ return 1.0 - smoothstep(w * 0.5, w * 0.5 + 0.0025, abs(d)); }
        void main(){
          vec2 p = vUv - 0.5;
          float r = length(p);
          vec3 col = texture2D(tView, vUv).rgb * uExposure;
          col = pow(aces(col), vec3(1.0 / 2.2));
          col = pow(col, vec3(2.2)); // back to linear for the viewmodel pipeline
          // mil-dot reticle (thin centre, thick posts outside)
          float thin = 0.004, thick = 0.014;
          float cross = max(line(p.x, abs(p.y) < 0.28 ? thin : thick) * step(abs(p.y), 0.5), line(p.y, abs(p.x) < 0.28 ? thin : thick) * step(abs(p.x), 0.5));
          cross *= 1.0 - step(r, 0.012) * 0.0;
          float dots = 0.0;
          for (int i = 1; i <= 5; i++) {
            float o = float(i) * 0.048;
            dots = max(dots, 1.0 - smoothstep(0.004, 0.007, length(p - vec2(0.0, -o))));
            dots = max(dots, 1.0 - smoothstep(0.004, 0.007, length(p - vec2(o, 0.0))));
            dots = max(dots, 1.0 - smoothstep(0.004, 0.007, length(p - vec2(-o, 0.0))));
          }
          if (uReticle > 0.5) {
            // clean duplex-free cross: one thin, crisp line each way, edge to edge, nothing else
            float w = 0.0026;
            float cx = 1.0 - smoothstep(w * 0.5, w * 0.5 + 0.0016, abs(p.x));
            float cy = 1.0 - smoothstep(w * 0.5, w * 0.5 + 0.0016, abs(p.y));
            col = mix(col, vec3(0.0), max(cx, cy) * 0.96);
          } else {
            col = mix(col, vec3(0.0), max(cross, dots));
            // illuminated centre dot
            col += vec3(3.0, 0.15, 0.05) * (1.0 - smoothstep(0.0025, 0.004, r));
          }
          // eye-relief shadow: off-axis viewing darkens the edge
          float edge = smoothstep(0.5, 0.36 - uShadow * 0.25, length(p + uOffset * 0.6));
          col *= edge;
          col *= vec3(0.96, 1.0, 0.98);
          gl_FragColor = vec4(col, 1.0);
        }`,
      toneMapped: false,
    });
  }

  attach(lens: THREE.Mesh | undefined) {
    if (this.lens && this.originalMat) this.lens.material = this.originalMat;
    this.lens = lens ?? null;
    if (lens) {
      this.originalMat = lens.material as THREE.Material;
    }
  }

  /** Render the magnified view. lensAngle = angular diameter of the lens on screen (radians). */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, main: THREE.PerspectiveCamera, lensAngle: number, zoom: number, amount: number, offset: THREE.Vector2) {
    if (!this.lens) return;
    this.active = amount > 0.25;
    this.lens.material = this.active ? this.mat : this.originalMat!;
    if (!this.active) return;
    this.cam.position.copy(main.position);
    this.cam.quaternion.copy(main.quaternion);
    this.cam.layers.mask = main.layers.mask;
    this.cam.fov = THREE.MathUtils.radToDeg(lensAngle / zoom);
    this.cam.aspect = 1;
    this.cam.updateProjectionMatrix();
    this.cam.updateMatrixWorld();
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, this.cam);
    renderer.setRenderTarget(prev);
    this.mat.uniforms.uShadow.value = 1 - amount;
    this.mat.uniforms.uOffset.value.copy(offset);
  }
}
