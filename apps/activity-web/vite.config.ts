import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: {
    alias: {
      "@app/shared": path.resolve(currentDir, "../../packages/shared/src/index.ts")
    }
  },
  build: {
    lib: {
      entry: path.join(currentDir, "src/library.ts"),
      name: "JellyfinWatch",
      formats: ["iife"],
      fileName: () => "activity-session.js"
    }
  },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "jsdom"
  }
});
