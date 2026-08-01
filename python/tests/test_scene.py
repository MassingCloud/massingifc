"""The Python implementation on its own terms.

Cross-implementation agreement is checked separately in ``test_conformance.py``; these are the
behaviours the Python side has to get right regardless of what TypeScript does.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from massingifc_scene import (  # noqa: E402
    GeoAccuracy,
    GeoReference,
    MemoryArchive,
    SceneImporter,
    SceneNode,
    ScenePackageError,
    ScenePropertySet,
    SceneRelationship,
    SceneSource,
    ScenePayload,
    build_scene_package,
    content_hash,
    convert_length,
    parse_crs_code,
    payload_path,
    read_scene_package,
    safe_payload_path,
    validate_scene_package,
    write_scene_package,
)

STOREY = SceneNode(
    global_id="0Level00000000000000L1", name="Level 1", ifc_class="IFCBUILDINGSTOREY"
)
WALL = SceneNode(
    global_id="1Wall00000000000000W01",
    name="External wall",
    ifc_class="IFCWALLSTANDARDCASE",
    parent_global_id=STOREY.global_id,
    level_global_id=STOREY.global_id,
    transient_local_id=4172,
)
DOOR = SceneNode(
    global_id="2Door00000000000000D01",
    name="Entrance door",
    ifc_class="IFCDOOR",
    parent_global_id=WALL.global_id,
    level_global_id=STOREY.global_id,
)


def build(**overrides):
    options = {
        "generator": "python-test",
        "generated_at": "2026-07-27T12:00:00.000Z",
        "nodes": [STOREY, WALL, DOOR],
    }
    options.update(overrides)
    return build_scene_package(**options)


class BuildTests(unittest.TestCase):
    def test_indexes_by_class_level_and_identity(self):
        scene = build()
        self.assertEqual(scene.index.by_class["IFCWALLSTANDARDCASE"], [1])
        self.assertEqual(scene.index.by_level[STOREY.global_id], [1, 2])
        self.assertEqual(scene.index.by_global_id[DOOR.global_id], 2)
        self.assertEqual(scene.units, "m")

    def test_refuses_duplicate_global_ids(self):
        # The index is a map: the second entry would displace the first and an element would
        # quietly stop being selectable.
        with self.assertRaises(ScenePackageError):
            build(nodes=[WALL, WALL])

    def test_refuses_a_node_with_no_identity(self):
        with self.assertRaises(ScenePackageError):
            build(nodes=[SceneNode(global_id="")])

    def test_converts_translation_but_not_rotation(self):
        scene = build(
            source_units="mm",
            nodes=[
                SceneNode(
                    global_id=WALL.global_id,
                    transform=[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3000, 1500, 0, 1],
                    bounds=[0, 0, 0, 3000, 200, 2400],
                )
            ],
        )
        self.assertEqual(list(scene.nodes[0].transform[12:]), [3, 1.5, 0, 1])
        self.assertEqual(list(scene.nodes[0].transform[:3]), [1, 0, 0])
        self.assertEqual(list(scene.nodes[0].bounds), [0, 0, 0, 3, 0.2, 2.4])

    def test_converts_georeference_by_its_own_units(self):
        scene = build(
            source_units="mm",
            geo_reference=GeoReference(
                source_crs="EPSG:27700",
                units="mm",
                origin_offset=[530_000_000, 180_000_000, 0],
                accuracy=GeoAccuracy(horizontal=0.02),
            ),
        )
        # A consumer computes world = local + originOffset; converting one side and not the other
        # puts the model a factor of a thousand away.
        self.assertEqual(scene.geo_reference.units, "m")
        self.assertEqual(list(scene.geo_reference.origin_offset), [530_000, 180_000, 0])
        # Accuracy is metres whatever `units` says, so it must not be scaled.
        self.assertEqual(scene.geo_reference.accuracy.horizontal, 0.02)

    def test_leaves_a_metre_georeference_alone_under_a_millimetre_model(self):
        scene = build(
            source_units="mm",
            geo_reference=GeoReference(
                source_crs="EPSG:27700", units="m", origin_offset=[530_000, 180_000, 0]
            ),
        )
        self.assertEqual(list(scene.geo_reference.origin_offset), [530_000, 180_000, 0])


class ValidationTests(unittest.TestCase):
    def test_accepts_a_well_formed_package(self):
        self.assertTrue(validate_scene_package(build()).valid)

    def test_rejects_a_reference_to_a_missing_payload(self):
        scene = build(nodes=[SceneNode(global_id="X1", payload_id="absent")])
        report = validate_scene_package(scene)
        self.assertFalse(report.valid)
        self.assertIn("unknown-payload-reference", [issue.code for issue in report.issues])

    def test_allows_a_scoped_export_with_an_outside_parent(self):
        report = validate_scene_package(build(nodes=[WALL, DOOR]))
        self.assertTrue(report.valid)
        self.assertIn("unknown-parent", [issue.code for issue in report.issues])

    def test_reports_a_semantics_only_package(self):
        self.assertIn("no-geometry", [issue.code for issue in validate_scene_package(build()).issues])


class CodecTests(unittest.TestCase):
    def test_round_trips_a_manifest_and_payload(self):
        payload = ScenePayload(
            id="geometry-struct",
            role="geometry",
            path=payload_path("geometry-struct", "frag"),
            encoding="application/vnd.thatopen.fragments",
            byte_length=4,
            hash=content_hash(b"FRAG"),
        )
        scene = build(
            payloads=[payload],
            nodes=[SceneNode(global_id=WALL.global_id, payload_id=payload.id)],
        )
        archive = MemoryArchive()
        write_scene_package(archive, scene, {"geometry-struct": b"FRAG"})

        self.assertEqual(
            sorted(archive.entries()), ["payloads/geometry-struct.frag", "scene.json"]
        )
        reread = read_scene_package(archive)
        self.assertEqual(reread.nodes[0].payload_id, "geometry-struct")

    def test_refuses_a_payload_whose_length_disagrees(self):
        payload = ScenePayload(
            id="p", role="geometry", path=payload_path("p"), encoding="x", byte_length=4
        )
        with self.assertRaises(ScenePackageError):
            write_scene_package(MemoryArchive(), build(payloads=[payload]), {"p": b"ab"})

    def test_refuses_an_unknown_major_version(self):
        archive = MemoryArchive({"scene.json": b'{"formatVersion":"2.0","nodes":[],"index":{}}'})
        with self.assertRaises(ScenePackageError):
            read_scene_package(archive)

    def test_refuses_an_index_that_would_break_the_first_lookup(self):
        archive = MemoryArchive(
            {"scene.json": b'{"formatVersion":"1.0","nodes":[],"index":{}}'}
        )
        with self.assertRaises(ScenePackageError):
            read_scene_package(archive)

    def test_rejects_paths_that_climb_out_of_the_package(self):
        self.assertEqual(safe_payload_path("payloads/a.frag"), "payloads/a.frag")
        self.assertEqual(safe_payload_path("./payloads/a.frag"), "payloads/a.frag")
        self.assertEqual(safe_payload_path("payloads\\a.frag"), "payloads/a.frag")
        for escaping in (
            "../../../.ssh/id_rsa",
            "payloads/../../secret",
            "/etc/passwd",
            "C:/Windows/System32/config",
            "",
            "payloads//a.frag",
        ):
            self.assertIsNone(safe_payload_path(escaping), escaping)

    def test_hash_is_stable_and_distinguishes_content(self):
        self.assertEqual(content_hash(b"FRAG"), content_hash(b"FRAG"))
        self.assertNotEqual(content_hash(b"FRAG"), content_hash(b"FRAH"))


class ImporterTests(unittest.TestCase):
    def setUp(self):
        self.scene = build(
            properties={
                WALL.global_id: [
                    ScenePropertySet("Pset_WallCommon", {"IsExternal": True, "FireRating": "60"}),
                    ScenePropertySet("Quantities", {"NetArea": 12.5}),
                ]
            },
            relationships=[
                SceneRelationship("IFCRELVOIDSELEMENT", WALL.global_id, DOOR.global_id)
            ],
        )
        self.importer = SceneImporter(self.scene)

    def test_addresses_elements_by_global_id(self):
        self.assertEqual(self.importer.node(WALL.global_id).name, "External wall")
        self.assertIn(WALL.global_id, self.importer)
        self.assertIsNone(self.importer.node("absent"))
        self.assertEqual(len(self.importer), 3)

    def test_exposes_the_metadata_bridge_an_engine_needs(self):
        element = self.importer.element(WALL.global_id)
        self.assertEqual(element.global_id, WALL.global_id)
        self.assertEqual(element.ifc_class, "IFCWALLSTANDARDCASE")
        self.assertEqual(element.level_global_id, STOREY.global_id)
        self.assertEqual(element.source_system, "massingifc")

    def test_never_makes_the_transient_id_a_key(self):
        # An importer that indexes on it reintroduces exactly the bug the format exists to avoid.
        self.assertEqual(self.importer.node(WALL.global_id).transient_local_id, 4172)
        self.assertNotIn("4172", self.scene.index.by_global_id)

    def test_filters_by_class_and_level(self):
        self.assertEqual(
            [node.global_id for node in self.importer.by_class("IFCDOOR")], [DOOR.global_id]
        )
        self.assertEqual(len(self.importer.by_level(STOREY.global_id)), 2)
        self.assertEqual(
            self.importer.classes(),
            ["IFCBUILDINGSTOREY", "IFCDOOR", "IFCWALLSTANDARDCASE"],
        )

    def test_walks_the_hierarchy_both_ways(self):
        self.assertEqual(
            [node.global_id for node in self.importer.children(WALL.global_id)],
            [DOOR.global_id],
        )
        self.assertEqual(
            [node.global_id for node in self.importer.ancestors(DOOR.global_id)],
            [WALL.global_id, STOREY.global_id],
        )
        self.assertEqual(
            sorted(node.global_id for node in self.importer.descendants(STOREY.global_id)),
            sorted([WALL.global_id, DOOR.global_id]),
        )

    def test_terminates_on_a_cyclic_parent_chain(self):
        cyclic = build(
            nodes=[
                SceneNode(global_id="A1", parent_global_id="B1"),
                SceneNode(global_id="B1", parent_global_id="A1"),
            ]
        )
        # A malformed export must produce a short list rather than hang the importer.
        self.assertEqual(
            [node.global_id for node in SceneImporter(cyclic).ancestors("A1")], ["B1"]
        )

    def test_reads_properties_by_name_and_by_set(self):
        self.assertEqual(self.importer.property(WALL.global_id, "FireRating"), "60")
        self.assertEqual(self.importer.property(WALL.global_id, "NetArea", "Quantities"), 12.5)
        self.assertIsNone(self.importer.property(WALL.global_id, "NetArea", "Pset_WallCommon"))
        self.assertEqual(self.importer.property_sets(DOOR.global_id), [])

    def test_returns_relationship_edges_from_either_end(self):
        self.assertEqual(len(self.importer.relationships(DOOR.global_id)), 1)
        self.assertEqual(
            len(self.importer.relationships(WALL.global_id, "IFCRELVOIDSELEMENT")), 1
        )
        self.assertEqual(len(self.importer.relationships(WALL.global_id, "IFCRELNOTHING")), 0)

    def test_refuses_a_stale_index_on_construction(self):
        broken = build()
        broken.index.by_global_id["0Ghost"] = 0
        with self.assertRaises(ScenePackageError):
            SceneImporter(broken)
        # ...but a caller who knows what they are doing can still inspect it.
        SceneImporter(broken, check_index=False)

    def test_does_not_load_geometry_eagerly(self):
        payload = ScenePayload(
            id="g",
            role="geometry",
            path=payload_path("g", "frag"),
            encoding="application/vnd.thatopen.fragments",
            byte_length=4,
            hash=content_hash(b"FRAG"),
        )
        scene = build(
            payloads=[payload],
            nodes=[SceneNode(global_id=WALL.global_id, payload_id="g")],
        )
        archive = MemoryArchive()
        write_scene_package(archive, scene, {"g": b"FRAG"})

        importer = SceneImporter.open(archive)
        self.assertEqual(importer.payload_ids(), ["g"])
        # The bytes arrive only when asked for.
        self.assertEqual(importer.geometry_for(WALL.global_id), b"FRAG")

    def test_reports_an_absent_archive_rather_than_returning_nothing(self):
        with self.assertRaises(ScenePackageError):
            SceneImporter(self.scene).payload_bytes("g")

    def test_origin_offset_is_uniform_whether_georeferenced_or_not(self):
        self.assertEqual(tuple(self.importer.origin_offset()), (0.0, 0.0, 0.0))
        georeferenced = SceneImporter(
            build(
                geo_reference=GeoReference(
                    source_crs="EPSG:27700", units="m", origin_offset=[530_000, 180_000, 0]
                )
            )
        )
        self.assertEqual(tuple(georeferenced.origin_offset()), (530_000, 180_000, 0))

    def test_summary_describes_the_package_at_a_glance(self):
        summary = self.importer.summary()
        self.assertEqual(summary["nodes"], 3)
        self.assertEqual(summary["units"], "m")
        self.assertEqual(summary["withProperties"], 1)


class GeoTests(unittest.TestCase):
    def test_parses_authority_qualified_codes_only(self):
        self.assertEqual(parse_crs_code("EPSG:27700"), ("EPSG", "27700"))
        self.assertIsNone(parse_crs_code("British National Grid"))
        self.assertIsNone(parse_crs_code("27700"))

    def test_distinguishes_survey_feet_from_international_feet(self):
        # ~2ppm apart, which is metres across a large site.
        self.assertNotEqual(convert_length(1, "ft", "m"), convert_length(1, "us-ft", "m"))


if __name__ == "__main__":
    unittest.main()
