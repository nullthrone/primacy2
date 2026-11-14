import { defineConfig } from 'vite';
import { auditionPlugin } from './dev/auditionPlugin.ts';

// The dev server proxies the game server so that the client can use same-origin URLs in development.
const SERVER = process.env.PRIMACY2_SERVER ?? 'http://localhost:8420';

export default defineConfig({
  base: './',
  plugins: [auditionPlugin()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: SERVER, ws: true },
      '/api': { target: SERVER },
      '/fed': { target: SERVER },
    },
  },
});
