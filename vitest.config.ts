// vitest.config.ts — mirrors tsconfig.json's `@/*` alias (the vendored-UI
// import convention, frontend-hooks-and-ui.md) so `vitest run` resolves it
// the same way `bb plugin build` does.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
