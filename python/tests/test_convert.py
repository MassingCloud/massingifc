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


@unittest.skipUnless(HAS_IFCOPENSHELL, "ifcopenshell is not installed")
class UnitTests(unittest.TestCase):
    """Length units, which the converter used to guess at."""

    def setUp(self):
        import tempfile

        self._directory = tempfile.TemporaryDirectory()
        self.root = Path(self._directory.name)

    def tearDown(self):
        self._directory.cleanup()

    def _write(self, name, make_unit):
        path = self.root / name
        ifc = ifcopenshell.file(schema="IFC4")
        units = None
        if make_unit is not None:
            units = ifc.create_entity("IfcUnitAssignment", Units=[make_unit(ifc)])
        ifc.create_entity(
            "IfcProject", GlobalId="0Project000000000000P1", Name="P", UnitsInContext=units
        )
        ifc.write(str(path))
        return path

    @staticmethod
    def _conversion(name, factor):
        def make(ifc):
            metre = ifc.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")
            measure = ifc.create_entity(
                "IfcMeasureWithUnit",
                ValueComponent=ifc.create_entity("IfcLengthMeasure", factor),
                UnitComponent=metre,
            )
            return ifc.create_entity(
                "IfcConversionBasedUnit",
                UnitType="LENGTHUNIT",
                Name=name,
                ConversionFactor=measure,
                Dimensions=ifc.create_entity("IfcDimensionalExponents", 1, 0, 0, 0, 0, 0, 0),
            )

        return make

    def convert(self, path, **kwargs):
        from massingifc_ifc import convert_ifc

        return convert_ifc(path, generated_at="2026-07-27T12:00:00.000Z", **kwargs)

    def test_reads_feet_rather_than_assuming_metres(self):
        # The norm on a US project. Assuming metres scales the whole model by 3.28 silently.
        path = self._write("imperial.ifc", self._conversion("foot", 0.3048))
        scene, _ = self.convert(path)
        self.assertEqual(scene.source_units, "ft")

    def test_distinguishes_survey_feet_from_international_feet(self):
        path = self._write("survey.ifc", self._conversion("US survey foot", 1200 / 3937))
        scene, _ = self.convert(path)
        self.assertEqual(scene.source_units, "us-ft")

    def test_reads_millimetres(self):
        def milli(ifc):
            return ifc.create_entity(
                "IfcSIUnit", UnitType="LENGTHUNIT", Prefix="MILLI", Name="METRE"
            )

        scene, _ = self.convert(self._write("mm.ifc", milli))
        self.assertEqual(scene.source_units, "mm")

    def test_refuses_a_prefix_the_format_cannot_express(self):
        from massingifc_ifc.convert import UnknownUnitError

        def deci(ifc):
            return ifc.create_entity(
                "IfcSIUnit", UnitType="LENGTHUNIT", Prefix="DECI", Name="METRE"
            )

        path = self._write("deci.ifc", deci)
        # Previously reported as metres — a silent 10x error.
        with self.assertRaises(UnknownUnitError):
            self.convert(path)

    def test_refuses_an_unrecognised_conversion_factor(self):
        from massingifc_ifc.convert import UnknownUnitError

        path = self._write("cubit.ifc", self._conversion("cubit", 0.4572))
        with self.assertRaises(UnknownUnitError):
            self.convert(path)

    def test_refuses_a_file_with_no_declared_unit(self):
        from massingifc_ifc.convert import UnknownUnitError

        with self.assertRaises(UnknownUnitError):
            self.convert(self._write("none.ifc", None))

    def test_lets_the_caller_state_the_unit_explicitly(self):
        # Refusing must not become a wall: a caller who knows can say so.
        scene, _ = self.convert(self._write("none2.ifc", None), assume_units="ft")
        self.assertEqual(scene.source_units, "ft")


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(HAS_IFCOPENSHELL, "ifcopenshell is not installed")
class ReportingTests(unittest.TestCase):
    """Things the converter must say out loud rather than handle silently."""

    def setUp(self):
        import tempfile

        self._directory = tempfile.TemporaryDirectory()
        self.root = Path(self._directory.name)

    def tearDown(self):
        self._directory.cleanup()

    def _model(self, name, *, orphan=False, colliding_set=False):
        path = self.root / name
        ifc = ifcopenshell.file(schema="IFC4")
        units = ifc.create_entity(
            "IfcUnitAssignment",
            Units=[ifc.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")],
        )
        project = ifc.create_entity(
            "IfcProject", GlobalId="0Project000000000000P1", UnitsInContext=units
        )
        site = ifc.create_entity("IfcSite", GlobalId="0Site00000000000000S1")
        building = ifc.create_entity("IfcBuilding", GlobalId="0Bldg00000000000000B1")
        storey = ifc.create_entity("IfcBuildingStorey", GlobalId="0Level00000000000000L1")
        wall = ifc.create_entity("IfcWall", GlobalId="1Wall00000000000000W01", Name="W")
        for index, (parent, kids) in enumerate(
            [(project, [site]), (site, [building]), (building, [storey])], 1
        ):
            ifc.create_entity(
                "IfcRelAggregates",
                GlobalId=f"0Agg000000000000000A{index}",
                RelatingObject=parent,
                RelatedObjects=kids,
            )
        ifc.create_entity(
            "IfcRelContainedInSpatialStructure",
            GlobalId="0Cont0000000000000C1",
            RelatingStructure=storey,
            RelatedElements=[wall],
        )

        if orphan:
            # In the file, but linked to nothing — so the spatial walk never sees it.
            ifc.create_entity("IfcWall", GlobalId="9Orphan000000000000O1", Name="Orphan")

        if colliding_set:
            pset = ifc.create_entity(
                "IfcPropertySet",
                GlobalId="0Pset00000000000000P1",
                Name="Quantities",
                HasProperties=[
                    ifc.create_entity(
                        "IfcPropertySingleValue",
                        Name="Note",
                        NominalValue=ifc.create_entity("IfcLabel", "authored"),
                    )
                ],
            )
            qto = ifc.create_entity(
                "IfcElementQuantity",
                GlobalId="0Qto000000000000000Q1",
                Name="Qto_WallBaseQuantities",
                Quantities=[ifc.create_entity("IfcQuantityArea", Name="NetArea", AreaValue=12.5)],
            )
            for index, definition in enumerate((pset, qto), 1):
                ifc.create_entity(
                    "IfcRelDefinesByProperties",
                    GlobalId=f"0Def000000000000000D{index}",
                    RelatedObjects=[wall],
                    RelatingPropertyDefinition=definition,
                )

        ifc.write(str(path))
        return path

    def convert(self, path, **kwargs):
        from massingifc_ifc import convert_ifc

        return convert_ifc(path, generated_at="2026-07-27T12:00:00.000Z", **kwargs)

    def test_reports_products_the_spatial_walk_never_reached(self):
        warnings = []
        scene, _ = self.convert(
            self._model("orphan.ifc", orphan=True), on_warning=warnings.append
        )

        # An element that silently fails to arrive is the same class of problem as a silently
        # assumed unit: quiet, wrong, and discovered somewhere else entirely.
        self.assertNotIn("9Orphan000000000000O1", SceneImporter(scene))
        self.assertEqual(len(warnings), 1)
        self.assertIn("9Orphan000000000000O1", warnings[0])

    def test_says_nothing_when_every_product_is_reachable(self):
        warnings = []
        self.convert(self._model("clean.ifc"), on_warning=warnings.append)
        self.assertEqual(warnings, [])

    def test_merges_quantities_into_a_property_set_of_the_same_name(self):
        scene, _ = self.convert(self._model("collide.ifc", colliding_set=True))
        importer = SceneImporter(scene)
        names = [entry.name for entry in importer.property_sets("1Wall00000000000000W01")]

        # Two sets sharing a name means any consumer keying a dictionary by it loses one.
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(importer.property("1Wall00000000000000W01", "Note", "Quantities"), "authored")
        self.assertEqual(importer.property("1Wall00000000000000W01", "NetArea", "Quantities"), 12.5)
