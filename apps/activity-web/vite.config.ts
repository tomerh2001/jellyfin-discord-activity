import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@app/shared/protocol": path.resolve(currentDir, "../../packages/shared/src/protocol.ts"),
      "@app/shared": path.resolve(currentDir, "../../packages/shared/src/index.ts")
    }
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/health": "http://localhost:3000",
      "/media": "http://localhost:3000",
      "/ws": {
        target: "ws://localhost:3000",
        ws: true
      }
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          hls: ["hls.js"]
        }
      }
    }
  },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"]
  }
});
