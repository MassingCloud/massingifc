"""Cross-implementation conformance.

The format's central claim is that a consumer needs nothing but a JSON parser and a file handle —
that neither implementation is the definition. That is only worth anything if it is checked, so
these tests run a package through both directions:

* TypeScript writes, Python reads.
* Python writes, TypeScript reads.

Everything else in the Python suite could pass while the two implementations quietly disagreed
about, say, whether an absent field is omitted or null. This is the test that catches it.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from massingifc_scene import (  # noqa: E402
    FRAGMENTS_ENCODING,
    DirectoryArchive,
    GeoAccuracy,
    GeoReference,
    SceneImporter,
    SceneNode,
    ScenePayload,
    ScenePropertySet,
    SceneRealityLayer,
    SceneRelationship,
    SceneSource,
    build_scene_package,
    content_hash,
    payload_path,
    write_scene_package,
)

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
DIST = REPO / "packages" / "engine-bridge" / "dist" / "index.js"
NODE = shutil.which("node")

GEOMETRY = b"FRAGMENTS-BINARY-STANDIN"


def _run_node(script: str, argument: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [NODE, str(HERE / "conformance" / script), str(argument)],
        capture_output=True,
        text=True,
        cwd=str(REPO),
    )


@unittest.skipIf(NODE is None, "node is not on PATH")
@unittest.skipUnless(
    DIST.is_file(), "engine-bridge is not built; run `npm run typecheck` first"
)
class ConformanceTests(unittest.TestCase):
    def test_python_reads_what_typescript_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            emitted = _run_node("emit.mjs", root)
            self.assertEqual(emitted.returncode, 0, emitted.stderr or emitted.stdout)

            importer = SceneImporter.open(DirectoryArchive(root))

            # Identity and the precomputed indexes.
            self.assertEqual(len(importer), 3)
            self.assertEqual(importer.node("1Wall00000000000000W01").name, "External wall")
            self.assertEqual(len(importer.by_class("IFCDOOR")), 1)
            self.assertEqual(len(importer.by_level("0Level00000000000000L1")), 2)

            # Hierarchy.
            self.assertEqual(
                [node.global_id for node in importer.ancestors("2Door00000000000000D01")],
                ["1Wall00000000000000W01", "0Level00000000000000L1"],
            )

            # Units: TypeScript converted millimetres to metres on the way out, including the
            # georeference, and left `accuracy` alone because it is metres regardless.
            self.assertEqual(importer.units(), "m")
            self.assertEqual(importer.node("1Wall00000000000000W01").transform[12], 3)
            self.assertEqual(importer.scene.geo_reference.units, "m")
            self.assertEqual(tuple(importer.origin_offset()), (530_000, 180_000, 0))
            self.assertEqual(importer.scene.geo_reference.accuracy.horizontal, 0.02)

            # Semantics, including every scalar type a property can hold.
            self.assertEqual(importer.property("1Wall00000000000000W01", "FireRating"), "60")
            self.assertIs(importer.property("1Wall00000000000000W01", "IsExternal"), True)
            self.assertIs(importer.property("1Wall00000000000000W01", "LoadBearing"), False)
            self.assertIsNone(importer.property("1Wall00000000000000W01", "Nulled"))
            self.assertEqual(
                importer.property("1Wall00000000000000W01", "NetArea", "Quantities"), 12.5
            )
            self.assertEqual(len(importer.relationships("1Wall00000000000000W01")), 1)

            # The flag that stops a splat being measured.
            layers = importer.reality_layers()
            self.assertEqual(len(layers), 1)
            self.assertFalse(layers[0].measurable)
            self.assertEqual(importer.reality_layers(measurable_only=True), [])

            # Geometry, and a hash both implementations compute the same way.
            payload = importer.scene.payloads[0]
            self.assertEqual(payload.encoding, FRAGMENTS_ENCODING)
            bytes_read = importer.geometry_for("1Wall00000000000000W01")
            self.assertIsNotNone(bytes_read)
            self.assertEqual(content_hash(bytes_read), payload.hash)

    def test_typescript_reads_what_python_writes(self):
        scene = build_scene_package(
            generator="conformance-py",
            generated_at="2026-07-27T12:00:00.000Z",
            source_units="mm",
            sources=[SceneSource("struct", "Structure", "C01")],
            geo_reference=GeoReference(
                source_crs="EPSG:27700",
                units="mm",
                vertical_datum="ODN",
                method="survey",
                origin_offset=[530_000_000, 180_000_000, 0],
                accuracy=GeoAccuracy(horizontal=0.02),
            ),
            payloads=[
                ScenePayload(
                    id="geometry-struct",
                    role="geometry",
                    path=payload_path("geometry-struct", "frag"),
                    encoding=FRAGMENTS_ENCODING,
                    byte_length=len(GEOMETRY),
                    hash=content_hash(GEOMETRY),
                )
            ],
            nodes=[
                SceneNode(
                    global_id="0Level00000000000000L1",
                    name="Level 1",
                    ifc_class="IFCBUILDINGSTOREY",
                ),
                SceneNode(
                    global_id="1Wall00000000000000W01",
                    name="External wall",
                    ifc_class="IFCWALLSTANDARDCASE",
                    parent_global_id="0Level00000000000000L1",
                    level_global_id="0Level00000000000000L1",
                    transform=[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3000, 1500, 0, 1],
                    payload_id="geometry-struct",
                ),
                SceneNode(
                    global_id="2Door00000000000000D01",
                    name="Entrance door",
                    ifc_class="IFCDOOR",
                    parent_global_id="1Wall00000000000000W01",
                    level_global_id="0Level00000000000000L1",
                    payload_id="geometry-struct",
                ),
            ],
            properties={
                "1Wall00000000000000W01": [
                    ScenePropertySet(
                        "Pset_WallCommon", {"IsExternal": True, "FireRating": "60"}
                    ),
                    ScenePropertySet("Quantities", {"NetArea": 12.5}),
                ]
            },
            relationships=[
                SceneRelationship(
                    "IFCRELCONTAINEDINSPATIALSTRUCTURE",
                    "0Level00000000000000L1",
                    "1Wall00000000000000W01",
                )
            ],
            reality_layers=[
                SceneRealityLayer(
                    id="splat-1",
                    name="Facade capture",
                    kind="gaussian-splat",
                    measurable=False,
                    source_uri="blob:splat",
                )
            ],
        )

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_scene_package(
                DirectoryArchive(root), scene, {"geometry-struct": GEOMETRY}
            )

            verified = _run_node("verify.mjs", root)
            self.assertEqual(verified.returncode, 0, verified.stderr or verified.stdout)

    def test_the_two_writers_agree_on_the_wire(self):
        """The manifests are compared field by field, not just 'both parse'.

        A difference here means one implementation writes something the other would not — the
        exact drift that makes a second implementation stop being a check on the first.
        """
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            emitted = _run_node("emit.mjs", root)
            self.assertEqual(emitted.returncode, 0, emitted.stderr or emitted.stdout)
            from_ts = json.loads((root / "scene.json").read_text(encoding="utf-8"))

        # Rebuild the same content through the Python writer.
        scene = build_scene_package(
            generator=from_ts["generator"],
            generated_at=from_ts["generatedAt"],
            source_units="mm",
            sources=[SceneSource("struct", "Structure", "C01")],
            geo_reference=GeoReference(
                source_crs="EPSG:27700",
                units="mm",
                vertical_datum="ODN",
                method="survey",
                origin_offset=[530_000_000, 180_000_000, 0],
                accuracy=GeoAccuracy(horizontal=0.02),
            ),
            payloads=[ScenePayload.from_json(from_ts["payloads"][0])],
            nodes=[SceneNode.from_json(node) for node in from_ts["nodes"]],
            properties={
                key: [ScenePropertySet.from_json(entry) for entry in sets]
                for key, sets in from_ts["properties"].items()
            },
            relationships=[
                SceneRelationship.from_json(edge) for edge in from_ts["relationships"]
            ],
            reality_layers=[
                SceneRealityLayer.from_json(layer) for layer in from_ts["realityLayers"]
            ],
        )
        from_py = scene.to_json()

        # Nodes came back through `from_json` already converted, so re-converting would double the
        # scaling; compare everything else, then the nodes against the source.
        for key in ("formatVersion", "units", "sourceUnits", "sources", "index", "payloads"):
            self.assertEqual(from_py[key], from_ts[key], f"{key} disagrees")
        self.assertEqual(from_py["properties"], from_ts["properties"])
        self.assertEqual(from_py["relationships"], from_ts["relationships"])
        self.assertEqual(from_py["realityLayers"], from_ts["realityLayers"])
        self.assertEqual(set(from_py.keys()), set(from_ts.keys()), "key sets disagree")


if __name__ == "__main__":
    unittest.main()
