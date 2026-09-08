import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@app/shared": path.resolve(currentDir, "../../packages/shared/src/index.ts")
    }
  },
  test: {
    setupFiles: [path.resolve(currentDir, "src/test/setup.ts")],
    exclude: ["**/node_modules/**", "**/dist/**"]
  }
});
