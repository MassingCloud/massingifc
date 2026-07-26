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
| `plugin-sdk` | **Implemented** | `definePlugin`, test harness, record store, clock/id ports |
| `massing` | **Implemented** | Planar geometry, sketch validation, story-aware masses, metrics, options, promotion, undoable commands |
| `icdd` | **Implemented** | ISO 21597 containers: ontologies, RDF/XML codec, assembly, linking, validation |
| `viewer-runtime` | Contracts | World, IFC conversion, fragments lifecycle, selection, visibility, tree, viewpoints, sectioning |
| `federation` | Contracts | Multi-model load/unload/visibility, revision replacement, session state |
| `markup` | Contracts | Markup, anchors, issues, comment threads, review snapshots |
| `authoring` | Contracts | Edit sessions, edit commands, history, publish, constraints, sketch planes |
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

## ISO 21597 (ICDD)

`@massingifc/icdd` implements the Information Container for linked Document Delivery — both parts.

The vocabulary was taken from the published ontology documents at `standards.iso.org`, not
transcribed from prose: [Container](https://standards.iso.org/iso/21597/-1/ed-1/en/Container.rdf),
[Linkset](https://standards.iso.org/iso/21597/-1/ed-1/en/Linkset.rdf) and
[ExtendedLinkset](https://standards.iso.org/iso/21597/-2/ed-1/en/ExtendedLinkset.rdf). Conformance
depends on those IRIs being exact.

```ts
const archive = new MemoryArchive();

await writeContainer(archive, {
  description: { id: "c1", name: "Bridge inspection", conformanceIndicator: "ICDD-Part1-Container" },
  parties: [{ id: "p1", kind: "Organisation", name: "MassingCloud" }],
  documents: [
    { id: "model", kind: "internal", name: "Bridge", filename: "bridge.ifc", filetype: "ifc" },
    { id: "report", kind: "internal", name: "Inspection", filename: "inspection.pdf" },
  ],
  linksets: [{
    id: "ls1", name: "Findings", filename: "findings.rdf",
    links: [{
      type: "Elaborates",
      from: [{ documentId: "report" }],
      // Addresses one wall inside the IFC model, not the file as a whole.
      to: [{ documentId: "model", identifier: { kind: "string", value: "2O2Fr$t4X7Zf8NOew3FLOH", field: "GlobalId" } }],
    }],
  }],
});

const report = await validateContainer(archive);
```

What is implemented:

- Canonical layout — `index.rdf`, `Ontology resources/`, `Payload documents/`, `Payload triples/`.
- Internal, external and folder documents; parties; versioning fields; Dublin Core prefix bound.
- All **nine Part 2 link families as fifteen classes**, with inverse pairing and direction-aware
  serialisation. `invertLink` swaps class *and* endpoints — swapping only endpoints would leave
  `HasPart` asserting that a whole is part of its own component.
- Element-level addressing via string, URI and SPARQL-query identifiers.
- Structural validation: missing payloads, undeclared files, dangling link targets, directed links
  missing an endpoint, symmetric links given a direction.
- Parsed `indexGraph` and `linksetGraphs` are exposed so hosts can run their own SPARQL or the
  published SHACL shapes.

Two deliberate boundaries:

- **ZIP is a port.** `ContainerArchive` abstracts entry access; the host supplies compression
  (`CompressionStream`, `node:zlib`, or streaming straight from object storage). Taking a ZIP
  dependency here would force that choice on every deployment.
- **Validation is structural, not SHACL.** A full SHACL engine is a large dependency for failures
  that are almost always mundane — a payload file that never got written, a link to a renamed
  document. Those are caught here cheaply, with the offending file named.

Known limits: RDF/XML only (no Turtle or JSON-LD), `rdf:parseType` and DTDs are rejected rather
than mis-parsed, and checksum verification is not performed.

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
- Twelve capability families remain contracts only: viewer-runtime, federation, markup, authoring,
  family-libraries, digital-twin, coordination, planning-4d, estimating-5d, procurement-field,
  interop, analytics, ui-shell.
- No web or desktop application shell.
- No storage adapter beyond in-memory; IndexedDB and filesystem adapters are unwritten.
- No ZIP implementation — ICDD containers need a host-supplied `ContainerArchive`.
- No migrations exist yet; every schema sits at v1.
