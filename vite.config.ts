import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: 'src/client',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    open: true,
    proxy: {
      // Interactive-terminal WebSocket; must precede the generic /api/ rule and
      // opt into ws so the upgrade handshake is forwarded to the API server.
      '/api/terminal': {
        target: 'ws://localhost:3000',
        ws: true,
      },
      '^/api/': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        configure: (proxy, options) => {
          proxy.on('proxyRes', (proxyRes, req, res) => {
            proxyRes.on('close', () => {
              if (!res.writableEnded) {
                res.destroy();
              }
            });
          });
        },
      }
    },
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './src/shared'),
    },
  },
});
