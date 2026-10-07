import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@desktop-agent/contracts/application/operations': fileURLToPath(new URL('../../packages/contracts/src/application/operations.ts', import.meta.url)),
      '@desktop-agent/contracts/application': fileURLToPath(new URL('../../packages/contracts/src/application/index.ts', import.meta.url)),
      '@desktop-agent/contracts/build-compatibility': fileURLToPath(new URL('../../packages/contracts/src/build-compatibility.ts', import.meta.url)),
      '@desktop-agent/contracts/capability-manifest': fileURLToPath(new URL('../../packages/contracts/src/capability-manifest.ts', import.meta.url)),
      '@desktop-agent/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url))
    }
  },
  optimizeDeps: {
    exclude: ['@desktop-agent/contracts']
  }
});
