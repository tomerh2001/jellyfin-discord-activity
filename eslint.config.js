import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "**/dist/**", "node_modules/**", "**/node_modules/**", "coverage/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        AbortSignal: "readonly",
        console: "readonly",
        document: "readonly",
        fetch: "readonly",
        process: "readonly",
        Response: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
        WebSocket: "readonly",
        window: "readonly"
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "*.config.ts",
            "apps/api/vitest.config.ts",
            "packages/shared/vitest.config.ts"
          ]
        },
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }
      ]
    }
  }
);
