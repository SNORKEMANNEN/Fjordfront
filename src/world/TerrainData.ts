import { terrainHeight, TERRAIN_EXTENT } from './MapLayout';

export const INNER = 205; // half-size of the dense, collidable region
export const STEP = 1.25;

export function axisCoords(): number[] {
  const pos: number[] = [];
  for (let x = 0; x <= INNER + 1e-6; x += STEP) pos.push(x);
  let s = STEP;
  let x = pos[pos.length - 1];
  // grow the spacing away from the play area, but cap it so distant massifs keep their shape
  while (x < TERRAIN_EXTENT) {
    s = Math.min(s * 1.05, 24);
    x += s;
    pos.push(Math.min(x, TERRAIN_EXTENT));
  }
  const neg = pos.slice(1).map((v) => -v).reverse();
  return neg.concat(pos);
}

/**
 * The terrain height field (n×n over axisCoords) is the single biggest piece of CPU work at load.
 * It is computed in parallel Web Workers, started at the very beginning of boot so it overlaps
 * renderer / physics start-up and asset fetches, and cached in IndexedDB keyed by a fingerprint of
 * the map functions (a map change produces different sample heights → a new key), so a repeat
 * visit skips it entirely. Any failure falls back to computing it on the main thread.
 */
let pending: Promise<Float32Array> | null = null;

function fingerprint(ax: number[]) {
  let h = 2166136261 >>> 0;
  const mix = (v: number) => {
    const f = new Float32Array([v]);
    const u = new Uint32Array(f.buffer)[0];
    h = Math.imul(h ^ u, 16777619) >>> 0;
  };
  mix(ax.length);
  for (let k = 0; k < 48; k++) {
    const x = Math.sin(k * 12.9898) * 230, z = Math.cos(k * 78.233) * 230;
    mix(terrainHeight(x, z));
  }
  mix(terrainHeight(ax[3], ax[ax.length - 4]));
  return 'terrain-v1-' + h.toString(36);
}

function idb(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try {
      const r = indexedDB.open('fjordfront-cache', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('blobs');
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
      r.onblocked = () => res(null);
    } catch {
      res(null);
    }
  });
}
async function cacheGet(key: string): Promise<Float32Array | null> {
  const db = await idb();
  if (!db) return null;
  return new Promise((res) => {
    try {
      const q = db.transaction('blobs', 'readonly').objectStore('blobs').get(key);
      q.onsuccess = () => res(q.result instanceof Float32Array ? q.result : null);
      q.onerror = () => res(null);
    } catch {
      res(null);
    }
  });
}
async function cachePut(key: string, data: Float32Array) {
  const db = await idb();
  if (!db) return;
  try {
    const tx = db.transaction('blobs', 'readwrite');
    const st = tx.objectStore('blobs');
    // one terrain entry: drop stale ones from older map versions
    const keys = st.getAllKeys();
    keys.onsuccess = () => {
      for (const k of keys.result) if (String(k).startsWith('terrain-') && k !== key) st.delete(k);
      st.put(data, key);
    };
  } catch {
    /* storage full / private mode: no cache */
  }
}

function computeMain(ax: number[]) {
  const n = ax.length;
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out[j * n + i] = terrainHeight(ax[i], ax[j]);
  return out;
}

async function computeWorkers(ax: number[]): Promise<Float32Array> {
  const n = ax.length;
  const threads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
  const out = new Float32Array(n * n);
  const rows = Math.ceil(n / threads);
  await Promise.all(Array.from({ length: threads }, (_, t) => new Promise<void>((resolve, reject) => {
    const j0 = t * rows, j1 = Math.min(n, j0 + rows);
    if (j0 >= j1) return resolve();
    const w = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ j0: number; out: Float32Array }>) => {
      out.set(e.data.out, e.data.j0 * n);
      w.terminate();
      resolve();
    };
    w.onerror = (e) => {
      w.terminate();
      reject(e);
    };
    w.postMessage({ ax, j0, j1 });
  })));
  return out;
}

export const terrainStats = { source: '', ms: 0 };

/** Start (or join) the height-field computation. */
export function startTerrainHeights(): Promise<Float32Array> {
  if (pending) return pending;
  pending = (async () => {
    const t0 = performance.now();
    const ax = axisCoords();
    const key = fingerprint(ax);
    const nocache = typeof location !== 'undefined' && location.search.includes('nocache');
    const hit = nocache ? null : await cacheGet(key);
    if (hit && hit.length === ax.length * ax.length) {
      terrainStats.source = 'cache';
      terrainStats.ms = performance.now() - t0;
      return hit;
    }
    let data: Float32Array;
    try {
      data = await computeWorkers(ax);
      terrainStats.source = 'workers';
    } catch (e) {
      console.warn('[terrain] workers unavailable, computing on the main thread', e);
      data = computeMain(ax);
      terrainStats.source = 'main';
    }
    terrainStats.ms = performance.now() - t0;
    if (!nocache) void cachePut(key, data);
    return data;
  })();
  return pending;
}
