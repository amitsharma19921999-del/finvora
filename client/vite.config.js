import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        // SSE needs unbuffered streaming through the dev proxy
        configure: (proxy) => proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('Cache-Control', 'no-cache')),
      },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
