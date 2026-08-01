# Python

Two packages. Neither is a port of the platform — the kernel, the plugins and the viewer stay in
TypeScript, and the viewer could not move anyway because three.js and `@thatopen` are browser
JavaScript. What lives here is the part that genuinely benefits from being outside that runtime.

| Package | What it is | Dependencies |
|---|---|---|
| `massingifc_scene` | The scene package format: **importer**, reader, writer, validator | none — stdlib only |
| `massingifc_ifc` | IFC to scene package, server-side | `ifcopenshell` |

## Why this exists

`@massingifc/engine-bridge` claims a consumer of a scene package needs nothing but a JSON parser
and a file handle — that neither implementation is the definition of the format. A claim like that
is worth nothing until something outside the original language reads and writes it. This is that
something, and `tests/test_conformance.py` runs a package through both directions:

- TypeScript writes → Python reads.
- Python writes → TypeScript reads (checked by `tests/conformance/verify.mjs`).
- Both writers are compared field by field, so a difference in whether an absent value is *omitted*
  or written as `null` fails the build rather than surfacing months later in an engine.

The FNV-1a content hash is implemented twice, deliberately, and the conformance suite checks the
two agree. If they did not, a Python-written package would look changed to a TypeScript reader and
be needlessly re-fetched on every sync.

## The importer

`SceneImporter` is the consumer half, written as the reference an engine integration is ported
*from*. An Unreal C++ plugin or a Unity C# importer will not call this code, but it has to make the
same decisions, and having them written down once — with tests — gives every native implementation
something concrete to agree with instead of prose.

```python
from massingifc_scene import DirectoryArchive, SceneImporter

importer = SceneImporter.open(DirectoryArchive("out/"))

wall = importer.node("1Wall00000000000000W01")          # addressed by GlobalId, never by position
importer.by_class("IFCWALLSTANDARDCASE")                 # precomputed index, verified on open
importer.by_level("0Level00000000000000L1")
importer.ancestors("2Door00000000000000D01")             # storey ← wall ← door
importer.property("1Wall00000000000000W01", "FireRating")
importer.reality_layers(measurable_only=True)            # excludes radiance fields
importer.geometry_for("1Wall00000000000000W01")          # bytes fetched only when asked for
```

Three rules it exists to demonstrate:

1. **Address by GlobalId, never by array position or runtime id.** Positions shift between
   revisions; a GlobalId does not. `transient_local_id` is carried for debugging and is not a key —
   a test asserts it never reaches an index.
2. **Trust the manifest's indexes, but verify them once.** They are precomputed so a consumer does
   not rebuild them on every load. A stale index is worse than none, because consumers trust it and
   selection then silently picks the wrong element — so `open()` verifies and refuses.
3. **Do not load geometry eagerly.** `payload_id` is a reference. Fragments is designed for models
   that do not fit in memory at once, and an importer that reads every payload on open throws that
   away.

## Command line

```bash
python -m massingifc_scene out/                       # summary
python -m massingifc_scene out/ --classes             # what is in it
python -m massingifc_scene out/ --element 1Wall000... # one element in full
```

```bash
python -m massingifc_ifc model.ifc --out out/ \
  --fragments model.frag --crs EPSG:27700 --origin-offset 530000,180000,0
```

## Conversion

`massingifc_ifc` produces the semantic half of a package straight from IFC — identity, hierarchy,
classes, property sets, quantities, units — and attaches a Fragments binary when you have one.
Converting server-side is the arrangement the architecture already assumes: convert once, somewhere
with time and memory, rather than parsing IFC in every user's session.

It does **not** tessellate. Re-encoding geometry here would invent a parallel format, duplicate what
Fragments already does, and discard the per-element addressing it carries.

Quantities are hoisted into a `Quantities` set *and* left where IFC put them: takeoff wants them by
name as numbers, a property panel wants them in their own set. Non-scalar property values are
dropped rather than stringified, because `"[object Object]"` is indistinguishable from a real value
while an absent key is not.

## Running the tests

```bash
cd python && python -m unittest discover -s tests
```

The conformance tests need the TypeScript side built (`npm run typecheck` at the repo root); they
skip with a message rather than failing if `dist/` is absent. The converter tests skip if
`ifcopenshell` is not installed. Everything else is stdlib and always runs.
