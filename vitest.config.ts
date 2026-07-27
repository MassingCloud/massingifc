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
      "@massingifc/planning-4d": pkg("planning-4d"),
      "@massingifc/coordination": pkg("coordination"),
      "@massingifc/federation": pkg("federation"),
      "@massingifc/family-libraries": pkg("family-libraries"),
      "@massingifc/digital-twin": pkg("digital-twin"),
      "@massingifc/procurement-field": pkg("procurement-field"),
      "@massingifc/analytics": pkg("analytics"),
      "@massingifc/ui-shell": pkg("ui-shell"),
      "@massingifc/authoring": pkg("authoring"),
      "@massingifc/viewer-runtime": pkg("viewer-runtime"),
      "@massingifc/viewer-thatopen": pkg("viewer-thatopen"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
  },
});
