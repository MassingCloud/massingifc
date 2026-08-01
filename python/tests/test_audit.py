"""Conversion fidelity.

Each invariant is tested twice: that a faithful conversion passes it, and that a package with
exactly that thing broken fails it. The second half is the part that matters — an invariant nobody
has watched fail is a comment, not a check.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:
    import ifcopenshell

    HAS_IFCOPENSHELL = True
except ImportError:  # pragma: no cover - environment-dependent
    HAS_IFCOPENSHELL = False

from massingifc_scene import SceneIndex, SceneNode, ScenePackage  # noqa: E402


def _fixture(path: Path, *, orphan: bool = False) -> None:
    """Project → site → building → storey → wall + door, with properties on the wall."""
    ifc = ifcopenshell.file(schema="IFC4")
    units = ifc.create_entity(
        "IfcUnitAssignment",
        Units=[ifc.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")],
    )
    project = ifc.create_entity(
        "IfcProject", GlobalId="0Project000000000000P1", Name="P", UnitsInContext=units
    )
    site = ifc.create_entity("IfcSite", GlobalId="0Site00000000000000S1")
    building = ifc.create_entity("IfcBuilding", GlobalId="0Bldg00000000000000B1")
    storey = ifc.create_entity("IfcBuildingStorey", GlobalId="0Level00000000000000L1")
    wall = ifc.create_entity("IfcWall", GlobalId="1Wall00000000000000W01", Name="Wall")
    door = ifc.create_entity("IfcDoor", GlobalId="2Door00000000000000D01", Name="Door")

    for index, (parent, children) in enumerate(
        [(project, [site]), (site, [building]), (building, [storey])], 1
    ):
        ifc.create_entity(
            "IfcRelAggregates",
            GlobalId=f"0Agg000000000000000A{index}",
            RelatingObject=parent,
            RelatedObjects=children,
        )
    ifc.create_entity(
        "IfcRelContainedInSpatialStructure",
        GlobalId="0Cont0000000000000C1",
        RelatingStructure=storey,
        RelatedElements=[wall, door],
    )
    ifc.create_entity(
        "IfcRelDefinesByProperties",
        GlobalId="0Def000000000000000D1",
        RelatedObjects=[wall],
        RelatingPropertyDefinition=ifc.create_entity(
            "IfcPropertySet",
            GlobalId="0Pset00000000000000P1",
            Name="Pset_WallCommon",
            HasProperties=[
                ifc.create_entity(
                    "IfcPropertySingleValue",
                    Name="IsExternal",
                    NominalValue=ifc.create_entity("IfcBoolean", True),
                )
            ],
        ),
    )

    if orphan:
        # In the file, linked to nothing, so the spatial walk never reaches it.
        ifc.create_entity("IfcWall", GlobalId="9Orphan000000000000O1", Name="Orphan")

    ifc.write(str(path))


def _rebuilt(scene: ScenePackage, nodes) -> ScenePackage:
    """A package with different nodes and an index rebuilt to match, so only the change under
    test differs from a faithful one."""
    by_class, by_level, by_global_id = {}, {}, {}
    for position, node in enumerate(nodes):
        by_global_id[node.global_id] = position
        if node.ifc_class is not None:
            by_class.setdefault(node.ifc_class, []).append(position)
        if node.level_global_id is not None:
            by_level.setdefault(node.level_global_id, []).append(position)
    return replace(
        scene,
        nodes=nodes,
        index=SceneIndex(by_class=by_class, by_level=by_level, by_global_id=by_global_id),
    )


@unittest.skipUnless(HAS_IFCOPENSHELL, "ifcopenshell is not installed")
class AuditTests(unittest.TestCase):
    def setUp(self):
        from massingifc_ifc import convert_ifc

        self._directory = tempfile.TemporaryDirectory()
        self.path = Path(self._directory.name) / "fixture.ifc"
        _fixture(self.path)
        self.scene, _ = convert_ifc(
            self.path, generated_at="2026-07-27T12:00:00.000Z"
        )

    def tearDown(self):
        self._directory.cleanup()

    def audit(self, scene=None, path=None):
        from massingifc_ifc import audit_conversion

        return audit_conversion(path or self.path, scene if scene is not None else self.scene)

    def codes(self, report):
        return [issue.code for issue in report.issues]

    # -- the happy case -----------------------------------------------------------------

    def test_a_faithful_conversion_passes(self):
        report = self.audit()
        self.assertTrue(report.faithful, [issue.message for issue in report.issues])
        self.assertEqual(report.issues, [])
        # Five products — site, building, storey, wall, door. `IfcProject` is a context, not a
        # product, so the package carries one node more than the file carries products.
        self.assertEqual(report.products_in_source, 5)
        self.assertEqual(report.products_in_package, 5)
        self.assertEqual(report.nodes_in_package, 6)
        self.assertIn("5/5", report.summary())

    # -- 1. accounting ------------------------------------------------------------------

    def test_counts_products_that_never_reached_the_package(self):
        with tempfile.TemporaryDirectory() as directory:
            from massingifc_ifc import convert_ifc

            path = Path(directory) / "orphan.ifc"
            _fixture(path, orphan=True)
            scene, _ = convert_ifc(path, generated_at="t")

            report = self.audit(scene=scene, path=path)
            # A missing element is sometimes legitimate; being silent about it never is.
            self.assertIn("product-not-in-package", self.codes(report))
            self.assertTrue(report.faithful)
            self.assertEqual(report.products_in_source, 6)
            self.assertEqual(report.products_in_package, 5)

    def test_catches_an_element_dropped_from_the_package(self):
        kept = [node for node in self.scene.nodes if node.global_id != "2Door00000000000000D01"]
        report = self.audit(scene=_rebuilt(self.scene, kept))

        # Reported as absent. Not a class-count error, deliberately: that check is scoped to
        # elements that did arrive, so an element missing from both sides is not a mismatch — it
        # is the accounting line above, which is where a reader should look for it.
        self.assertIn("product-not-in-package", self.codes(report))
        self.assertNotIn("class-count-mismatch", self.codes(report))
        self.assertEqual(report.products_in_package, 4)

    # -- 2. class counts ----------------------------------------------------------------

    def test_catches_an_element_missing_from_the_class_index(self):
        # Present, addressable, and invisible to the filter an engine actually uses.
        broken = replace(
            self.scene,
            index=SceneIndex(
                by_class={
                    key: value
                    for key, value in self.scene.index.by_class.items()
                    if key != "IFCDOOR"
                },
                by_level=self.scene.index.by_level,
                by_global_id=self.scene.index.by_global_id,
            ),
        )
        report = self.audit(scene=broken)

        self.assertIn("class-count-mismatch", self.codes(report))
        self.assertFalse(report.faithful)

    def test_catches_a_misclassified_element(self):
        nodes = [
            replace(node, ifc_class="IFCBEAM") if node.global_id == "1Wall00000000000000W01" else node
            for node in self.scene.nodes
        ]
        report = self.audit(scene=_rebuilt(self.scene, nodes))

        self.assertIn("class-count-mismatch", self.codes(report))
        self.assertFalse(report.faithful)

    # -- 3. semantics -------------------------------------------------------------------

    def test_catches_property_sets_that_did_not_survive(self):
        broken = replace(self.scene, properties={})
        report = self.audit(scene=broken)

        # The quietest possible failure: the element is still there, still the right shape, and
        # simply knows nothing about itself.
        self.assertIn("properties-lost", self.codes(report))
        self.assertFalse(report.faithful)

    def test_says_nothing_about_properties_that_were_never_requested(self):
        from massingifc_ifc import convert_ifc

        scene, _ = convert_ifc(self.path, generated_at="t", include_properties=False)
        report = self.audit(scene=scene)

        self.assertNotIn("properties-lost", self.codes(report))
        self.assertTrue(report.faithful)

    # -- 4. containment -----------------------------------------------------------------

    def test_catches_an_element_reparented_away_from_its_container(self):
        nodes = [
            replace(node, parent_global_id="0Bldg00000000000000B1")
            if node.global_id == "1Wall00000000000000W01"
            else node
            for node in self.scene.nodes
        ]
        report = self.audit(scene=_rebuilt(self.scene, nodes))

        # The file says the wall is in the storey. The package says otherwise, so level filtering
        # and the spatial tree are quietly wrong.
        self.assertIn("containment-lost", self.codes(report))
        self.assertFalse(report.faithful)

    def test_accepts_a_container_that_is_an_ancestor_rather_than_the_parent(self):
        # Containment is about the chain, not about being the immediate parent: an intermediate
        # assembly between the wall and its storey is legitimate.
        nodes = list(self.scene.nodes) + [
            SceneNode(
                global_id="8Assembly0000000000A1",
                ifc_class="IFCELEMENTASSEMBLY",
                parent_global_id="0Level00000000000000L1",
            )
        ]
        nodes = [
            replace(node, parent_global_id="8Assembly0000000000A1")
            if node.global_id == "1Wall00000000000000W01"
            else node
            for node in nodes
        ]
        report = self.audit(scene=_rebuilt(self.scene, nodes))

        self.assertNotIn("containment-lost", self.codes(report))


if __name__ == "__main__":
    unittest.main()
