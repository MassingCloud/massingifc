/**
 * Reads a Python-produced package with the TypeScript implementation and checks it.
 *
 * The reverse direction of `emit.mjs`. Between them they establish the thing the format actually
 * claims: that neither implementation is the definition, and a package written by one is fully
 * usable by the other.
 *
 * Usage: node verify.mjs <package-directory>
 * Exits non-zero with a message on the first disagreement.
 */

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// `pathToFileURL` rather than a bare path: on Windows an absolute path like `C:\...` is
// rejected by the ESM loader, which reads the drive letter as an unknown URL scheme.
const bridge = await import(
  pathToFileURL(resolve(here, "../../../packages/engine-bridge/dist/index.js")).href
);

const root = resolve(process.argv[2] ?? ".");

class DirectoryArchive {
  async entries() {
    const found = [];
    const walk = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else found.push(relative(root, full).split("\\").join("/"));
      }
    };
    await walk(root);
    return found.sort();
  }
  async read(path) {
    try {
      return new Uint8Array(await readFile(join(root, path)));
    } catch {
      return undefined;
    }
  }
  async write() {
    throw new Error("read-only");
  }
}

const fail = (message) => {
  console.error(`conformance: ${message}`);
  process.exit(1);
};

const read = await bridge.readScenePackage(new DirectoryArchive());
if (!read.ok) fail(`could not read the Python package: ${read.error.message}`);

const { scene, readPayload } = read.value;
const query = bridge.createSceneQuery(scene);

// Identity and index survive the crossing.
if (scene.nodes.length !== 3) fail(`expected 3 nodes, found ${scene.nodes.length}`);
const wall = query.node("1Wall00000000000000W01");
if (!wall) fail("the wall is not addressable by GlobalId");
if (wall.name !== "External wall") fail(`wall name is ${wall.name}`);
if (query.byClass("IFCDOOR").length !== 1) fail("class index disagrees");
if (query.byLevel("0Level00000000000000L1").length !== 2) fail("level index disagrees");

// Hierarchy.
const ancestors = query.ancestors("2Door00000000000000D01").map((node) => node.globalId);
if (ancestors.join(",") !== "1Wall00000000000000W01,0Level00000000000000L1") {
  fail(`ancestors are ${ancestors.join(",")}`);
}

// Units: the Python writer converted millimetres to metres, including the georeference.
if (scene.units !== "m") fail(`units are ${scene.units}`);
if (wall.transform?.[12] !== 3) fail(`translation is ${wall.transform?.[12]}, expected 3`);
if (scene.geoReference?.units !== "m") fail("georeference was not converted to metres");
if (scene.geoReference?.originOffset?.[0] !== 530000) {
  fail(`origin offset is ${scene.geoReference?.originOffset?.[0]}`);
}
if (scene.geoReference?.accuracy?.horizontal !== 0.02) fail("accuracy was wrongly rescaled");

// Semantics.
if (query.property("1Wall00000000000000W01", "FireRating") !== "60") fail("property lost");
if (query.property("1Wall00000000000000W01", "IsExternal") !== true) fail("boolean lost");
if (query.property("1Wall00000000000000W01", "NetArea", "Quantities") !== 12.5) {
  fail("quantity lost");
}
if (query.relationships("1Wall00000000000000W01").length !== 1) fail("relationship lost");

// Reality layers keep the flag that stops a splat being measured.
const layer = scene.realityLayers?.[0];
if (!layer || layer.measurable !== false) fail("reality layer measurability lost");

// Payload: hash agrees across implementations, and the bytes are readable.
const payload = scene.payloads[0];
if (!payload) fail("no payload declared");
const bytes = await readPayload(payload.id);
if (!bytes) fail("payload bytes are unreadable");
const recomputed = bridge.contentHash(bytes);
if (recomputed !== payload.hash) {
  fail(`hash disagrees: manifest ${payload.hash}, recomputed ${recomputed}`);
}

// And the whole thing passes the TypeScript validator.
const report = bridge.validateScenePackage(scene);
if (!report.valid) {
  fail(`validation failed: ${report.issues.map((issue) => issue.code).join(", ")}`);
}

process.stdout.write("ok\n");
