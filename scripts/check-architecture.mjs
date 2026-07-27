#!/usr/bin/env node
/**
 * Enforces the architectural invariants the README claims.
 *
 * These are the properties the whole design rests on, and prose cannot hold them: someone adds a
 * convenient import, the claim quietly becomes false, and nobody notices until a plugin that was
 * supposed to run headless drags a renderer into a server process. Checking them in CI turns the
 * claims into something that fails a build instead of ageing badly.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PACKAGES_DIR = "packages";

/** The single package permitted to carry third-party runtime dependencies. */
const ADAPTER = "@massingifc/viewer-thatopen";

/**
 * Platform adapters may reach for platform APIs — that is their entire job.
 *
 * A category rather than an exception list of convenience: each entry names a package whose
 * purpose is to bind the portable core to one runtime, and says which APIs that entitles it to.
 */
const PLATFORM_ADAPTERS = new Map([
  ["@massingifc/viewer-thatopen", [/^three(\/|$)/, /^@thatopen\//]],
  ["@massingifc/storage-node", [/^node:/]],
]);

/** The kernel must depend on nothing at all — not even a sibling. */
const KERNEL = "@massingifc/core-kernel";

/** Packages that must never appear in a browser bundle's import graph from a capability family. */
const FORBIDDEN_IMPORTS = [
  { pattern: /^three(\/|$)/, why: "a renderer" },
  { pattern: /^@thatopen\//, why: "a viewer engine" },
  { pattern: /^node:/, why: "a Node built-in" },
];

const failures = [];
const note = (message) => failures.push(message);

const packages = readdirSync(PACKAGES_DIR).filter((name) =>
  statSync(join(PACKAGES_DIR, name)).isDirectory(),
);

const manifests = new Map();
for (const name of packages) {
  const path = join(PACKAGES_DIR, name, "package.json");
  try {
    manifests.set(name, JSON.parse(readFileSync(path, "utf8")));
  } catch {
    note(`${name}: package.json is missing or unreadable`);
  }
}

// ---------------------------------------------------------------------------------------------
// 1. Runtime dependencies
// ---------------------------------------------------------------------------------------------

for (const [name, manifest] of manifests) {
  const deps = Object.keys(manifest.dependencies ?? {});
  const thirdParty = deps.filter((dep) => !dep.startsWith("@massingifc/"));

  if (manifest.name === ADAPTER) continue; // the one package allowed to carry them
  if (thirdParty.length > 0) {
    note(
      `${name}: has third-party runtime dependencies (${thirdParty.join(", ")}). ` +
        `Only ${ADAPTER} may carry them — that is what keeps every other package portable.`,
    );
  }
}

const kernel = manifests.get("core-kernel");
if (kernel && Object.keys(kernel.dependencies ?? {}).length > 0) {
  note(
    `core-kernel: must have no dependencies at all, found ` +
      `${Object.keys(kernel.dependencies).join(", ")}. The kernel is the thing everything else ` +
      `depends on; giving it a dependency inverts that.`,
  );
}

// ---------------------------------------------------------------------------------------------
// 2. Source imports
// ---------------------------------------------------------------------------------------------

const sourceFiles = (dir) => {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".ts")) out.push(path);
    }
  };
  try {
    walk(dir);
  } catch {
    /* package has no src yet */
  }
  return out;
};

const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;

for (const name of packages) {
  if (manifests.get(name)?.name === ADAPTER) continue;

  for (const file of sourceFiles(join(PACKAGES_DIR, name, "src"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT)) {
      const specifier = match[1];
      const allowed = PLATFORM_ADAPTERS.get(manifests.get(name)?.name ?? "") ?? [];
      if (allowed.some((pattern) => pattern.test(specifier))) continue;

      const forbidden = FORBIDDEN_IMPORTS.find((rule) => rule.pattern.test(specifier));
      if (forbidden) {
        note(
          `${file}: imports "${specifier}" — ${forbidden.why}. Only a declared platform adapter may.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 3. Declared dependencies match what is imported
// ---------------------------------------------------------------------------------------------

for (const name of packages) {
  const manifest = manifests.get(name);
  if (!manifest) continue;
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);

  const used = new Set();
  for (const file of sourceFiles(join(PACKAGES_DIR, name, "src"))) {
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const specifier = match[1];
      if (specifier.startsWith("@massingifc/")) used.add(specifier);
    }
  }

  for (const dependency of used) {
    if (dependency === manifest.name) continue;
    if (!declared.has(dependency)) {
      // An undeclared workspace import resolves by accident through hoisting and breaks the moment
      // the package is built or published on its own.
      note(`${name}: imports ${dependency} but does not declare it as a dependency.`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 4. Licence consistency
// ---------------------------------------------------------------------------------------------

for (const [name, manifest] of manifests) {
  if (manifest.license !== "MIT") {
    note(`${name}: license is "${manifest.license ?? "unset"}", expected "MIT".`);
  }
}

// ---------------------------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\nArchitecture check failed with ${failures.length} problem(s):\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("");
  process.exit(1);
}

console.log(`Architecture check passed across ${packages.length} packages.`);
