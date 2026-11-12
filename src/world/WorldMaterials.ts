import * as THREE from 'three';
import { MaterialLib } from '../render/Materials';

/** All static world materials, keyed by the names used in the generators. */
export function makeWorldMaterials(L: MaterialLib): Record<string, THREE.Material> {
  const int = 0.45; // interiors receive less sky light
  const m: Record<string, THREE.Material> = {
    red: L.std('red', { tile: 2.4 }),
    white: L.std('white', { tile: 2.4 }),
    ochre: L.std('ochre', { tile: 2.4 }),
    dkgrey: L.std('dkgrey', { tile: 2.4 }),
    trim: L.std('white', { tile: 1.2, color: 0xf4f2ea, normalScale: 0.4 }, 'trim'),
    wallInt: L.std('white', { tile: 2.4, color: 0xe8e2d2, envMapIntensity: int, normalScale: 0.5 }, 'wallInt'),
    floorInt: L.std('planks', { tile: 2, color: 0xd8c0a0, envMapIntensity: int }, 'floorInt'),
    stone: L.std('stoneWall', { tile: 3 }),
    concrete: L.std('concrete', { tile: 4 }),
    concreteWhite: L.std('concrete', { tile: 4, color: 0xe6e2da }, 'concreteWhite'),
    chimney: L.std('concrete', { tile: 2, color: 0x6a5a52 }, 'chimney'),
    roof: L.std('roofTiles', { tile: 2 }),
    roofMetal: L.std('corrugated', { tile: 2, color: 0x34383a, metalness: 0.4 }, 'roofMetal'),
    door: L.std('white', { tile: 2.4, color: 0x3d5f6e }, 'door'),
    woodRaw: L.std('planks', { tile: 2, color: 0x9a8c7a }, 'woodRaw'),
    planks: L.std('planks', { tile: 2 }),
    wood: L.std('planks', { tile: 1.5, color: 0xb08a62, envMapIntensity: int }, 'furnWood'),
    fabric: L.std('camoFabric', { tile: 0.8, color: 0x8a96a8, envMapIntensity: int }, 'fabricInt'),
    crate: L.std('planks', { tile: 1.2, color: 0xc9a46a }, 'crate'),
    pallet: L.std('planks', { tile: 1.0, color: 0xa88a62 }, 'pallet'),
    steel: L.std('paintedMetal', { tile: 2, color: 0x5a6066, metalness: 0.55 }, 'steel'),
    steelGrate: L.std('corrugated', { tile: 0.5, color: 0x4a4e52, metalness: 0.6 }, 'grate'),
    yellowSteel: L.std('paintedMetal', { tile: 2, color: 0xd9a21c, metalness: 0.3 }, 'yellowSteel'),
    redSteel: L.std('paintedMetal', { tile: 2, color: 0xb02a20, metalness: 0.3 }, 'redSteel'),
    rust: L.std('paintedMetal', { tile: 2, color: 0x6e4a34, metalness: 0.5 }, 'rust'),
    corrBlue: L.std('corrugated', { tile: 2, color: 0x2e5a7e, metalness: 0.35 }, 'corrBlue'),
    corrWhite: L.std('corrugated', { tile: 2, color: 0xc4c8c8, metalness: 0.35 }, 'corrWhite'),
    corrInner: L.std('corrugated', { tile: 2, color: 0x8a8e90, metalness: 0.3, envMapIntensity: int }, 'corrInner'),
    contRed: L.std('corrugated', { tile: 2.6, color: 0x8e2b20, metalness: 0.3 }, 'contRed'),
    contBlue: L.std('corrugated', { tile: 2.6, color: 0x1f4f86, metalness: 0.3 }, 'contBlue'),
    contGreen: L.std('corrugated', { tile: 2.6, color: 0x2f5f3a, metalness: 0.3 }, 'contGreen'),
    contOrange: L.std('corrugated', { tile: 2.6, color: 0xc2661e, metalness: 0.3 }, 'contOrange'),
    contGrey: L.std('corrugated', { tile: 2.6, color: 0x8a8c88, metalness: 0.3 }, 'contGrey'),
    contWhite: L.std('corrugated', { tile: 2.6, color: 0xd2d2cc, metalness: 0.3 }, 'contWhite'),
    tankWhite: L.std('paintedMetal', { tile: 3, color: 0xdedcd4, metalness: 0.3 }, 'tankWhite'),
    hay: L.std('grass', { tile: 0.6, color: 0xe0c070 }, 'hay'),
    wrap: L.plain('wrap', { color: 0xe8e8e2, roughness: 0.35, metalness: 0 }),
    sandbag: L.std('camoFabric', { tile: 0.6, color: 0xb0a080 }, 'sandbag'),
    fish: L.std('bark', { tile: 0.3, color: 0xb8a890 }, 'fish'),
    boatWhite: L.std('white', { tile: 1.5, side: THREE.DoubleSide }, 'boatWhite'),
    boatRed: L.std('red', { tile: 1.5, side: THREE.DoubleSide }, 'boatRed'),
    asphalt: L.std('asphalt', { tile: 6 }),
    gravelRoad: L.std('gravel', { tile: 3, color: 0xb0aaa0 }, 'gravelRoad'),
    dirtRoad: L.std('forest', { tile: 3, color: 0xa08a70 }, 'dirtRoad'),
    bark: L.std('bark', { tile: 2 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x2a3a42, roughness: 0.03, metalness: 0.1, transparent: true, opacity: 0.45, envMapIntensity: 1.6, depthWrite: false }),
    lineWhite: new THREE.MeshStandardMaterial({ color: 0xe8e8e0, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2 }),
    lineYellow: new THREE.MeshStandardMaterial({ color: 0xd8a830, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2 }),
    snowPole: new THREE.MeshStandardMaterial({ color: 0xe07a1a, roughness: 0.5 }),
    tunnel: L.std('rock', { tile: 4, color: 0x8a8682, envMapIntensity: 0.12 }, 'tunnel'),
    boulder: L.std('rock', { tile: 2.5, color: 0x9a968e }, 'boulder'),
    signBlue: new THREE.MeshStandardMaterial({ color: 0x1f4a9a, roughness: 0.4 }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 }),
    tail: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 0.05, 0.03) }),
    carGlass: new THREE.MeshPhysicalMaterial({ color: 0x0e1416, roughness: 0.05, metalness: 0.3, envMapIntensity: 1.8 }),
    carBurnt: L.std('paintedMetal', { tile: 1.5, color: 0x2a2420, metalness: 0.6 }, 'carBurnt'),
    carRed: new THREE.MeshPhysicalMaterial({ color: 0x7a1410, roughness: 0.35, metalness: 0.5, clearcoat: 0.8, clearcoatRoughness: 0.1 }),
    carBlue: new THREE.MeshPhysicalMaterial({ color: 0x1a2c4a, roughness: 0.35, metalness: 0.5, clearcoat: 0.8, clearcoatRoughness: 0.1 }),
    carWhite: new THREE.MeshPhysicalMaterial({ color: 0xc8c8c4, roughness: 0.35, metalness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.1 }),
    carGrey: new THREE.MeshPhysicalMaterial({ color: 0x55585a, roughness: 0.35, metalness: 0.6, clearcoat: 0.8, clearcoatRoughness: 0.1 }),
    carGreen: new THREE.MeshPhysicalMaterial({ color: 0x24382a, roughness: 0.35, metalness: 0.5, clearcoat: 0.8, clearcoatRoughness: 0.1 }),
    carBlack: new THREE.MeshPhysicalMaterial({ color: 0x0c0c0e, roughness: 0.3, metalness: 0.6, clearcoat: 0.9, clearcoatRoughness: 0.08 }),
    rug: L.std('camoFabric', { tile: 0.35, color: 0xb04030 }, 'rug'),
    books: L.std('planks', { tile: 0.5, color: 0x4a6a5a, envMapIntensity: int }, 'books'),
    frame: L.std('planks', { tile: 0.5, color: 0x6a4a30, envMapIntensity: int }, 'frame'),
    art1: new THREE.MeshStandardMaterial({ color: 0x5a7a8a, roughness: 0.6, envMapIntensity: 0.3 }),
    art2: new THREE.MeshStandardMaterial({ color: 0xb08a50, roughness: 0.6, envMapIntensity: 0.3 }),
    ceramic: new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.25, envMapIntensity: 0.5 }),
    pot: new THREE.MeshStandardMaterial({ color: 0xa0583a, roughness: 0.8 }),
    plant: new THREE.MeshStandardMaterial({ color: 0x3a5a2a, roughness: 0.9, flatShading: true }),
    lampShade: new THREE.MeshStandardMaterial({ color: 0xf0e6d0, roughness: 0.7, side: THREE.DoubleSide, emissive: 0x4a3018, emissiveIntensity: 0.6 }),
    bulb: new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 3.6, 2.0), toneMapped: false }),
    bulbCool: new THREE.MeshBasicMaterial({ color: new THREE.Color(4.5, 4.8, 5), toneMapped: false }),
    net: L.std('camoFabric', { tile: 0.2, color: 0x2e4a3a }, 'net'),
    buoy: new THREE.MeshStandardMaterial({ color: 0xe05a1a, roughness: 0.4 }),
    fishCrate: new THREE.MeshStandardMaterial({ color: 0x2a5aa0, roughness: 0.5 }),
    fishCrateRed: new THREE.MeshStandardMaterial({ color: 0xa03028, roughness: 0.5 }),
    rope: L.std('planks', { tile: 0.2, color: 0xb09a70 }, 'rope'),
    lamp: new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 3, 1.8), toneMapped: false }),
    sodium: new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 2.6, 0.7), toneMapped: false }),
    // ---- Brosund (Update 34): Jugendstil stucco palette, slate and green copper, granite, iron ----
    j_ochre: L.std('concrete', { tile: 3, color: 0xe0a848, normalScale: 0.5 }, 'j_ochre'),
    j_salmon: L.std('concrete', { tile: 3, color: 0xe08c6c, normalScale: 0.5 }, 'j_salmon'),
    j_mint: L.std('concrete', { tile: 3, color: 0xa4dcc0, normalScale: 0.5 }, 'j_mint'),
    j_jwhite: L.std('concrete', { tile: 3, color: 0xf2efe6, normalScale: 0.5 }, 'j_jwhite'),
    j_deepred: L.std('concrete', { tile: 3, color: 0x9a2e26, normalScale: 0.5 }, 'j_deepred'),
    j_yellow: L.std('concrete', { tile: 3, color: 0xf0cc4c, normalScale: 0.5 }, 'j_yellow'),
    j_skyblue: L.std('concrete', { tile: 3, color: 0xa6c2dc, normalScale: 0.5 }, 'j_skyblue'),
    j_cream: L.std('concrete', { tile: 3, color: 0xf0e2c0, normalScale: 0.5 }, 'j_cream'),
    stucco: L.std('concrete', { tile: 2, color: 0xf6f1e4, normalScale: 0.35 }, 'stucco'),
    granite: L.std('stoneWall', { tile: 2.5, color: 0xb4b2ae }, 'granite'),
    slate: L.std('roofTiles', { tile: 1.4, color: 0x5a6068 }, 'slate'),
    copper: L.std('paintedMetal', { tile: 2, color: 0x6aae96, metalness: 0.35, roughness: 0.6 }, 'copper'),
    iron: L.std('paintedMetal', { tile: 1, color: 0x1e2224, metalness: 0.6 }, 'iron'),
    jglass: new THREE.MeshStandardMaterial({ color: 0x1c2a34, roughness: 0.08, metalness: 0.6, envMapIntensity: 1.5 }),
    jglassLit: new THREE.MeshStandardMaterial({ color: 0x1c2a34, roughness: 0.1, metalness: 0.5, envMapIntensity: 1.3, emissive: 0xffb466, emissiveIntensity: 0 }),
    sod: L.std('grass', { tile: 1.5, color: 0x9cb070 }, 'sod'),
    shotcrete: L.std('concrete', { tile: 3, color: 0x8e8c88, envMapIntensity: 0.15 }, 'shotcrete'),
    tunnelRock: L.std('rock', { tile: 3, color: 0x6c6a66, envMapIntensity: 0.12 }, 'tunnelRock'),
    hazard: hazardMat(),
    blueLight: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 1.4, 5), toneMapped: false }),
    redLamp: new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 0.3, 0.2), toneMapped: false }),
    stay: new THREE.MeshStandardMaterial({ color: 0xd8dcdc, roughness: 0.4, metalness: 0.7 }),
    wetWall: L.std('concrete', { tile: 3, color: 0x4e4c4a, roughness: 0.25, envMapIntensity: 0.3 }, 'wetWall'),
    puddle: new THREE.MeshStandardMaterial({ color: 0x0c0e10, roughness: 0.02, metalness: 0.4, envMapIntensity: 0.8, polygonOffset: true, polygonOffsetFactor: -3 }),
  };
  // weathering flags (Update 33, see Snow.ts): moss / grime / frost on metal
  const flag = (keys: string[], f: string[]) => {
    for (const k of keys) if (m[k]) m[k].userData.wx = [...((m[k].userData.wx as string[] | undefined) ?? []), ...f];
  };
  flag(['stone', 'concrete', 'concreteWhite', 'chimney', 'boulder', 'roof', 'granite', 'slate', 'shotcrete'], ['moss', 'grime']);
  flag(['j_ochre', 'j_salmon', 'j_mint', 'j_jwhite', 'j_deepred', 'j_yellow', 'j_skyblue', 'j_cream', 'stucco'], ['grime']);
  flag(['copper', 'iron', 'stay'], ['metal']);
  flag(['red', 'white', 'ochre', 'dkgrey', 'trim', 'planks', 'woodRaw', 'door', 'corrBlue', 'corrWhite', 'tankWhite', 'sandbag', 'crate', 'pallet'], ['grime']);
  flag(['roofMetal', 'steel', 'steelGrate', 'yellowSteel', 'redSteel', 'rust', 'corrBlue', 'corrWhite', 'contRed', 'contBlue', 'contGreen', 'contOrange', 'contGrey', 'contWhite', 'tankWhite', 'carBurnt',
    'carRed', 'carBlue', 'carWhite', 'carGrey', 'carGreen', 'carBlack', 'signBlue'], ['metal']);
  m.default = m.concrete;
  return m;
}

/** Yellow / black hazard stripes (the bar over the tunnel portal, kerb ends). */
function hazardMat() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 32;
  const x = c.getContext('2d')!;
  x.fillStyle = '#e8b416';
  x.fillRect(0, 0, 128, 32);
  x.fillStyle = '#141414';
  for (let i = -2; i < 10; i++) {
    x.beginPath();
    x.moveTo(i * 16, 32);
    x.lineTo(i * 16 + 8, 32);
    x.lineTo(i * 16 + 16, 0);
    x.lineTo(i * 16 + 8, 0);
    x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return new THREE.MeshStandardMaterial({ map: t, roughness: 0.6 });
}
