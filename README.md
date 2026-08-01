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
| `engine-bridge` | **Implemented** | Engine-neutral scene packages: GlobalId-keyed nodes, precomputed class/level indexes, properties and relationships, binary payloads by reference, a provider built on the viewer contracts |
| `analytics` | **Implemented** | Metric provider aggregation, history, snapshots, reports, forecasts with bounds |
| `ui-shell` | **Implemented** | Headless reference shell: layout, notifications, progress, palette, status bar |
| `integration` | **Tests only** | Cross-plugin suite proving the families compose through the kernel |
| `viewer-runtime` | Contracts | World, IFC conversion, fragments lifecycle, selection, visibility, tree, viewpoints, sectioning |
| `viewer-thatopen` | **Implemented** | That Open Components adapter — implements all eight viewer contracts: world bootstrap, FragmentsManager lifecycle, GlobalId resolution, selection, properties, spatial tree, search, visibility and colour overrides, viewpoints, sectioning. The one package with third-party runtime dependencies |
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

795 tests, including a cross-plugin integration suite that runs all fifteen capability plugins in one
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
dependencies** — that adapter carries `three` and `@thatopen/*` so the other seventeen do not.

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

## Georeferencing and captured reality

A transform is not georeferencing. It places geometry relative to a project origin nobody outside
the project knows, which is why a scan aligned by matrix alone cannot be checked against a survey
or dropped into a GIS scene. `GeoReference` in `project-schema` is shared rather than owned by one
capability family, because a reference model, a laser scan, a Gaussian splat and a site boundary
all have to say where on Earth they are and have to say it the same way. `ModelRecord` and
`TwinObjectRecord` both carry one — a model's `transform` records where someone *put* a model
delivered on a different datum, which is not the same fact as where it belongs.

```ts
const scan: TwinObjectRecord = {
  id: "scan-1", name: "West elevation", kind: "gaussian-splat",
  transform: [], aligned: true, createdAt: now, provenance: { source: "drone" },
  geoReference: {
    sourceCrs: "EPSG:27700", units: "m", verticalDatum: "ODN", method: "survey",
    // Subtracted from world coordinates so the renderer works near zero.
    originOffset: [530000, 180000, 0],
  },
  extent: { xmin: 0, ymin: 0, xmax: 42, ymax: 30 },
  derivatives: { orthomosaicUri: "blob:ortho", meshUri: "blob:mesh" },
  purpose: "inspection",
};

const report = await validateRealityDataset(scan, { resolveUri });
```

Three things this encodes that a bare transform cannot:

- **`originOffset` exists for float precision.** A British National Grid easting is around 530000.
  A 32-bit float carries about seven significant digits, so geometry rendered at true coordinates
  jitters and z-fights. Every renderer works in a local frame; recording the offset is what makes
  that frame reversible instead of a lossy fudge.
- **`verticalDatum` is separate from the horizontal CRS.** Two datasets can agree exactly in plan
  and sit a metre apart in height — the difference between a slab that clashes and one that does not.
- **`method` records how the georeference was established.** `"survey"` and `"assumed"` are
  different facts, and treating them alike is how unverified data gets trusted.

### Gaussian splats are a first-class kind, not a mesh

`"gaussian-splat"` sits alongside `"point-cloud"` and `"mesh-scan"` rather than being folded into
them, because a radiance field renders convincingly and measures badly: it is view-dependent, and
it has no surface. A dimension picked off one is a plausible-looking number with no defined
relationship to the building.

So the platform refuses rather than guesses. `isMeasurable` returns false for a bare splat and for
anything marked `purpose: "visualization"`, and promotion to `authoring` or `family` is refused
with the reason — while registering it as an `asset` stays allowed, because cataloguing it is fine.
Deriving a mesh (`derivatives.meshUri`) lifts the restriction, since that is a surface.

`validateRealityDataset` reports the rest: a missing georeference on captured reality is an error;
an unqualified CRS code, an implausible extent, large coordinates with no origin offset, an
unverified georeference and unresolvable derivative links are warnings. Extents are read in their
declared units before being judged, so a 40000 mm building is not mistaken for a 40 km capture.

## Rendering in a game engine

The platform will need a real-time engine eventually. The mistake to avoid is writing an Unreal
layer or a Unity layer — both would bake one vendor's object model into the conversion path, and the
conversion path is the part that has to survive. `@massingifc/engine-bridge` defines a neutral
package instead: a JSON manifest plus opaque binary payloads that an Unreal C++ plugin, a Unity C#
importer, a Bevy crate or a native viewer can each read with a JSON parser and a file handle. **No
JavaScript runtime is required on the far side.**

```ts
const scene = buildScenePackage({
  generator: "massingifc", generatedAt: now, sourceUnits: "mm",
  nodes: elements.map((e) => ({
    globalId: e.globalId,           // identity
    ifcClass: e.ifcClass, levelGlobalId: e.storey,
    payloadId: "geometry-0", geometryIndex: e.meshIndex,
  })),
  payloads: [{ id: "geometry-0", role: "geometry", path: payloadPath("geometry-0", "glb"),
              encoding: "model/gltf-binary", byteLength: bytes.length }],
});

await writeScenePackage(archive, scene.value, { payloads: new Map([["geometry-0", bytes]]) });
```

What makes it a BIM contract rather than a mesh dump:

- **GlobalId is the identity, everywhere.** An element costed in `estimating-5d`, clashed in
  `coordination` and selected in the engine are the same element because all three key on the same
  string. A viewer's runtime id may travel as `transientLocalId`, labelled transient, used by
  nothing — the integration suite asserts it never reaches the index.
- **Semantics travel.** Property sets stay unflattened, relationships stay as typed edges, and the
  spatial parent and level are on every node. An importer that drops these has built another mesh
  importer.
- **Indexes are precomputed.** `byClass`, `byLevel` and `byGlobalId` are built once by the
  exporter, which already holds the model, rather than on every load in every engine.
- **Metres, always.** `sourceUnits` records what the model was authored in — that is provenance —
  but every coordinate that leaves is metres, so no consumer guesses. Transforms are column-major
  with translation at indices 12–14, stated explicitly because a transposed matrix loads without
  error and puts the model somewhere else.
- **Payloads stay separate files.** An engine wants to parse a small manifest and then stream or
  memory-map geometry it may never fully load. Base64 inside JSON forces the whole model through a
  parser and inflates it by a third.
- **`realityLayers` carry a `measurable` flag,** so a splat arrives in the engine marked as
  something to render, not something to collide with or dimension.

`viewer-thatopen` implements every viewer contract over fragments models, so
the provider below has a real viewer behind it. Both are testable headlessly — they talk to a
narrow `FragmentDataModel` port rather than a live model, and `asDataModel` proves **at compile
time** that the shape a fake satisfies is the shape the real `FragmentsModel` has. A port the
tests satisfy and the engine does not is worse than no port: every test passes while nothing
works. Both services batch — one call per model, not one per element — because the fragments
model answers from a worker and a per-element loop turns a property panel into N round trips.

Two decisions in the override services are worth knowing. `VisibilityService` is synchronous by
contract while the engine is not, so the override *state* is tracked locally — `hiddenElements()`
is correct the instant `hide()` returns, not whenever the worker catches up — and engine work is
pushed through one serial queue. Without that queue, `hide(x)` followed by `show(x)` issues two
overlapping round trips and whichever finishes last wins, so the element ends up hidden or shown
depending on scheduling. A viewpoint captures the hidden set and the active section planes
alongside the camera, because sharing "look at this" is useless if the recipient sees the whole
model, and it restores scene state *before* moving the camera so the animation does not play
against the old visibility.

`createViewerScenePackageProvider` builds packages from the `viewer-runtime` contracts — the
spatial tree and the property service are all it needs, so it works with any viewer and keeps
`engine-bridge` free of `three` and `@thatopen`. It walks the tree into GlobalId-keyed nodes,
skips grouping nodes the viewer invented (no element, no identity), stamps the containing storey
down each branch, and refuses a scope whose models declare different CRSs rather than picking one
and hiding a problem that has to be fixed upstream. Non-scalar property values are dropped rather
than stringified: `"[object Object]"` is indistinguishable from a real value, an absent key is not.

Geometry is **attached, not generated**. A `GeometrySource` hands over the model's Fragments
binary and the manifest references it. That is deliberate: Fragments is already the compact, open
representation of exactly this geometry, and the engine-side consumers being built against it read
it natively — so emitting glTF here would mean inventing a parallel format, decoding geometry the
engine decodes better, and throwing away the per-element addressing Fragments already carries.
The manifest supplies what the binary does not: identity keyed by GlobalId, the class and level
indexes precomputed, property sets, relationships and the georeference. The binary says what the
shapes are; the manifest says what they mean and how to address them.

`build()` returns the manifest **and** the payload bytes together, because a manifest naming
payloads nobody can supply is a promise rather than a package. Without a `GeometrySource` the
package carries semantics only and `validateScenePackage` says so; a scope may freely mix
converted and unconverted models.

`buildScenePackage` refuses duplicate GlobalIds instead of letting the second silently displace the
first in the index, and `validateScenePackage` catches stale indexes and missing payloads here,
where the message is useful, rather than inside a C++ importer that finds a null. `createSceneQuery`
is the reference semantics for the runtime queries — an engine will reimplement them natively, and
this is what those implementations agree with.

**No Unreal or Unity layer is included, deliberately.** That Open's FragmentsUnreal is not public at
the time of writing; when it is, a vendor layer can be added underneath this contract without
anything upstream changing. A vendor-specific contract could not have been.

## Python

Two packages under `python/`, neither a port of the platform — the kernel, the plugins and the
viewer stay in TypeScript, and the viewer could not move anyway because three.js and `@thatopen`
are browser JavaScript.

| Package | What it is | Dependencies |
|---|---|---|
| `massingifc_scene` | The scene package format: importer, reader, writer, validator | none — stdlib only |
| `massingifc_ifc` | IFC to scene package, server-side | `ifcopenshell` |

`SceneImporter` is the **engine-side importer**: the consumer half of the format, written as the
reference a native integration is ported from. An Unreal C++ plugin will not call it, but it has
to make the same three decisions — address by GlobalId and never by array position, verify the
precomputed index rather than trusting it blindly, and fetch geometry only when asked — and
having those written down once with tests beats prose.

```bash
python -m massingifc_scene out/ --element 1Wall00000000000000W01
python -m massingifc_ifc model.ifc --out out/ --fragments model.frag --crs EPSG:27700
```

The point of a second implementation is that it is a **check on the first**. The format claims a
consumer needs nothing but a JSON parser and a file handle; `python/tests/test_conformance.py`
turns that from a claim into a test by running a package both ways — TypeScript writes and Python
reads, Python writes and TypeScript reads — and comparing the two writers field by field, so a
disagreement about whether an absent value is omitted or `null` fails the build instead of
surfacing months later inside an engine. The FNV-1a payload hash is implemented twice on purpose,
and the suite checks the two agree; if they did not, a Python-written package would look changed
to a TypeScript reader and be re-fetched on every sync.

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

- `viewer-runtime` is contracts by design — it is the interface. `viewer-thatopen` implements it
  against That Open Components and is the **only** package with runtime dependencies, which is
  precisely what keeps the other seventeen dependency-free.
- The renderer is covered by a Playwright smoke test (`npm run test:browser`) that boots the real
  engine against a real WebGL context and asserts the world builds and disposal releases. Rendered
  *output* is still not asserted — no screenshot comparison — so a change that renders the wrong
  thing without erroring would pass. The dev server is owned by a `globalSetup` rather than
  Playwright's `webServer` block: on Windows that block does not terminate Vite, so the run hung
  after its tests had already passed and left an orphan holding the port, which made the *next*
  run fail with a misleading "already used".
- `ui-shell` ships the *bookkeeping* half of a shell — which panels exist, which are open, what
  the layout was — and leaves rendering to the host.
- No **engine-native** importer. `python/massingifc_scene` is a working consumer and the
  reference a C++ or C# integration is ported from, but nothing loads a package into Unreal or
  Unity yet. No vendor layer until FragmentsUnreal is public.
- No web or desktop application shell.
- No ZIP implementation — ICDD containers need a host-supplied `ContainerArchive`.
- No migrations exist yet; every schema sits at v1.
