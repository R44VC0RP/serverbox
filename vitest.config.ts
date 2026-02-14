import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@serverbox/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@serverbox/sdk": fileURLToPath(new URL("./packages/sdk/src/index.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: true,
    clearMocks: true
  }
});
