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
  ["@massingifc/storage-browser", []], // browser globals only; no bare imports needed
]);

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

/**
 * Every way a module specifier can appear.
 *
 * A single `import … from` pattern was not enough: `import "three";`, `await import("three")` and
 * `require("three")` all slipped past it, so the check reported success on exactly the violation it
 * exists to catch. A guard that is trusted and does not fire is worse than no guard. False
 * positives are the safer failure here — one shows up immediately and is trivially explained.
 */
const SPECIFIER_PATTERNS = [
  // import … from "x" / export … from "x"
  /(?:^|[\s;}])(?:import|export)\b[\s\S]*?\sfrom\s*["']([^"']+)["']/g,
  // import "x"  (side-effect only, no bindings)
  /(?:^|[\s;}])import\s*["']([^"']+)["']/g,
  // import("x") — dynamic
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  // require("x") — CommonJS
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/** All module specifiers referenced by a source file. */
function extractSpecifiers(source) {
  const found = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return found;
}

for (const name of packages) {
  if (manifests.get(name)?.name === ADAPTER) continue;

  for (const file of sourceFiles(join(PACKAGES_DIR, name, "src"))) {
    for (const specifier of extractSpecifiers(readFileSync(file, "utf8"))) {
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
    for (const specifier of extractSpecifiers(readFileSync(file, "utf8"))) {
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
// 4. Capability tokens and command ids are globally unique
// ---------------------------------------------------------------------------------------------

/**
 * Both namespaces are flat and global at runtime.
 *
 * The capability registry keys on the token's string id, and the command bus throws on a duplicate
 * id — which surfaces as the *second* plugin failing to activate and being quarantined, a long way
 * from the two identical strings that caused it. Cheap to check here, confusing to debug there.
 */
const CAPABILITY_TOKEN = /createCapabilityToken<[^>]*>\(\s*["']([^"']+)["']/g;

/**
 * Command ids are read only from the `*_COMMANDS` blocks that declare them.
 *
 * Scanning every `key: "value"` pair instead swept up `point: "panel"`, `severity: "error"` and
 * `status: "draft"` — twenty false positives on a clean tree. A guard nobody believes gets
 * disabled, so the narrow reading is the useful one.
 */
const COMMANDS_BLOCK = /\b[A-Z][A-Z0-9_]*_COMMANDS\s*=\s*\{([\s\S]*?)\}\s*as const/g;
const BLOCK_ENTRY = /["']?[A-Za-z][A-Za-z0-9]*["']?\s*:\s*["']([^"']+)["']/g;

const declarations = (source) => {
  const tokens = [...source.matchAll(CAPABILITY_TOKEN)].map((m) => ["capability token", m[1]]);
  const commands = [...source.matchAll(COMMANDS_BLOCK)].flatMap((block) =>
    [...block[1].matchAll(BLOCK_ENTRY)].map((m) => ["command id", m[1]]),
  );
  return [...tokens, ...commands];
};

const owners = new Map();
for (const name of packages) {
  for (const file of sourceFiles(join(PACKAGES_DIR, name, "src"))) {
    // Tests deliberately mint throwaway tokens; only shipped source defines the namespace.
    if (file.endsWith(".test.ts")) continue;
    for (const [label, id] of declarations(readFileSync(file, "utf8"))) {
      const key = `${label}|${id}`;
      const owner = owners.get(key);
      if (owner && owner !== name) {
        note(`${label} "${id}" is declared by both ${owner} and ${name}; ids are global.`);
      } else {
        owners.set(key, name);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 5. No stray control characters in source
// ---------------------------------------------------------------------------------------------

/**
 * Source files must contain no control bytes other than tab, newline and carriage return.
 *
 * This has bitten twice, both times from a tool escaping a string one layer too few: a literal NUL
 * inside a character class, which made git treat a TypeScript file as binary and undiffable; and a
 * literal backspace where `\b` was meant, which silently turned a regex into one that could never
 * match, so the guard using it reported success on everything. Both were invisible on screen.
 */
for (const name of packages) {
  for (const file of sourceFiles(join(PACKAGES_DIR, name, "src"))) {
    const bytes = readFileSync(file);
    const offset = bytes.findIndex(
      (byte) => byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d,
    );
    if (offset !== -1) {
      note(
        `${file}: contains a control byte (0x${bytes[offset].toString(16).padStart(2, "0")}) at ` +
          `offset ${offset}. Write the escape sequence rather than the character itself.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 6. Licence consistency
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
