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
| `core-kernel` | **Implemented** | DI container, event bus, command bus (+undo), state store, persistence, **project containers**, plugin host, capability & UI registries, permissions, telemetry |
| `project-schema` | **Implemented** | ~45 record contracts, migration engine, schema registry |
| `plugin-sdk` | **Implemented** | `definePlugin`, test harness, record store, clock/id ports |
| `massing` | **Implemented** | Planar geometry, sketch validation, story-aware masses, metrics, options, promotion, undoable commands |
| `icdd` | **Implemented** | ISO 21597 containers: ontologies, RDF/XML codec, assembly, linking, validation |
| `markup` | **Implemented** | Pins, redlines, GlobalId anchoring with orphan reporting, issue state machine, threads, review snapshots |
| `estimating-5d` | **Implemented** | Takeoff with a safe expression evaluator, classification, composite rates, BOQ, estimates, cashflow, change impact |
| `planning-4d` | **Implemented** | Schedule import and re-import, rule-based model links, timeline playback, planned-versus-actual |
| `coordination` | **Implemented** | Clash with stable signatures and preserved triage, validation, issue routing, revision diff |
| `family-libraries` | **Implemented** | Repository adapters, semver resolution, package validation, placement, parameter checking, version upgrade |
| `digital-twin` | **Implemented** | Registry with pluggable factories, planar Procrustes alignment, observations, timelines, gated promotion |
| `procurement-field` | **Implemented** | Packages from BOQ, vendor comparison and award, element-level field status, inspection, earned value |
| `federation` | **Implemented** | Project composition, per-model load state, id-preserving revision replacement, session state |
| `authoring` | **Implemented** | Edit sessions, sketch-plane maths, reversible history, conflict-checked publish, constraints |
| `interop` | **Implemented** | Content-first format detection, import/export dispatch, connector governance |
| `analytics` | **Implemented** | Metric provider aggregation, history, snapshots, reports, forecasts with bounds |
| `ui-shell` | **Implemented** | Headless reference shell: layout, notifications, progress, palette, status bar |
| `integration` | **Tests only** | Cross-plugin suite proving the families compose through the kernel |
| `viewer-runtime` | Contracts | World, IFC conversion, fragments lifecycle, selection, visibility, tree, viewpoints, sectioning |
| `viewer-thatopen` | **Implemented** | That Open Components adapter — world bootstrap, FragmentsManager lifecycle, GlobalId resolution. The one package with third-party runtime dependencies |
| `storage-node` | **Implemented** | Filesystem persistence: reversible key encoding, serialised atomic writes, binary payloads |
| `storage-browser` | **Implemented** | IndexedDB persistence: native binary, bounded prefix queries, durable transactions |

"Contracts" means compiling TypeScript interfaces, capability tokens, command ids and permission
constants — no runtime implementation yet.

## Getting started

```bash
npm install
```

```bash
npm test
```

654 tests, including a cross-plugin integration suite that runs all seven capability plugins in one
kernel and exercises the chain from geometry to money to site.

```bash
npm run build
```

```bash
npm run verify
```

`verify` is what CI runs: architecture invariants, then build and typecheck, then tests.

```bash
npm run test:browser
```

Boots the viewer in headless Chromium against real WebGL. Kept out of `npm test` because it takes
minutes rather than seconds — Vite pre-bundles `three` and the engine on a cold cache.

### Enforced invariants

`npm run check:architecture` turns the claims on this page into something that fails a build rather
than ageing badly. It asserts that only `viewer-thatopen` carries third-party runtime dependencies,
that `core-kernel` has none at all, that no package outside the adapter imports `three`,
`@thatopen/*` or a `node:` built-in, that every workspace import is actually declared, and that
every package is MIT. Prose cannot hold those; a check can.

Requires **Node 20 or newer**. Every package except `viewer-thatopen` has **no runtime
dependencies** — that adapter carries `three` and `@thatopen/*` so the other sixteen do not.

Two toolchain notes worth knowing:

- The npm scripts invoke `node node_modules/typescript/lib/tsc.js` rather than the `tsc` shim.
  TypeScript 7 ships an extensionless ESM launcher that Node cannot load as an entry point below
  ~20.19; calling the library entry is what the shim does anyway, and it works on every supported
  Node.
- `tsconfig.base.json` sets `types: ["node"]`. The codebase uses only universal globals
  (`TextEncoder`, `AbortSignal`, `structuredClone`), but `lib: ["ES2022"]` alone does not declare
  them. `@types/node` supplies them as a **dev-time** type dependency — no runtime dependency is
  introduced, and the no-DOM rule still holds.

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

## Containers

`PersistenceEngine` stores individual versioned documents. A *project* is a different thing: one
package a user opens, saves and sends, holding models, records and binary payloads together.

`ContainerService` is that mechanism, and it lives in the kernel for the same reason the event bus
does — leaving it out means the first plugin that needs "open a project package" invents it, and
every other plugin then reaches around what it invented.

```ts
const container = unwrap(await kernel.containers.create("massingifc.project", {
  containerId: "p1", name: "Tower",
}));

await container.writeDocument("project.json", SCHEMA.project, { name: "Tower" });
await container.writeBlob("models/tower.frag", fragmentBytes, "application/octet-stream");
await kernel.containers.save();
```

Properties worth knowing:

- **One container is active at a time.** Records and the models they reference come back as one
  act — there is no API that opens one without the other, so they cannot drift apart in app code.
- **Closing over unsaved work fails** unless forced. Discarding a user's edits to satisfy an
  `open()` call is not a trade the kernel makes on their behalf.
- **Format is an adapter.** `StorageContainerAdapter` ships as a working reference; a file-backed
  `.mass` (`.mmproj` still readable) and an ISO 21597 adapter implement the same `ContainerAdapter`
  interface.
- **The kernel does not legislate how many models a container holds.** Single-model authoring and
  federated coordination are both legitimate; that is a product decision, not a backbone one.

## Element identity

`ElementRef` carries an IFC **GlobalId** as its identity:

```ts
interface ElementRef {
  readonly modelId: Id;
  readonly globalId: string;            // stable, persistable
  readonly localId?: number | string;   // transient runtime handle — cache, never store
}
```

`localId` (a Fragments local id, an express id) is valid for one load of one model in one session;
re-converting the same IFC can renumber it. Markup, clashes, 4D links, takeoff and field status all
reference elements through this type, so a transient identity here would propagate into every one
of them and surface only as "all the pins moved" after somebody re-issued a model.
`SelectionService` implementations must resolve picks to a populated `globalId` before publishing.

## Provenance

Numbers carry their origin rather than implying it. A quantity read off the model and one somebody
typed are both "1,240 m²" on screen; the difference becomes visible — expensively — when the model
is re-issued and only one of them moves.

- `QuantityRecord.source` is **required**: takeoff rule and version, or manual/imported/assumed.
- `BoqLineRecord.rateSource` and `CostAssemblyRecord.rateSource` do the same for money.
- `TaskModelLinkRecord.ifcRelationship` records intent explicitly, defaulting to
  `IfcRelAssignsToProduct` — a 4D link almost always names a task's *output*.
  `IfcRelAssignsToProcess` is for what a task *consumes* (labour, plant, materials). The two are
  easy to transpose and the result still validates, so the meaning is stated rather than inferred.

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
- `viewer-runtime` is contracts by design — it is the interface. `viewer-thatopen` implements it
  against That Open Components and is the **only** package with runtime dependencies, which is
  precisely what keeps the other sixteen dependency-free.
- The renderer is covered by a Playwright smoke test (`npm run test:browser`) that boots the real
  engine against a real WebGL context and asserts the world builds and disposal releases. Rendered
  *output* is still not asserted — no screenshot comparison — so a change that renders the wrong
  thing without erroring would pass. `ui-shell` ships the *bookkeeping* half of a shell — which panels
  exist, which are open, what the layout was — and leaves rendering to the host.
  `viewer-runtime` stays contracts deliberately — it needs a renderer, and this repository has no
  runtime dependencies.
- No web or desktop application shell.
- No ZIP implementation — ICDD containers need a host-supplied `ContainerArchive`.
- No migrations exist yet; every schema sits at v1.
