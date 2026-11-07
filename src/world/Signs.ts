import * as THREE from 'three';

/**
 * Canvas-drawn sign faces (no image assets): the green emergency-exit signs in the tunnel, the
 * ladder sign in the galleries and the blue tunnel name boards over the portals.
 * Exit signs are unlit and brighter than white so they read in the dark and catch the bloom.
 */
function canvas(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) {
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  const c = el.getContext('2d')!;
  draw(c);
  const t = new THREE.CanvasTexture(el);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** ISO-style running figure heading for a doorway, white on the current fill. */
function runner(c: CanvasRenderingContext2D, x: number, y: number, s: number, flip = false) {
  c.save();
  c.translate(x, y);
  if (flip) c.scale(-1, 1);
  c.scale(s, s);
  c.strokeStyle = '#fff';
  c.fillStyle = '#fff';
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.lineWidth = 9;
  // head
  c.beginPath();
  c.arc(12, -44, 8, 0, Math.PI * 2);
  c.fill();
  // torso leaning into the run
  c.beginPath();
  c.moveTo(6, -32);
  c.lineTo(-4, -6);
  c.stroke();
  // arms
  c.beginPath();
  c.moveTo(-14, -16);
  c.lineTo(-2, -28);
  c.lineTo(18, -22);
  c.lineTo(26, -10);
  c.stroke();
  // legs
  c.beginPath();
  c.moveTo(-26, 22);
  c.lineTo(-14, 6);
  c.lineTo(-4, -6);
  c.lineTo(12, 8);
  c.lineTo(10, 30);
  c.stroke();
  c.restore();
}

function doorway(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  c.strokeStyle = '#fff';
  c.lineWidth = 7;
  c.strokeRect(x, y, w, h);
}

function arrow(c: CanvasRenderingContext2D, x: number, y: number, s: number, dir: 'right' | 'left' | 'up') {
  c.save();
  c.translate(x, y);
  c.rotate(dir === 'right' ? 0 : dir === 'left' ? Math.PI : -Math.PI / 2);
  c.scale(s, s);
  c.fillStyle = '#fff';
  c.beginPath();
  c.moveTo(-26, -8);
  c.lineTo(4, -8);
  c.lineTo(4, -22);
  c.lineTo(28, 0);
  c.lineTo(4, 22);
  c.lineTo(4, 8);
  c.lineTo(-26, 8);
  c.closePath();
  c.fill();
  c.restore();
}

const GREEN = '#0b8a43';

export function signMaterials(): Record<string, THREE.Material> {
  // wall sign over the door: figure into the doorway + NØDUTGANG / EXIT
  const exit = canvas(512, 176, (c) => {
    c.fillStyle = GREEN;
    c.fillRect(0, 0, 512, 176);
    c.strokeStyle = 'rgba(255,255,255,0.9)';
    c.lineWidth = 6;
    c.strokeRect(6, 6, 500, 164);
    doorway(c, 26, 26, 74, 124);
    runner(c, 70, 112, 1.25);
    c.fillStyle = '#fff';
    c.font = 'bold 66px Barlow Condensed, Arial Narrow, Arial, sans-serif';
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.fillText('NØDUTGANG', 128, 64);
    c.font = 'bold 50px Barlow Condensed, Arial Narrow, Arial, sans-serif';
    c.fillText('EXIT', 128, 128);
    arrow(c, 452, 128, 1.15, 'right');
  });
  // blade sign sticking out from the wall (seen down the tunnel)
  const blade = canvas(256, 256, (c) => {
    c.fillStyle = GREEN;
    c.fillRect(0, 0, 256, 256);
    c.strokeStyle = 'rgba(255,255,255,0.9)';
    c.lineWidth = 8;
    c.strokeRect(8, 8, 240, 240);
    doorway(c, 140, 40, 76, 132);
    runner(c, 98, 136, 1.5);
    c.fillStyle = '#fff';
    c.font = 'bold 50px Barlow Condensed, Arial Narrow, Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('EXIT', 128, 214);
  });
  // gallery: the way up
  const up = canvas(256, 256, (c) => {
    c.fillStyle = GREEN;
    c.fillRect(0, 0, 256, 256);
    c.strokeStyle = 'rgba(255,255,255,0.9)';
    c.lineWidth = 8;
    c.strokeRect(8, 8, 240, 240);
    arrow(c, 128, 92, 2.1, 'up');
    c.fillStyle = '#fff';
    c.font = 'bold 54px Barlow Condensed, Arial Narrow, Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('UT · EXIT', 128, 200);
  });
  // portal name board
  const name = canvas(1024, 192, (c) => {
    c.fillStyle = '#1f4a9a';
    c.fillRect(0, 0, 1024, 192);
    c.strokeStyle = '#fff';
    c.lineWidth = 10;
    c.strokeRect(12, 12, 1000, 168);
    c.fillStyle = '#fff';
    c.font = 'bold 92px Barlow Condensed, Arial Narrow, Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('KVITVIKTUNNELEN', 470, 98);
    c.font = 'bold 64px Barlow Condensed, Arial Narrow, Arial, sans-serif';
    c.fillText('37 m', 880, 100);
  });
  const lit = (map: THREE.Texture, k = 1.7) => new THREE.MeshBasicMaterial({ map, color: new THREE.Color(k, k, k), toneMapped: false, side: THREE.DoubleSide });
  return {
    signExit: lit(exit),
    signExitBlade: lit(blade),
    signExitUp: lit(up),
    signTunnel: new THREE.MeshStandardMaterial({ map: name, roughness: 0.45, emissive: 0xffffff, emissiveMap: name, emissiveIntensity: 0.12 }),
    exitGreen: new THREE.MeshStandardMaterial({ color: 0x1d7a45, roughness: 0.5, metalness: 0.3, envMapIntensity: 0.25 }),
    // underground: almost no sky in the reflections
    cladding: new THREE.MeshStandardMaterial({ color: 0xd8d6cc, roughness: 0.6, metalness: 0.0, envMapIntensity: 0.1 }),
    exitLamp: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 3.2, 1.2), toneMapped: false }),
  };
}
