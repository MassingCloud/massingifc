/**
 * Writes a reference package with the TypeScript implementation, for Python to read.
 *
 * Deliberately exercises the parts most likely to drift between two implementations: optional
 * fields that must be *absent* rather than null, unit conversion, a georeference in different
 * units from the model, a payload with a content hash, and a property value of every scalar type.
 *
 * Usage: node emit.mjs <output-directory>
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// `pathToFileURL` rather than a bare path: on Windows an absolute path like `C:\...` is
// rejected by the ESM loader, which reads the drive letter as an unknown URL scheme.
const bridge = await import(
  pathToFileURL(resolve(here, "../../../packages/engine-bridge/dist/index.js")).href
);

const outputDirectory = resolve(process.argv[2] ?? ".");

class DirectoryArchive {
  constructor(root) {
    this.root = root;
  }
  async entries() {
    return [];
  }
  async read() {
    return undefined;
  }
  async write(path, data) {
    const target = join(this.root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

const geometry = new TextEncoder().encode("FRAGMENTS-BINARY-STANDIN");

const payload = {
  id: "geometry-struct",
  role: "geometry",
  path: bridge.payloadPath("geometry-struct", "frag"),
  encoding: bridge.FRAGMENTS_ENCODING,
  byteLength: geometry.byteLength,
  hash: bridge.contentHash(geometry),
};

const built = bridge.buildScenePackage({
  generator: "conformance-ts",
  generatedAt: "2026-07-27T12:00:00.000Z",
  sourceUnits: "mm",
  sources: [{ modelId: "struct", modelName: "Structure", revision: "C01" }],
  geoReference: {
    sourceCrs: "EPSG:27700",
    units: "mm",
    verticalDatum: "ODN",
    method: "survey",
    originOffset: [530_000_000, 180_000_000, 0],
    accuracy: { horizontal: 0.02 },
  },
  payloads: [payload],
  nodes: [
    { globalId: "0Level00000000000000L1", name: "Level 1", ifcClass: "IFCBUILDINGSTOREY" },
    {
      globalId: "1Wall00000000000000W01",
      name: "External wall",
      ifcClass: "IFCWALLSTANDARDCASE",
      parentGlobalId: "0Level00000000000000L1",
      levelGlobalId: "0Level00000000000000L1",
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3000, 1500, 0, 1],
      bounds: [0, 0, 0, 3000, 200, 2400],
      payloadId: "geometry-struct",
      transientLocalId: 4172,
    },
    {
      globalId: "2Door00000000000000D01",
      name: "Entrance door",
      ifcClass: "IFCDOOR",
      parentGlobalId: "1Wall00000000000000W01",
      levelGlobalId: "0Level00000000000000L1",
      payloadId: "geometry-struct",
    },
  ],
  properties: {
    "1Wall00000000000000W01": [
      {
        name: "Pset_WallCommon",
        properties: { IsExternal: true, FireRating: "60", LoadBearing: false, Nulled: null },
      },
      { name: "Quantities", properties: { NetArea: 12.5, Count: 1 } },
    ],
  },
  relationships: [
    {
      type: "IFCRELCONTAINEDINSPATIALSTRUCTURE",
      fromGlobalId: "0Level00000000000000L1",
      toGlobalId: "1Wall00000000000000W01",
    },
  ],
  realityLayers: [
    {
      id: "splat-1",
      name: "Facade capture",
      kind: "gaussian-splat",
      measurable: false,
      sourceUri: "blob:splat",
      geoReference: { sourceCrs: "EPSG:27700", units: "m" },
    },
  ],
});

if (!built.ok) {
  console.error(built.error.message);
  process.exit(1);
}

const written = await bridge.writeScenePackage(new DirectoryArchive(outputDirectory), built.value, {
  payloads: new Map([["geometry-struct", geometry]]),
});

if (!written.ok) {
  console.error(written.error.message);
  process.exit(1);
}

process.stdout.write("ok\n");
