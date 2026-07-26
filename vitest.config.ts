import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src`, import.meta.url));

/**
 * Source-first monorepo: every `@massingifc/*` specifier resolves straight to the package's
 * TypeScript source rather than to a built `dist/`. This keeps `vitest` runnable on a clean
 * checkout with no build step, and means a failing test points at the line you edited.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@massingifc/core-kernel": pkg("core-kernel"),
      "@massingifc/project-schema": pkg("project-schema"),
      "@massingifc/plugin-sdk": pkg("plugin-sdk"),
      "@massingifc/massing": pkg("massing"),
      "@massingifc/icdd": pkg("icdd"),
      "@massingifc/interop": pkg("interop"),
      "@massingifc/markup": pkg("markup"),
      "@massingifc/estimating-5d": pkg("estimating-5d"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
  },
});
