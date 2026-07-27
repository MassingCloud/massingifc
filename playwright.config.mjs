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
  webServer: {
    // Vite's bin is invoked directly rather than through npx. The npx shim spawns a grandchild
    // process that Playwright cannot reliably terminate on Windows, which leaves the run hanging
    // after the tests themselves have already passed.
    command: "node node_modules/vite/bin/vite.js --config packages/viewer-thatopen/e2e/vite.config.mjs",
    url: "http://localhost:5199",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
