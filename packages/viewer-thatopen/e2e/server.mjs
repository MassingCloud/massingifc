import { spawn } from "node:child_process";

/**
 * Owns the dev server for the browser smoke test.
 *
 * Playwright's own `webServer` block cannot be used here. On Windows it does not terminate the
 * Vite process it starts: the run passes its tests and then hangs indefinitely waiting for a child
 * that never exits, and the orphan keeps port 5199 bound — so the *next* run fails with
 * "already used", which sends you looking at your machine rather than at the previous run. Owning
 * the process here means there is exactly one thing holding the port and exactly one thing that
 * kills it.
 *
 * Playwright treats a function returned from `globalSetup` as the teardown, which keeps the child
 * handle in a closure rather than in a pid file that can go stale.
 */

const URL = "http://localhost:5199";
const READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 250;

async function responds() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const response = await fetch(URL, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

export default async function globalSetup() {
  if (await responds()) {
    throw new Error(
      `Something is already listening on ${URL}. It is most likely an orphaned dev server from an earlier run; stop it and try again.`,
    );
  }

  // Vite's bin is invoked directly rather than through a shell. Playwright's own webServer runs its
  // command through `cmd.exe`, and it is that extra hop which makes the child unkillable here.
  const server = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--config", "packages/viewer-thatopen/e2e/vite.config.mjs"],
    { stdio: "ignore", windowsHide: true },
  );

  let exited = false;
  server.once("exit", () => {
    exited = true;
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) throw new Error("The dev server exited before it became reachable.");
    if (await responds()) {
      return async () => {
        if (!exited) server.kill();
        // A killed process still has to be reaped, and the port has to actually come free before
        // the next run starts, so wait for the exit rather than assuming it.
        if (!exited) {
          await new Promise((resolve) => {
            server.once("exit", resolve);
            setTimeout(resolve, 5_000);
          });
        }
      };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  server.kill();
  throw new Error(`The dev server did not answer ${URL} within ${READY_TIMEOUT_MS / 1000}s.`);
}
