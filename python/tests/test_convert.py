"""IFC to scene package.

The fixture is built with ifcopenshell rather than committed as a file: a generated model is
readable in the test that depends on it, and there is no binary in the repository whose contents
nobody can see.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
    import ifcopenshell

    HAS_IFCOPENSHELL = True
except ImportError:  # pragma: no cover - environment-dependent
    HAS_IFCOPENSHELL = False

from massingifc_scene import (  # noqa: E402
    MemoryArchive,
    SceneImporter,
    validate_scene_package,
    write_scene_package,
)


def _build_fixture(path: Path) -> None:
    """A minimal but structurally honest IFC: project, site, building, storey, wall, door."""
    ifc = ifcopenshell.file(schema="IFC4")

    millimetre = ifc.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Prefix="MILLI", Name="METRE")
    units = ifc.create_entity("IfcUnitAssignment", Units=[millimetre])

    project = ifc.create_entity(
        "IfcProject", GlobalId="0Project000000000000P1", Name="Fixture", UnitsInContext=units
    )
    site = ifc.create_entity("IfcSite", GlobalId="0Site00000000000000S1", Name="Site")
    building = ifc.create_entity("IfcBuilding", GlobalId="0Bldg00000000000000B1", Name="Building")
    storey = ifc.create_entity(
        "IfcBuildingStorey", GlobalId="0Level00000000000000L1", Name="Level 1"
    )
    wall = ifc.create_entity(
        "IfcWall", GlobalId="1Wall00000000000000W01", Name="External wall"
    )
    door = ifc.create_entity("IfcDoor", GlobalId="2Door00000000000000D01", Name="Entrance door")

    def aggregate(parent, children, index):
        ifc.create_entity(
            "IfcRelAggregates",
            GlobalId=f"0Agg000000000000000A{index}",
            RelatingObject=parent,
            RelatedObjects=children,
        )

    aggregate(project, [site], 1)
    aggregate(site, [building], 2)
    aggregate(building, [storey], 3)

    ifc.create_entity(
        "IfcRelContainedInSpatialStructure",
        GlobalId="0Contain00000000000C1",
        RelatingStructure=storey,
        RelatedElements=[wall, door],
    )

    properties = ifc.create_entity(
        "IfcPropertySet",
        GlobalId="0Pset00000000000000P1",
        Name="Pset_WallCommon",
        HasProperties=[
            ifc.create_entity(
                "IfcPropertySingleValue",
                Name="IsExternal",
                NominalValue=ifc.create_entity("IfcBoolean", True),
            ),
            ifc.create_entity(
                "IfcPropertySingleValue",
                Name="FireRating",
                NominalValue=ifc.create_entity("IfcLabel", "60"),
            ),
        ],
    )
    quantities = ifc.create_entity(
        "IfcElementQuantity",
        GlobalId="0Qto000000000000000Q1",
        Name="Qto_WallBaseQuantities",
        Quantities=[
            ifc.create_entity("IfcQuantityArea", Name="NetArea", AreaValue=12.5),
        ],
    )
    for definition, index in ((properties, 1), (quantities, 2)):
        ifc.create_entity(
            "IfcRelDefinesByProperties",
            GlobalId=f"0Def000000000000000D{index}",
            RelatedObjects=[wall],
            RelatingPropertyDefinition=definition,
        )

    ifc.write(str(path))


@unittest.skipUnless(HAS_IFCOPENSHELL, "ifcopenshell is not installed")
class ConvertTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import tempfile

        cls._directory = tempfile.TemporaryDirectory()
        cls.path = Path(cls._directory.name) / "fixture.ifc"
        _build_fixture(cls.path)

    @classmethod
    def tearDownClass(cls):
        cls._directory.cleanup()

    def convert(self, **kwargs):
        from massingifc_ifc import convert_ifc

        return convert_ifc(self.path, generated_at="2026-07-27T12:00:00.000Z", **kwargs)

    def test_produces_a_package_keyed_by_global_id(self):
        scene, _ = self.convert()
        importer = SceneImporter(scene)

        self.assertIn("1Wall00000000000000W01", importer)
        self.assertEqual(importer.node("1Wall00000000000000W01").name, "External wall")
        self.assertEqual(importer.node("1Wall00000000000000W01").ifc_class, "IFCWALL")

    def test_reads_the_project_length_unit(self):
        scene, _ = self.convert()
        # Authored in millimetres; everything leaves in metres regardless.
        self.assertEqual(scene.source_units, "mm")
        self.assertEqual(scene.units, "m")

    def test_stamps_the_containing_storey_down_the_tree(self):
        importer = SceneImporter(self.convert()[0])
        self.assertEqual(
            sorted(node.global_id for node in importer.by_level("0Level00000000000000L1")),
            ["1Wall00000000000000W01", "2Door00000000000000D01"],
        )
        # A storey is not on its own level.
        self.assertIsNone(importer.node("0Level00000000000000L1").level_global_id)

    def test_preserves_the_spatial_hierarchy(self):
        importer = SceneImporter(self.convert()[0])
        self.assertEqual(
            [node.global_id for node in importer.ancestors("1Wall00000000000000W01")],
            [
                "0Level00000000000000L1",
                "0Bldg00000000000000B1",
                "0Site00000000000000S1",
                "0Project000000000000P1",
            ],
        )

    def test_carries_property_sets_and_hoists_quantities(self):
        importer = SceneImporter(self.convert()[0])
        self.assertIs(importer.property("1Wall00000000000000W01", "IsExternal"), True)
        self.assertEqual(importer.property("1Wall00000000000000W01", "FireRating"), "60")
        # In its own set as IFC has it, and hoisted as a number for takeoff.
        self.assertEqual(
            importer.property("1Wall00000000000000W01", "NetArea", "Qto_WallBaseQuantities"), 12.5
        )
        self.assertEqual(importer.property("1Wall00000000000000W01", "NetArea", "Quantities"), 12.5)

    def test_omits_properties_and_relationships_when_not_asked(self):
        scene, _ = self.convert(include_properties=False, include_relationships=False)
        self.assertIsNone(scene.properties)
        self.assertIsNone(scene.relationships)

    def test_attaches_geometry_when_supplied(self):
        scene, payloads = self.convert(geometry=b"FRAGMENTS")
        importer = SceneImporter(scene)

        self.assertEqual(len(scene.payloads), 1)
        self.assertEqual(scene.payloads[0].encoding, "application/vnd.thatopen.fragments")
        self.assertEqual(payloads[scene.payloads[0].id], b"FRAGMENTS")
        self.assertEqual(
            importer.node("1Wall00000000000000W01").payload_id, scene.payloads[0].id
        )

    def test_the_result_passes_validation_and_round_trips(self):
        scene, payloads = self.convert(geometry=b"FRAGMENTS")
        report = validate_scene_package(scene)
        self.assertTrue(report.valid, [issue.message for issue in report.issues])

        archive = MemoryArchive()
        write_scene_package(archive, scene, payloads)
        reopened = SceneImporter.open(archive)
        self.assertEqual(len(reopened), len(scene.nodes))
        self.assertEqual(reopened.geometry_for("1Wall00000000000000W01"), b"FRAGMENTS")

    def test_reports_a_missing_file_rather_than_throwing_an_io_error(self):
        from massingifc_ifc import convert_ifc
        from massingifc_scene import ScenePackageError

        with self.assertRaises(ScenePackageError):
            convert_ifc(self.path.parent / "absent.ifc")


if __name__ == "__main__":
    unittest.main()
