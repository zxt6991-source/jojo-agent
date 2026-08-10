import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@desktop-agent/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url))
    }
  },
  optimizeDeps: {
    exclude: ['@desktop-agent/contracts']
  }
});
