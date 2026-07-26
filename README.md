# massingifc

A framework-agnostic **kernel and plugin architecture** for a federated AEC platform.

This repository contains the permanent backbone — service container, event bus, command bus, state
store, versioned persistence, plugin host, capability and UI extension registries — plus
interface-first contracts for every capability family the platform is intended to grow: markup,
authoring, massing, family libraries, digital twin, coordination, 4D planning, 5D estimating,
procurement and field.

It deliberately contains **no viewer**. See [Relationship to `ibuilder/massing`](#relationship-to-ibuildermassing).

---

## Why this exists

The platform specification this repository was built from calls for a stable viewer kernel with
plug-in capability families. Validation against the existing codebase found that the viewer half is
already built and mature in [`ibuilder/massing`](https://github.com/ibuilder/massing) — That Open
Components bootstrap, `FragmentsManager` runtime, IFC→Fragments conversion, camera binding,
multi-model lifecycle — across ~66k lines of TypeScript.

What did **not** exist was the architecture: no kernel, no plugin host, no capability registry, no
versioned persistence. `app.ts` is a single 4,402-line file. The only plugin concept is a
server-side Python example.

So this repository builds the missing half, standalone, with no dependency on and no risk to the
working product.

## Design rules

1. **The kernel contains mechanisms, never features.** Nothing in `core-kernel` knows what an IFC
   model, a markup pin, a massing story or a cost assembly is. Capability arrives only through
   plugins, which is what allows the kernel to be versioned and held stable.
2. **No plugin can crash the host.** Activation, command handlers, event subscribers, state
   listeners and UI predicates are all isolated. A plugin that throws is quarantined and its partial
   registrations are rolled back.
3. **Interface-first.** Every capability family ships contracts before implementation.
4. **Everything persisted is versioned.** Schema id and version travel inside the document, and a
   document written by a newer build is refused rather than misread.
5. **Framework-agnostic.** No DOM type, no `three`, no `@thatopen/*` import anywhere in this
   repository — including the viewer contracts. The same plugin must run in a web shell, a desktop
   shell, and a headless test.

## Packages

| Package | Status | Contents |
|---|---|---|
| `core-kernel` | **Implemented** | DI container, event bus, command bus (+undo), state store, persistence, plugin host, capability & UI registries, permissions, telemetry |
| `project-schema` | **Implemented** | ~45 record contracts, migration engine, schema registry |
| `plugin-sdk` | **Implemented** | `definePlugin`, test harness, versioned kernel facade |
| `viewer-runtime` | Contracts | World, IFC conversion, fragments lifecycle, selection, visibility, tree, viewpoints, sectioning |
| `federation` | Contracts | Multi-model load/unload/visibility, revision replacement, session state |
| `markup` | Contracts | Markup, anchors, issues, comment threads, review snapshots |
| `authoring` | Contracts | Edit sessions, edit commands, history, publish, constraints, sketch planes |
| `massing` | Contracts | Profiles, story-aware masses, appearance, metrics, options, promotion |
| `family-libraries` | Contracts | Repository adapters, resolution, placement, parameters, versioning |
| `digital-twin` | Contracts | Registry, alignment, observations, timeline, promotion |
| `coordination` | Contracts | Clash, validation, issue routing, revision diff, responsibility |
| `planning-4d` | Contracts | Schedule import, task-model links, playback, planned-vs-actual |
| `estimating-5d` | Contracts | Takeoff, classification, assemblies, BOQ, estimates, cashflow, change impact |
| `procurement-field` | Contracts | Packages, vendor scope, field status, inspection, install progress |
| `interop` | Contracts | Import/export adapters, enterprise connectors |
| `analytics` | Contracts | Metric providers, reports, forecasts |
| `ui-shell` | Contracts | Layout regions, notifications, palette, dialogs, status bar |

"Contracts" means compiling TypeScript interfaces, capability tokens, command ids and permission
constants — no runtime implementation yet.

## Getting started

```bash
npm install
```

```bash
npm test
```

```bash
npm run build
```

Requires Node 18 or newer. This repository has **no runtime dependencies** — only TypeScript and
Vitest as dev tooling.

## Writing a plugin

```ts
import { definePlugin, createCapabilityToken } from "@massingifc/plugin-sdk";

const GreeterToken = createCapabilityToken<{ greet(name: string): string }>("demo.greeter");

export const greeterPlugin = definePlugin({
  id: "demo.greeter",
  version: "1.0.0",
  permissions: ["demo.greet"],
  activate(context) {
    const slice = context.state.defineSlice("log", { entries: [] as string[] });

    context.capabilities.provide(GreeterToken, {
      greet: (name) => `Hello, ${name}`,
    });

    context.commands.register({
      id: "demo.greet",
      title: "Greet",
      permission: "demo.greet",
      handler: ({ name }: { name: string }) => {
        slice.update((s) => ({ entries: [...s.entries, name] }));
      },
    });

    context.ui.register({ id: "demo.panel", point: "panel", title: "Greeter", placement: "left" });
  },
});
```

Everything registered through `context` is released automatically when the plugin deactivates —
commands, panels, event subscriptions, capabilities, state slices and services.

Test it against a real kernel rather than a mock:

```ts
import { createTestHarness } from "@massingifc/plugin-sdk";

const harness = createTestHarness();
await harness.load(greeterPlugin);
await harness.kernel.commands.execute("demo.greet", { name: "Ada" });
```

## Versioning and migration

Every persisted document carries `{ schema, version, savedAt, data }`. `MigrationRegistry` owns the
upgrade rules and implements the kernel's `DocumentMigrator`, so wiring is one argument:

```ts
const migrator = createDefaultMigrationRegistry().register({
  schema: SCHEMA.massingObject,
  from: 1,
  to: 2,
  description: "split totalHeight into per-story heights",
  migrate: (data) => ({ ...(data as object), storyHeights: [] }),
});

const kernel = createKernel({ migrator, storage: myAdapter });
```

Reads are pure — `load` migrates the value it returns but does not rewrite storage. Use
`migrateInPlace` when you want the upgrade persisted; it takes a backup first.

## Relationship to `ibuilder/massing`

These are complementary, not competing.

- `ibuilder/massing` is the working product: viewer, portal, drawings, proforma, field tools.
- `massingifc` is the architecture that product does not yet have.

The intended path is adoption, not replacement: `ibuilder/massing` can depend on `core-kernel` and
`plugin-sdk`, then move capabilities out of `app.ts` into plugins one at a time, each behind a
capability token defined here. Nothing needs to move in a single step, and the viewer keeps working
throughout.

The viewer contracts in `packages/viewer-runtime` are written to describe what that codebase already
does — `ModelLoaderService` mirrors its `ModelLoader`, including the separation of conversion from
loading — so adoption is implementing an interface over existing code, not rewriting it.

## Not yet built

Stated plainly:

- No viewer implementation, no `three`/`@thatopen` integration.
- No capability family is implemented — all fourteen are contracts only.
- No web or desktop application shell.
- No storage adapter beyond in-memory; IndexedDB and filesystem adapters are unwritten.
- No migrations exist yet; every schema sits at v1.
