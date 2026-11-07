import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Static batching: bake every plain mesh under `root` into one merged mesh per material (positions
 * baked relative to `root`). Looks identical, but a weapon built from ~25 parts becomes 3–5 draw
 * calls (and as many shadow draws). Shader materials, transparent parts, skinned meshes, sprites
 * and anything listed in `keep` (moving parts) are left alone.
 */
export function bakeStatic(root: THREE.Object3D, keep: THREE.Object3D[] = []) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const keepSet = new Set<THREE.Object3D>();
  for (const k of keep) k.traverse((o) => keepSet.add(o));
  const groups = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; cast: boolean; receive: boolean }>();
  const remove: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || keepSet.has(m) || (m as any).isSkinnedMesh || (m as any).isInstancedMesh) return;
    if (Array.isArray(m.material)) return;
    const mat = m.material as THREE.Material;
    if ((mat as any).isShaderMaterial || mat.transparent || !m.visible) return;
    // only bake meshes whose whole ancestor chain is visible
    let p: THREE.Object3D | null = m.parent;
    while (p && p !== root) {
      if (!p.visible) return;
      p = p.parent;
    }
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.morphAttributes = {};
    g.clearGroups();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    const e = groups.get(mat) ?? { geos: [], cast: false, receive: false };
    e.geos.push(g);
    e.cast ||= m.castShadow;
    e.receive ||= m.receiveShadow;
    groups.set(mat, e);
    remove.push(m);
  });
  if (remove.length < 2) return 0;
  for (const m of remove) m.removeFromParent();
  let n = 0;
  for (const [mat, e] of groups) {
    const merged = mergeGeometries(e.geos, false);
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = e.cast;
    mesh.receiveShadow = e.receive;
    mesh.name = 'baked';
    root.add(mesh);
    n++;
  }
  return remove.length - n;
}

/** Static scenery: stop recomposing local matrices every frame (they never change). */
export function freezeStatic(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    o.matrixAutoUpdate = false;
  });
}

const flatMats = new Map<string, THREE.MeshStandardMaterial>();
/**
 * Third-person props (bot guns): bake EVERY plain opaque mesh under `root` into ONE mesh with the
 * material colours written as vertex colours — one draw call (and one shadow draw) per gun instead
 * of one per material. Shader / transparent parts (optic lenses, laser beams, reticles) are dropped:
 * at third-person distances they're invisible anyway. Sockets (empty Object3Ds) are kept.
 */
export function bakeFlat(root: THREE.Object3D, key = 'prop') {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const geos: THREE.BufferGeometry[] = [];
  const drop: THREE.Object3D[] = [];
  let rough = 0, metal = 0, n = 0, cast = false;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as any).isSkinnedMesh || (m as any).isInstancedMesh) return;
    drop.push(m);
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
    if (!mat || (mat as any).isShaderMaterial || mat.transparent || !m.visible || !mat.color) return;
    let p: THREE.Object3D | null = m.parent;
    while (p && p !== root) {
      if (!p.visible) return;
      p = p.parent;
    }
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    g.morphAttributes = {};
    g.clearGroups();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    const c = mat.color.clone();
    if (mat.emissive && mat.emissiveIntensity > 0) c.add(mat.emissive.clone().multiplyScalar(mat.emissiveIntensity * 0.5));
    const cnt = g.attributes.position.count;
    const col = new Float32Array(cnt * 3);
    for (let i = 0; i < cnt; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geos.push(g);
    rough += mat.roughness ?? 0.6;
    metal += mat.metalness ?? 0.2;
    n++;
    cast ||= m.castShadow;
  });
  if (!n) return null;
  for (const m of drop) m.removeFromParent();
  const merged = mergeGeometries(geos, false);
  if (!merged) return null;
  merged.computeBoundingSphere();
  let mat = flatMats.get(key);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: Math.min(0.75, rough / n), metalness: Math.min(0.5, metal / n), name: 'flat:' + key });
    flatMats.set(key, mat);
  }
  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  mesh.name = 'baked';
  root.add(mesh);
  return mesh;
}
