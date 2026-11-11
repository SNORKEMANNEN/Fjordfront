/// <reference lib="webworker" />
// Terrain height rows computed off the main thread (pure map functions, no DOM / WebGL).
import { terrainHeight } from './MapLayout';

self.onmessage = (e: MessageEvent<{ ax: number[]; j0: number; j1: number }>) => {
  const { ax, j0, j1 } = e.data;
  const n = ax.length;
  const out = new Float32Array((j1 - j0) * n);
  for (let j = j0; j < j1; j++) {
    const z = ax[j];
    for (let i = 0; i < n; i++) out[(j - j0) * n + i] = terrainHeight(ax[i], z);
  }
  (self as unknown as Worker).postMessage({ j0, out }, [out.buffer]);
};
