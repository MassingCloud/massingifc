import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** Resolves a workspace package to its source, the same way the vitest config does. */
const pkg = (name) => fileURLToPath(new URL(`../../${name}/src`, import.meta.url));

/**
 * Serves the smoke-test page. Plain JS so Vite's config loader needs no TypeScript support.
 *
 * The directory carries its own tsconfig.json deliberately: without one, Vite walks up to the root
 * solution file, whose `references` it cannot resolve, and the dev server refuses to start.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@massingifc/core-kernel": pkg("core-kernel"),
      "@massingifc/project-schema": pkg("project-schema"),
      "@massingifc/viewer-runtime": pkg("viewer-runtime"),
    },
  },
  server: { port: 5199, strictPort: true },
});
