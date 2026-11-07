import { defineConfig } from 'vite';

export default defineConfig({
  // relative base: the build works from any sub-path (GitHub Pages project sites, itch.io, a folder)
  base: './',
  server: { host: true, port: 5173 },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: { manualChunks: { three: ['three'], rapier: ['@dimforge/rapier3d-compat'] } },
    },
  },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat'] },
});
