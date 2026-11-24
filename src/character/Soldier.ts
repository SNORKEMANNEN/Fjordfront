import * as THREE from 'three';
import { heldProp } from './HeldProps';
import type { TextureBaker } from '../render/TextureBaker';
import type { WeaponModel } from '../weapons/WeaponModels';
import { buildSkeleton } from './SoldierRig';
import { buildSoldierGeometry, SoldierLook, varietyFor } from './SoldierMesh';
import { AnimState, newUpperOut, SoldierAnimator, UpperOut } from './SoldierAnim';

// ------------------------------------------------------------------ camo + material

/**
 * Fictional faction camouflage, baked once on the GPU (tileable, 512²):
 *  - Kystjegerne: "fjordskog" — organic olive / forest-green / bark-brown / black blotches with
 *    small light specks;
 *  - Nordfront: "berg" — angular rock-splinter shards in coyote, grey-olive, brown and charcoal over
 *    fine vertical rain dashes.
 * Winter versions keep each pattern's character on a snow-white base.
 */
const CAMO: Record<string, string> = {
  kyst: `void main(){ vec2 p = vUv;
    vec2 w = vec2(tfbm(p*3.0+vec2(1.3,7.1), 3.0, 3), tfbm(p*3.0+vec2(5.2,2.8), 3.0, 3)) - 0.5;
    vec2 q = p + w*0.18;
    float a = tfbm(q*4.0, 4.0, 4), b = tfbm(q*5.0+vec2(3.1,1.7), 5.0, 4), c = tfbm(q*6.0+vec2(7.7,4.4), 6.0, 3), d = tnoise(p*48.0, vec2(48.0));
    vec3 col = hex(98.0, 104.0, 66.0);
    col = mix(col, hex(52.0, 70.0, 42.0), smoothstep(0.5, 0.52, a));
    col = mix(col, hex(96.0, 74.0, 50.0), smoothstep(0.56, 0.58, b));
    col = mix(col, hex(24.0, 26.0, 22.0), smoothstep(0.62, 0.64, c));
    col = mix(col, hex(150.0, 142.0, 104.0), step(0.86, d) * 0.7);
    float grain = tnoise(p*180.0, vec2(180.0));
    gl_FragColor = vec4(col * (0.92 + grain*0.16), 1.0); }`,
  nord: `void main(){ vec2 p = vUv;
    vec3 v = tvoronoi(vec2(p.x*10.0, p.y*6.0) + vec2(tfbm(p*2.0, 2.0, 2)*0.6), vec2(10.0, 6.0));
    float id = fract(v.z * 7.31);
    vec3 col = id < 0.38 ? hex(122.0, 112.0, 88.0) : id < 0.62 ? hex(92.0, 94.0, 74.0) : id < 0.84 ? hex(88.0, 70.0, 52.0) : hex(44.0, 44.0, 40.0);
    col *= 0.85 + 0.15 * smoothstep(0.0, 0.06, v.y - v.x);
    float rain = step(0.78, tnoise(vec2(p.x*90.0, p.y*16.0), vec2(90.0, 16.0)));
    col = mix(col, hex(58.0, 60.0, 46.0), rain * 0.7);
    float grain = tnoise(p*180.0, vec2(180.0));
    gl_FragColor = vec4(col * (0.92 + grain*0.16), 1.0); }`,
  kystW: `void main(){ vec2 p = vUv;
    vec2 w = vec2(tfbm(p*3.0+vec2(1.3,7.1), 3.0, 3), tfbm(p*3.0+vec2(5.2,2.8), 3.0, 3)) - 0.5;
    vec2 q = p + w*0.18;
    float a = tfbm(q*4.0, 4.0, 4), c = tfbm(q*6.0+vec2(7.7,4.4), 6.0, 3);
    vec3 col = hex(214.0, 218.0, 220.0);
    col = mix(col, hex(150.0, 158.0, 150.0), smoothstep(0.6, 0.62, a));
    col = mix(col, hex(78.0, 84.0, 74.0), smoothstep(0.68, 0.7, c));
    float grain = tnoise(p*180.0, vec2(180.0));
    gl_FragColor = vec4(col * (0.94 + grain*0.1), 1.0); }`,
  nordW: `void main(){ vec2 p = vUv;
    vec3 v = tvoronoi(vec2(p.x*10.0, p.y*6.0) + vec2(tfbm(p*2.0, 2.0, 2)*0.6), vec2(10.0, 6.0));
    float id = fract(v.z * 7.31);
    vec3 col = id < 0.55 ? hex(222.0, 222.0, 216.0) : id < 0.8 ? hex(176.0, 176.0, 170.0) : hex(120.0, 118.0, 108.0);
    float rain = step(0.82, tnoise(vec2(p.x*90.0, p.y*16.0), vec2(90.0, 16.0)));
    col = mix(col, hex(140.0, 140.0, 132.0), rain * 0.6);
    gl_FragColor = vec4(col, 1.0); }`,
};
const TEAM_COL = [new THREE.Color(0x2a6ad8), new THREE.Color(0xc8281c)];

export const SoldierStyle = {
  textures: null as null | Record<string, THREE.Texture>,
  winter: false,
  live: new Set<THREE.MeshStandardMaterial>(),
  init(baker: TextureBaker) {
    if (this.textures) return;
    this.textures = {};
    for (const [k, src] of Object.entries(CAMO)) this.textures[k] = baker.raw('camo.' + k, src, 512, true);
  },
  camo(team: 0 | 1) {
    const k = (team === 0 ? 'kyst' : 'nord') + (this.winter ? 'W' : '');
    return this.textures?.[k] ?? null;
  },
  setWinter(w: boolean) {
    if (this.winter === w) return;
    this.winter = w;
    for (const m of this.live) m.userData.uCamo.value = this.camo(m.userData.team);
  },
};

/** uniforms every soldier material shares (Update 46): time (strobes), the viewer's night-vision
 *  level (IR strobes only show through goggles) and how much daylight there is (cloth sheen) */
export const SOLDIER_SHARED = { uTime: { value: 0 }, uStrobe: { value: 0 }, uLight: { value: 1 } };

/**
 * The soldier material (Update 46 rewrite). One MeshStandardMaterial, every part told apart by
 * its aMat kind, with the detail computed from the bind-pose position (metric, so every garment
 * shares one scale):
 *  - camo cloth: the faction pattern, a fine rip-stop weave (faded out with distance so it never
 *    shimmers), soft wrinkles, and a velvet sheen at grazing angles
 *  - nylon webbing: MOLLE rows (25 mm straps, 13 mm gaps) with bar-tack stitching and cordura grain
 *  - skin: a warm subsurface lift, pores, slight oil on the T-zone
 *  - knit: vertical ribbing, fuzzy roughness · hard plastic: fine stipple
 *  - the shoulder flag patch (Norway's cross for Kystjegerne, a peak-and-raven mark for Nordfront)
 *  - the helmet IR strobe, blinking only through night vision
 *  - mud and dust climbing from the boots up the trouser legs and onto the knees
 */
function makeMaterial(team: 0 | 1) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0.8 });
  m.name = 'soldier';
  m.userData.snow = true; // (no snow-on-top patch for people)
  m.userData.team = team;
  m.userData.uCamo = { value: SoldierStyle.camo(team) };
  m.userData.uTeam = { value: TEAM_COL[team].clone() };
  m.userData.uNVG = { value: 0 };
  m.userData.uFaction = { value: team };
  m.userData.uPlate = { value: new THREE.Vector2() };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uCamo = m.userData.uCamo;
    sh.uniforms.uTeam = m.userData.uTeam;
    sh.uniforms.uNVG = m.userData.uNVG;
    sh.uniforms.uFaction = m.userData.uFaction;
    sh.uniforms.uPlate = m.userData.uPlate;
    sh.uniforms.uTime = SOLDIER_SHARED.uTime;
    sh.uniforms.uStrobe = SOLDIER_SHARED.uStrobe;
    sh.uniforms.uLight = SOLDIER_SHARED.uLight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aMat; varying vec3 vMat; varying vec2 vCamoUv; varying vec3 vBind; uniform float uNVG;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vMat = aMat; vCamoUv = uv; vBind = position;
        // goggles: lowered tubes only when worn down, raised ones otherwise (collapsed to a point)
        if ((aMat.x > 2.5 && aMat.x < 3.5 && uNVG < 0.5) || (aMat.x > 3.5 && aMat.x < 4.5 && uNVG > 0.5)) transformed = vec3(0.0, 1.7, 0.0);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vMat; varying vec2 vCamoUv; varying vec3 vBind; uniform sampler2D uCamo; uniform vec3 uTeam;
        uniform float uTime; uniform float uStrobe; uniform float uLight; uniform float uFaction; uniform vec2 uPlate;
        float sH(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float sN(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(mix(sH(i), sH(i+vec3(1,0,0)), f.x), mix(sH(i+vec3(0,1,0)), sH(i+vec3(1,1,0)), f.x), f.y),
                     mix(mix(sH(i+vec3(0,0,1)), sH(i+vec3(1,0,1)), f.x), mix(sH(i+vec3(0,1,1)), sH(i+vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float kind = vMat.x;
        vec3 bp = vBind;
        float bumpH = 0.0, bumpK = 0.0, roughAdd = 0.0;
        vec3 glow = vec3(0.0);
        // how fine a detail this pixel can still show (fades micro detail with distance)
        float fine = clamp(1.0 - length(fwidth(bp)) * 260.0, 0.0, 1.0);
        float mid = clamp(1.0 - length(fwidth(bp)) * 40.0, 0.0, 1.0);
        if (kind < 0.5) {
          diffuseColor.rgb = texture2D(uCamo, vCamoUv).rgb * vColor.rgb;
          // rip-stop weave: a fine grid with a heavier thread every 6 mm
          float wv = sin(bp.x * 2400.0 + bp.z * 2400.0) * sin(bp.y * 2400.0);
          float rip = max(smoothstep(0.88, 0.97, abs(sin(bp.y * 520.0))), smoothstep(0.88, 0.97, abs(sin((bp.x + bp.z) * 520.0))));
          bumpH += (wv * 0.00012 + rip * 0.00018) * fine;
          diffuseColor.rgb *= 1.0 - rip * 0.06 * fine;
          // wrinkles: soft folds running round the limbs
          float wr = sN(vec3(bp.x * 22.0, bp.y * 5.0, bp.z * 22.0)) * 0.7 + sN(vec3(bp.x * 50.0, bp.y * 12.0, bp.z * 50.0)) * 0.3;
          bumpH += wr * 0.0012 * mid;
          diffuseColor.rgb *= 0.93 + 0.12 * wr;
          bumpK = 1.0;
        } else if (kind > 1.5 && kind < 2.5) {
          diffuseColor.rgb = uTeam;
        } else if (kind > 12.5 && kind < 13.5) {
          // (Update 47) the plate bag: cordura over ceramic. Damage (front / back) tears the cover
          // in a spider web of cracks from the strikes, with chalky ceramic showing in the breaks
          float grain = sN(bp * 900.0);
          diffuseColor.rgb *= 0.94 + 0.1 * grain * fine;
          bumpH += grain * 0.00008 * mid;
          bumpK = 1.0;
          float dmg = bp.z > 0.0 ? uPlate.x : uPlate.y;
          if (dmg > 0.01) {
            vec2 q = vec2(bp.x, bp.y) * 26.0;
            // cells round strike points; the edges are the cracks
            vec2 iq = floor(q), fq = fract(q);
            float d1 = 8.0, d2 = 8.0;
            for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
              vec2 g = vec2(float(i), float(j));
              vec2 o = vec2(sH(vec3(iq + g, 3.1)), sH(vec3(iq + g, 7.7)));
              float d = length(g + o - fq);
              if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
            }
            float edge = 1.0 - smoothstep(0.0, 0.08, d2 - d1);
            // the damage spreads out from a couple of impact points as it grows
            float hitA = length(vec2(bp.x - 0.05, bp.y - 1.27)) , hitB = length(vec2(bp.x + 0.07, bp.y - 1.21));
            float reach = mix(0.03, 0.22, dmg);
            float zone = smoothstep(reach, reach * 0.4, min(hitA, hitB));
            float crack = edge * zone;
            float spall = smoothstep(0.75, 0.9, sN(vec3(bp.xy * 60.0, 1.0))) * zone * dmg;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.08, 0.075, 0.07), crack * 0.85);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72, 0.7, 0.66), spall * 0.9 + crack * 0.25 * dmg);
            bumpH -= (crack * 0.0015 + spall * 0.001) * mid;
            roughAdd += spall * 0.1;
          }
        } else if (kind > 6.5 && kind < 7.5) {
          // nylon webbing: MOLLE rows, bar-tacks, cordura grain
          float row = fract(bp.y / 0.0381);
          float gap = smoothstep(0.62, 0.66, row) * (1.0 - smoothstep(0.96, 1.0, row));
          float tack = smoothstep(0.9, 0.97, abs(sin((bp.x + bp.z * 0.7) * 82.0))) * (1.0 - gap);
          float grain = sN(bp * 900.0);
          diffuseColor.rgb *= mix(1.0, 0.62, gap * mid) * (1.0 + tack * 0.12 * fine) * (0.94 + 0.1 * grain * fine);
          bumpH += (-gap * 0.0012 + grain * 0.00008) * mid;
          bumpK = 1.0;
        } else if (kind > 7.5 && kind < 8.5) {
          // skin: pores and a little shine on the forehead and nose
          float pore = sN(bp * 1800.0);
          bumpH += pore * 0.00006 * fine;
          bumpK = 1.0;
          roughAdd -= 0.12 * smoothstep(0.1, 0.0, abs(bp.x)) * smoothstep(1.64, 1.7, bp.y);
          diffuseColor.rgb *= 0.97 + 0.06 * sN(bp * 260.0);
        } else if (kind > 8.5 && kind < 9.5) {
          // IR strobe: a short double blink every ~1.2 s, seen only through night vision
          float ph = fract(uTime * 0.85 + sH(floor(bp * 50.0)));
          float blink = step(ph, 0.04) + step(abs(ph - 0.11), 0.03);
          glow += vec3(0.7, 1.0, 0.8) * blink * uStrobe * 14.0;
          diffuseColor.rgb *= 0.4;
        } else if (kind > 9.5 && kind < 10.5) {
          // the shoulder patch, drawn in its own uv (0..1 across the face)
          vec2 u = fract(vCamoUv);
          vec3 c;
          if (uFaction < 0.5) {
            // Norway: red field, white-edged blue Nordic cross
            float cx = abs(u.x - 0.36) * 22.0, cy = abs(u.y - 0.5) * 16.0;
            float m = min(cx, cy);
            c = m < 1.0 ? vec3(0.0, 0.13, 0.36) : m < 2.0 ? vec3(0.9) : vec3(0.65, 0.05, 0.1);
            c *= 0.75; // subdued, sewn-on
          } else {
            // Nordfront: charcoal with three pale peaks
            float pk = 0.25 + 0.45 * (1.0 - abs(fract(u.x * 1.5) - 0.5) * 2.0);
            c = u.y < pk ? vec3(0.62, 0.6, 0.55) : vec3(0.1, 0.1, 0.1);
          }
          diffuseColor.rgb = c;
        } else if (kind > 10.5 && kind < 11.5) {
          // knit: vertical ribs
          float rib = sin((bp.x * 0.7 + bp.z) * 700.0);
          bumpH += rib * 0.0002 * fine;
          bumpK = 1.0;
          diffuseColor.rgb *= 0.92 + 0.08 * rib * fine;
        } else if (kind > 11.5 && kind < 12.5) {
          float st = sN(bp * 1500.0);
          bumpH += st * 0.00005 * fine;
          bumpK = 1.0;
          roughAdd += (st - 0.5) * 0.1;
        }
        // mud and dust: from the boot soles up the trouser legs, heavier on the knees and the shins
        if (kind < 1.5 || (kind > 6.5 && kind < 7.5)) {
          float n = sN(bp * 9.0) * 0.6 + sN(bp * 31.0) * 0.4;
          float dirt = smoothstep(0.42, 0.02, bp.y + n * 0.16) + smoothstep(0.05, 0.0, abs(bp.y - 0.5) - 0.06) * step(0.03, bp.z) * 0.7;
          dirt = clamp(dirt * (0.55 + 0.45 * n), 0.0, 0.85);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.23, 0.2, 0.15), dirt * 0.65);
          roughAdd += dirt * 0.15;
        }`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(vMat.y + roughAdd, 0.04, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vMat.z;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // micro detail as a screen-space bump (no tangents needed)
          vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition);
          float dhx = dFdx(bumpH), dhy = dFdy(bumpH);
          if (bumpK > 0.0) {
            vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
            float det = dot(dpdx, r1);
            vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
            normal = normalize(abs(det) * normal - grad * 1.0);
          }
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vMat.x > 1.5 && vMat.x < 2.5) totalEmissiveRadiance += uTeam * 0.12;
        totalEmissiveRadiance += glow;
        {
          float ndv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
          // cloth sheen at grazing angles (fibres catching the sky), skin's warm subsurface lift
          if (kind < 0.5 || (kind > 6.5 && kind < 7.5) || (kind > 10.5 && kind < 11.5)) totalEmissiveRadiance += diffuseColor.rgb * pow(1.0 - ndv, 4.0) * 0.16 * uLight;
          if (kind > 7.5 && kind < 8.5) totalEmissiveRadiance += diffuseColor.rgb * vec3(0.05, 0.016, 0.01) * uLight;
        }`);
  };
  m.customProgramCacheKey = () => 'soldier3';
  SoldierStyle.live.add(m);
  return m;
}

// ------------------------------------------------------------------ the soldier

const vR = new THREE.Vector3(), vA = new THREE.Vector3(), vU = new THREE.Vector3(), vChest = new THREE.Vector3(), vGP = new THREE.Vector3();
const vT1 = new THREE.Vector3(), vT2 = new THREE.Vector3(), vT3 = new THREE.Vector3(), vGrip = new THREE.Vector3(), vTgt = new THREE.Vector3(), vPole = new THREE.Vector3();
const gQ = new THREE.Quaternion(), gQ0 = new THREE.Quaternion();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion(), _q5 = new THREE.Quaternion(), _q6 = new THREE.Quaternion();
const ARM_BONES = ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'];
const SPINE = ['Spine', 'Spine1', 'Spine2'];
const SIDES = ['Right', 'Left'] as const;
const XV = new THREE.Vector3(1, 0, 0), ZV = new THREE.Vector3(0, 0, 1);
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const _eu = new THREE.Euler();
const UPV = new THREE.Vector3(0, 1, 0);

/**
 * One soldier: its own skeleton, one skinned mesh (three detail levels), a team camo material,
 * the procedural animator and the weapon held with both hands.
 */
export class Soldier {
  model = new THREE.Group();
  mesh: THREE.SkinnedMesh;
  bones: Record<string, THREE.Bone>;
  skeleton: THREE.Skeleton;
  material: THREE.MeshStandardMaterial;
  anim: SoldierAnimator;
  lods: (THREE.BufferGeometry | null)[] = [null, null, null];
  lod = -1;
  private up: UpperOut = newUpperOut();
  height: number;
  /** anchor points on the body for reload hand paths (model space, rest pose) */
  private pouchL = new THREE.Vector3(0.16, 1.0, 0.12);

  constructor(public look: SoldierLook, public team: 0 | 1, public weapon: WeaponModel | null) {
    const v = varietyFor(look, team);
    this.height = v.height;
    const sk = buildSkeleton(v.height, v.width);
    this.bones = sk.byName;
    this.material = makeMaterial(team);
    this.lods[2] = buildSoldierGeometry(look, team, 2);
    this.mesh = new THREE.SkinnedMesh(this.lods[2], this.material);
    this.mesh.name = 'soldierMesh';
    this.model.add(sk.root);
    this.model.add(this.mesh);
    this.model.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(sk.bones);
    this.mesh.bind(this.skeleton, new THREE.Matrix4());
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // generous fixed bounds (covers crouch, prone, ragdoll flail) so the soldier can be culled
    this.mesh.geometry.computeBoundingSphere();
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 2.2);
    this.anim = new SoldierAnimator(this.bones, v.height);
    this.lod = 2;
    // the nearer detail levels are built in the background (Soldier.idleBuild), not at load
    Soldier.queue.push(this);
    if (weapon) this.model.add(weapon.root);
  }

  /** soldiers still missing detail levels */
  static queue: Soldier[] = [];
  /** build pending detail levels for up to `budgetMs` (call once per frame) */
  static idleBuild(budgetMs: number) {
    const q = Soldier.queue;
    if (!q.length) return;
    const t0 = performance.now();
    while (q.length && performance.now() - t0 < budgetMs) {
      const s = q[0];
      const l = s.lods[1] ? 0 : 1;
      s.lods[l] ??= buildSoldierGeometry(s.look, s.team, l as 0 | 1);
      if (s.lods[0] && s.lods[1]) q.shift();
    }
  }

  /** swap the detail level (geometry built on first use; all share the skeleton) */
  setLod(l: number) {
    if (l === this.lod) return;
    this.lod = l;
    const g = (this.lods[l] ??= buildSoldierGeometry(this.look, this.team, l as 0 | 1 | 2));
    this.mesh.geometry = g;
  }

  /** (Update 47) how chewed up the front / back plate bags look (0 new .. 1 broken) */
  setPlateDamage(front: number, back: number) {
    const u = this.material.userData.uPlate.value as THREE.Vector2;
    u.set(front, back);
  }
  setTeam(t: 0 | 1) {
    if (t === this.team) return;
    this.team = t;
    this.material.userData.team = t;
    this.material.userData.uCamo.value = SoldierStyle.camo(t);
    this.material.userData.uFaction.value = t;
    this.material.userData.uTeam.value.copy(TEAM_COL[t]);
    // gear colours follow the faction
    this.lods = [null, null, null];
    const l = this.lod;
    this.lod = -1;
    this.setLod(l);
  }

  setNVG(on: boolean) {
    this.material.userData.uNVG.value = on ? 1 : 0;
  }

  setWeapon(w: WeaponModel | null) {
    if (this.weapon) this.weapon.root.removeFromParent();
    this.weapon = w;
    if (w) {
      this.model.add(w.root);
      // roll marks are for close-ups (first person, the bench): a soldier's gun skips the extra draw
      w.root.traverse((o) => {
        if (o.name === 'engraving') o.visible = false;
      });
    }
  }

  /** the anim events raised since the last call (e.g. 'magOut') */
  takeEvents() {
    const e = this.anim.events;
    if (!e.length) return null;
    const out = e.slice();
    e.length = 0;
    return out;
  }

  // ---------------------------------------------------------------- per frame
  /**
   * Pose everything. `root` is the object carrying the soldier's world position / facing
   * (rotation.y = yaw + π); it must already be placed.
   */
  pose(s: AnimState, dt: number, root: THREE.Object3D, flinch?: { axis: THREE.Vector3; body: number; head: number }, legsOnly = false) {
    const k = this.anim.body(s, dt);
    const b = this.bones;
    if (legsOnly) return; // (first-person legs: the upper body is collapsed and never seen)
    // ---- arms back to rest before the IK (they are fully re-solved every frame)
    for (const n of ARM_BONES) b[n].quaternion.identity();
    root.updateMatrixWorld(true);
    // ---- aim: twist and pitch the spine towards the aim (world space)
    const yawRel = THREE.MathUtils.clamp(Math.atan2(Math.sin(s.aimYaw - s.yaw), Math.cos(s.aimYaw - s.yaw)), k.prone > 0.5 ? -0.7 : -1.4, k.prone > 0.5 ? 0.7 : 1.4);
    const R = vR.set(Math.cos(s.aimYaw), 0, -Math.sin(s.aimYaw));
    this.anim.upper(s, k, this.resetUp());
    const up = this.up;
    const twist = yawRel + up.spineTwist;
    const pitch = s.aimPitch * (1 - k.ladder);
    // one combined world rotation per spine bone (yaw about up, then pitch about the aim's right)
    const spineQ = _q4.setFromAxisAngle(UPV, twist / 3).multiply(_q5.setFromAxisAngle(R, -pitch / 3));
    for (const n of SPINE) rotateBoneWorldQ(b[n], spineQ);
    if (flinch && Math.abs(flinch.body) > 1e-3) {
      rotateBoneWorld(b.Spine1, flinch.axis, flinch.body * 0.12);
      rotateBoneWorld(b.Spine2, flinch.axis, flinch.body * 0.16);
    }
    rotateBoneWorld(b.Head, R, -pitch * 0.3);
    // stim jab: a shudder runs through the upper body
    if (up.flinch > 0.01) {
      const sh = Math.sin(this.anim.time * 62) * up.flinch;
      rotateBoneWorld(b.Spine2, R, 0.09 * sh);
      rotateBoneWorld(b.Head, R, -0.12 * sh);
    }
    // cheek weld: the head cants onto the stock when aiming a long gun
    if (!s.pistol) rotateBoneWorld(b.Head, vT3.set(-Math.sin(s.aimYaw), 0, -Math.cos(s.aimYaw)), 0.16 * k.ready * (1 - k.sprint));
    if (flinch && Math.abs(flinch.head) > 1e-3) rotateBoneWorld(b.Head, flinch.axis, flinch.head * 0.08);
    // ---- weapon placement (world), then into model space
    const w = this.weapon;
    const chest = b.Spine2.getWorldPosition(vChest);
    const cp = Math.cos(s.aimPitch);
    const A = vA.set(-Math.sin(s.aimYaw) * cp, Math.sin(s.aimPitch), -Math.cos(s.aimYaw) * cp);
    const U = vU.crossVectors(R, A).normalize();
    if (w) {
      const g = w.root;
      // base hold: the sight sits in front of the right eye (shouldered rifle / pistol at arm's
      // length) whatever the gun's proportions; the reach comes from the grip, not the sight (a
      // shotgun's sight is its front bead). Holds and actions then rotate the gun about the firing
      // hand — a low ready or a canted reload pivots in the grip, as it does in a real hand.
      _m.makeBasis(R, U, vT1.copy(A).negate());
      const q0 = gQ0.setFromRotationMatrix(_m);
      const eye = b.Head.getWorldPosition(vT2).addScaledVector(U, 0.085).addScaledVector(A, 0.06).addScaledVector(R, s.pistol ? 0 : 0.055);
      const sight = w.sockets.sight, grip = w.sockets.rightHand;
      const gp = vGP.copy(eye).addScaledVector(A, s.pistol ? 0.42 : 0.2).addScaledVector(U, -0.015);
      if (sight) gp.sub(vT1.copy(sight.position).applyQuaternion(q0));
      if (grip) {
        const gA = vT1.copy(grip.position).applyQuaternion(q0).add(gp).sub(eye).dot(A);
        gp.addScaledVector(A, (s.pistol ? 0.4 : 0.06) - gA);
      }
      const gq = gQ.copy(q0).multiply(_q2.setFromEuler(_eu.set(up.gunRot.x, up.gunRot.y, up.gunRot.z, 'YXZ')));
      if (grip) {
        // pivot about the grip
        const hp = vT1.copy(grip.position);
        gp.add(hp.clone().applyQuaternion(q0)).sub(hp.applyQuaternion(gq));
      }
      gp.addScaledVector(R, up.gunPos.x).addScaledVector(U, up.gunPos.y).addScaledVector(A, up.gunPos.z);
      // slung across the back (ladders, dives)
      if (up.slung > 0.01) {
        const sq = b.Spine2.getWorldQuaternion(_q3);
        const back = vT1.set(0.04, -0.02, -0.22).applyQuaternion(sq).add(chest);
        gp.lerp(back, up.slung);
        gq.slerp(sq.multiply(_q2.setFromEuler(_eu.set(-0.2, Math.PI, 0.9))), up.slung);
      }
      // (guard: never let a bad frame park the gun at infinity)
      if (!Number.isFinite(gp.x + gp.y + gp.z + gq.x + gq.y + gq.z + gq.w)) {
        gp.copy(chest).addScaledVector(A, 0.3);
        gq.copy(q0);
      }
      // world → model space
      _m.compose(gp, gq, vT1.set(1, 1, 1));
      _m2.copy(this.model.matrixWorld).invert().multiply(_m);
      _m2.decompose(g.position, g.quaternion, vT1);
      g.updateMatrixWorld(true);
    }
    // ---- arm IK
    for (const side of SIDES) {
      const sock = w?.sockets[side === 'Left' ? 'leftHand' : 'rightHand'];
      const gripW = sock ? sock.getWorldPosition(vGrip) : this.model.localToWorld(vGrip.set(side === 'Left' ? 0.2 : -0.2, 0.95, 0.1));
      const target = vTgt.copy(gripW);
      // reload / bolt paths blend the hand between anchors
      if (side === 'Left' && up.leftReload > 0 && w) {
        const [pa, pb, t] = up.leftPhase;
        this.anchor(pa, gripW, vT1);
        this.anchor(pb, gripW, vT2);
        target.lerpVectors(vT1, vT2, t);
      }
      if (side === 'Right' && up.rightBolt > 0 && w) {
        const ej = (w.sockets.eject ?? w.sockets.rightHand).getWorldPosition(vT1);
        ej.addScaledVector(R, 0.05).addScaledVector(A, -0.08 * up.boltBack);
        target.lerp(ej, up.rightBolt);
      }
      const free = side === 'Left' ? up.leftFree : up.rightFree;
      if (free > 0.001) target.lerp(this.model.localToWorld(vT1.copy(side === 'Left' ? up.leftTarget : up.rightTarget)), free);
      const pole = vPole.copy(R).multiplyScalar(side === 'Right' ? 0.7 : -0.8);
      pole.y -= 1;
      solveTwoBone(b[`${side}Arm`], b[`${side}ForeArm`], b[`${side}Hand`], target, pole);
      // hand orientation from the grip socket's frame (fingers = -Z, palm towards the grip = -Y)
      if (sock && free < 0.5 && !(side === 'Left' && up.leftReload > 0.5)) orientHand(b[`${side}Hand`], sock, side === 'Left' ? 1 : -1, this.model);
      // fingers curl round the grip
      const curl = (free > 0.5 ? 0.35 : 1.35) * (side === 'Left' ? -1 : 1);
      b[`${side}HandIndex1`].quaternion.setFromAxisAngle(ZV, curl);
      b[`${side}HandThumb1`].quaternion.setFromAxisAngle(XV, -0.6);
    }
    this.placeHeld(s, up);
  }

  // ---------------------------------------------------------------- held equipment
  private held: THREE.Group | null = null;
  private heldCode = -1;
  private heldT = 0;
  /**
   * The grenade / charge / injector / clacker in a hand while an equipment action runs (read off
   * the action and its progress, so remote players show it too): placed past the palm along the
   * fingers. A cooking frag spits a spark.
   */
  private placeHeld(s: AnimState, up: UpperOut) {
    const code = s.item & 31;
    const a = s.action, t = s.actionT;
    let side: 'Left' | 'Right' | null = null;
    if (code) {
      if (a === 'throw') side = t > 0.08 && t < 0.6 ? 'Right' : null;
      else if (a === 'throwL') side = t > 0.1 && t < 0.6 ? 'Left' : null;
      else if (a === 'stim') side = t > 0.08 && t < 0.72 ? 'Left' : null;
      else if (a === 'detonate') side = 'Left';
      else if (a === 'place') side = t > 0.12 && t < 0.62 ? 'Right' : null;
      else if (a === 'plant') side = t > 0.1 && t < 0.6 ? 'Left' : null;
      else if (a === 'none' && code === 12) side = 'Left';
    }
    if (!side || this.lod > 1) {
      if (this.held) this.held.visible = false;
      return;
    }
    if (code !== this.heldCode || !this.held) {
      if (this.held) this.model.remove(this.held);
      this.held = heldProp(code);
      this.heldCode = code;
      if (!this.held) return;
      this.model.add(this.held);
    }
    const g = this.held;
    g.visible = true;
    const b = this.bones;
    const hand = b[`${side}Hand`].getWorldPosition(vT1);
    const fore = b[`${side}ForeArm`].getWorldPosition(vT2);
    const dir = vT3.copy(hand).sub(fore).normalize();
    const at = hand.addScaledVector(dir, 0.075);
    // world → model space, item up along the fingers
    this.model.worldToLocal(at);
    g.position.copy(at);
    const mq = this.model.getWorldQuaternion(_q3).invert();
    g.quaternion.setFromUnitVectors(UPV, dir.applyQuaternion(mq));
    this.heldT += 1 / 60;
    const spark = g.getObjectByName('spark');
    if (spark) {
      spark.visible = !!(s.item & 32);
      if (spark.visible) spark.scale.setScalar(0.7 + 0.6 * Math.abs(Math.sin(this.heldT * 41)));
    }
    const led = g.getObjectByName('led');
    if (led) led.visible = Math.sin(this.heldT * 9) > 0.4 || a === 'detonate';
    void up;
  }

  /** reload anchor points (world) */
  private anchor(name: string, grip: THREE.Vector3, out: THREE.Vector3) {
    const w = this.weapon!;
    if (name === 'well') return (w.sockets.magWell ?? w.sockets.leftHand).getWorldPosition(out).add(vT3.set(0, -0.05, 0));
    if (name === 'port') return (w.sockets.loadPort ?? w.sockets.eject ?? w.sockets.leftHand).getWorldPosition(out);
    if (name === 'pouch') return this.model.localToWorld(out.copy(this.pouchL));
    return out.copy(grip);
  }

  private resetUp() {
    const u = this.up;
    u.spineTwist = 0;
    u.leftReload = 0;
    u.leftPhase = ['grip', 'grip', 0];
    u.rightBolt = 0;
    u.boltBack = 0;
    return u;
  }
}

// ------------------------------------------------------------------ IK helpers

const _h1 = new THREE.Vector3(), _h2 = new THREE.Vector3(), _h3 = new THREE.Vector3(), _h4 = new THREE.Vector3();
// World matrices are refreshed lazily: getWorldPosition / getWorldQuaternion walk up and update
// the parent chain on demand, and the render pass updates the whole scene once per frame — so a
// rotation only touches its own local transform instead of re-deriving the subtree (arms, head,
// gun) every time.
export function rotateBoneWorld(bone: THREE.Object3D, axisWorld: THREE.Vector3, angle: number) {
  if (Math.abs(angle) < 1e-5) return;
  rotateBoneWorldQ(bone, _q6.setFromAxisAngle(_h4.copy(axisWorld).normalize(), angle));
}
export function rotateBoneWorldQ(bone: THREE.Object3D, delta: THREE.Quaternion) {
  const parent = bone.parent!;
  parent.getWorldQuaternion(_q3);
  bone.getWorldQuaternion(_q2);
  _q.copy(delta).multiply(_q2);
  bone.quaternion.copy(_q3.invert().multiply(_q));
  bone.updateMatrix();
  bone.matrixWorldNeedsUpdate = true;
}

function aimBone(bone: THREE.Object3D, child: THREE.Object3D, target: THREE.Vector3) {
  const bp = bone.getWorldPosition(_h1);
  const cur = child.getWorldPosition(_h2).sub(bp).normalize();
  const want = _h3.copy(target).sub(bp).normalize();
  const delta = _q.setFromUnitVectors(cur, want);
  bone.parent!.getWorldQuaternion(_q3);
  bone.getWorldQuaternion(_q2);
  bone.quaternion.copy(_q3.invert().multiply(delta.multiply(_q2)));
  bone.updateMatrix();
}

const _s = new THREE.Vector3(), _el = new THREE.Vector3(), _hd = new THREE.Vector3(), _dir = new THREE.Vector3(), _perp = new THREE.Vector3(), _tgt = new THREE.Vector3();
export function solveTwoBone(upper: THREE.Object3D, fore: THREE.Object3D, hand: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3) {
  const s = upper.getWorldPosition(_s);
  const e = fore.getWorldPosition(_el);
  const h = hand.getWorldPosition(_hd);
  const a = s.distanceTo(e), b = e.distanceTo(h);
  const dir = _dir.copy(target).sub(s);
  let d = dir.length();
  dir.divideScalar(Math.max(d, 1e-5));
  d = Math.min(d, (a + b) * 0.999);
  const cosA = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d)));
  const sinA = Math.sqrt(1 - cosA * cosA);
  const perp = _perp.copy(pole).addScaledVector(dir, -pole.dot(dir)).normalize();
  const elbow = _tgt.copy(s).addScaledVector(dir, a * cosA).addScaledVector(perp, a * sinA);
  const sx = s.x, sy = s.y, sz = s.z;
  aimBone(upper, fore, elbow);
  aimBone(fore, hand, _tgt.set(sx, sy, sz).addScaledVector(dir, d));
}

/** turn the hand so its fingers / palm match the grip socket */
const _f0 = new THREE.Vector3(), _n0 = new THREE.Vector3(), _f = new THREE.Vector3(), _n = new THREE.Vector3(), _x = new THREE.Vector3();
const _M0 = new THREE.Matrix4(), _M = new THREE.Matrix4(), _sq = new THREE.Quaternion(), _mq = new THREE.Quaternion();
function orientHand(hand: THREE.Bone, sock: THREE.Object3D, side: 1 | -1, model: THREE.Object3D) {
  sock.getWorldQuaternion(_sq);
  _f.set(0, 0, -1).applyQuaternion(_sq);
  _n.set(0, -1, 0).applyQuaternion(_sq);
  // rest hand (model space): fingers down, palm facing the body's centre line
  model.getWorldQuaternion(_mq);
  _f0.set(0, -1, 0).applyQuaternion(_mq);
  _n0.set(-side, 0, 0).applyQuaternion(_mq);
  _M0.makeBasis(_f0, _n0, _x.crossVectors(_f0, _n0));
  _n.addScaledVector(_f, -_n.dot(_f)).normalize();
  _M.makeBasis(_f, _n, _x.crossVectors(_f, _n).normalize());
  _M.multiply(_M0.transpose());
  const world = _q.setFromRotationMatrix(_M).multiply(_mq);
  hand.parent!.getWorldQuaternion(_q3);
  hand.quaternion.copy(_q3.invert().multiply(world));
  hand.updateMatrix();
}
