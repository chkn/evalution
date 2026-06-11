// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Alexander Corrado

import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: "src/client",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    open: true,
    proxy: {
      // Interactive-terminal WebSocket; must precede the generic /api/ rule and
      // opt into ws so the upgrade handshake is forwarded to the API server.
      "/api/terminal": {
        target: "ws://localhost:3000",
        ws: true,
      },
      "^/api/": {
        target: "http://localhost:3000",
        changeOrigin: true,
        configure: proxy => {
          proxy.on("proxyRes", (proxyRes, _req, res) => {
            proxyRes.on("close", () => {
              if (!res.writableEnded) {
                res.destroy();
              }
            });
          });
        },
      },
    },
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "./src/shared"),
    },
  },
});
