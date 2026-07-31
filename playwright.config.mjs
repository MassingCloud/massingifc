import { defineConfig } from "@playwright/test";

/**
 * Browser smoke tests.
 *
 * Deliberately separate from the vitest suite: these need a real graphics context and take seconds
 * rather than milliseconds, so mixing them in would slow the unit suite that gets run constantly.
 * `npm test` stays fast; `npm run test:browser` is the slower, rarer check.
 *
 * Plain JavaScript rather than TypeScript because Playwright loads its config through Node, which
 * can only strip types from 22.6 onward — and this machine runs 20.3.1. The page under test is
 * still TypeScript; Vite transpiles it.
 */
export default defineConfig({
  testDir: "./packages/viewer-thatopen/e2e",
  // Point Playwright at a plain tsconfig. Its module-resolution hook loads tsconfigs for path
  // mapping and cannot resolve the root solution file's directory-style `references`, which fails
  // on Node 22 where the hook is active. Naming a simple one sidesteps the walk entirely.
  tsconfig: "./packages/viewer-thatopen/e2e/tsconfig.json",
  testMatch: "**/*.spec.mjs",
  // A viewer that hangs should fail rather than stall the run.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: "http://localhost:5199",
    // Headless Chromium renders WebGL through SwiftShader, so no GPU is needed on a runner.
    launchOptions: { args: ["--enable-unsafe-swiftshader"] },
  },
  // The dev server is started and stopped by globalSetup rather than by Playwright's webServer
  // block, which on Windows leaves the Vite process running after the run and hangs waiting for it.
  globalSetup: "./packages/viewer-thatopen/e2e/server.mjs",
});
