import { expect, test } from "@playwright/test";

/**
 * The one claim in this repository that typechecking cannot settle.
 *
 * Every other assertion about the adapter comes from compiling against the published `.d.ts`,
 * which proves the API is *used* correctly and nothing about whether it runs. This boots the real
 * engine against a real graphics context.
 */

test("boots the That Open world against a real WebGL context", async ({ page }) => {
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto("/");
  await page.waitForFunction(() => window.smokeResult !== undefined);

  const result = await page.evaluate(() => window.smokeResult);

  expect(result.error).toBeUndefined();
  expect(result.initialised).toBe(true);

  // The renderer must have produced a live context attached to the page, not merely constructed.
  expect(result.hasWebGLContext).toBe(true);
  expect(result.canvasAttached).toBe(true);

  expect(result.hasScene).toBe(true);
  expect(result.hasCamera).toBe(true);
  // `SimpleScene.setup()` adds lighting and a grid is requested, so an initialised world is not an
  // empty one — this catches a bootstrap that "succeeds" without building anything.
  expect(result.childrenAfterInit).toBeGreaterThan(0);

  // Disposal must actually release, or a host opening several projects leaks a graphics context
  // each time until the browser refuses to create more.
  expect(result.disposedCleanly).toBe(true);

  expect(consoleErrors).toEqual([]);
});
