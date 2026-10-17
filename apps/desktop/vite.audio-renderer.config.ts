import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  base: './',
  build: { rollupOptions: { input: fileURLToPath(new URL('./audio-host.html', import.meta.url)) } }
});
