"""IFC to scene package, server-side.

Converting in Python rather than in the browser is the arrangement the architecture already assumes:
IFC is converted once, somewhere with time and memory, and clients load the result. Doing it per
session pushes a heavy parse into every user's tab.

This produces the *semantic* half of a package directly from IFC — identity, hierarchy, classes,
property sets, quantities, georeference. Geometry is attached separately by whatever produced the
Fragments binary, because re-tessellating here would invent a parallel format and lose the
per-element addressing Fragments already carries. ``geometry=`` takes those bytes when you have
them.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from massingifc_scene import (
    FRAGMENTS_ENCODING,
    GeoReference,
    ScenePackage,
    ScenePackageError,
    SceneNode,
    ScenePayload,
    ScenePropertySet,
    SceneRelationship,
    SceneSource,
    build_scene_package,
    content_hash,
    payload_path,
)

#: IFC length units mapped onto the format's linear units.
_UNIT_NAMES = {
    "MILLI": "mm",
    "CENTI": "cm",
    "METRE": "m",
}

#: Classes whose GlobalId is stamped onto everything beneath them as `levelGlobalId`.
_STOREY = "IfcBuildingStorey"

#: Spatial containers that structure the tree but are not building elements themselves.
_SPATIAL = ("IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey", "IfcSpace")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _length_unit(ifc_file: Any) -> str:
    """Read the project's length unit. Defaults to metres, which IFC also does."""
    for assignment in ifc_file.by_type("IfcUnitAssignment"):
        for unit in assignment.Units or ():
            if getattr(unit, "UnitType", None) != "LENGTHUNIT":
                continue
            name = getattr(unit, "Name", None)
            prefix = getattr(unit, "Prefix", None)
            if name == "METRE":
                return _UNIT_NAMES.get(prefix or "METRE", "m")
    return "m"


def _scalar(value: Any) -> Optional[Any]:
    """Reduce an IFC value to something JSON can hold, or ``None`` if it cannot.

    Non-scalars are dropped rather than stringified: a consumer reading ``"[object Object]"`` or
    a Python ``repr`` cannot tell it from a real value, but an absent key it can.
    """
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    wrapped = getattr(value, "wrappedValue", None)
    if wrapped is not None and isinstance(wrapped, (str, int, float, bool)):
        return wrapped
    return None


def _property_sets(element: Any) -> List[ScenePropertySet]:
    """Property sets and element quantities, kept unflattened as the model has them."""
    sets: List[ScenePropertySet] = []
    quantities: Dict[str, Any] = {}

    for relation in getattr(element, "IsDefinedBy", None) or ():
        definition = getattr(relation, "RelatingPropertyDefinition", None)
        if definition is None:
            continue

        name = getattr(definition, "Name", None) or "Unnamed"

        values: Dict[str, Any] = {}
        for prop in getattr(definition, "HasProperties", None) or ():
            scalar = _scalar(getattr(prop, "NominalValue", None))
            if scalar is not None and getattr(prop, "Name", None):
                values[prop.Name] = scalar

        for quantity in getattr(definition, "Quantities", None) or ():
            label = getattr(quantity, "Name", None)
            if not label:
                continue
            for attribute in (
                "AreaValue",
                "VolumeValue",
                "LengthValue",
                "CountValue",
                "WeightValue",
                "TimeValue",
            ):
                measured = getattr(quantity, attribute, None)
                if measured is not None:
                    values[label] = measured
                    if isinstance(measured, (int, float)):
                        quantities[label] = measured
                    break

        if values:
            sets.append(ScenePropertySet(name=name, properties=values))

    if quantities:
        # Hoisted as well as left in place: takeoff wants them by name as numbers, a property
        # panel wants them where IFC put them.
        sets.append(ScenePropertySet(name="Quantities", properties=quantities))

    return sets


def _contained(structure: Any) -> List[Any]:
    """Elements a spatial structure contains, plus the structures nested inside it."""
    children: List[Any] = []
    for relation in getattr(structure, "ContainsElements", None) or ():
        children.extend(relation.RelatedElements or ())
    for relation in getattr(structure, "IsDecomposedBy", None) or ():
        children.extend(relation.RelatedObjects or ())
    return children


def convert_ifc(
    path: Path | str,
    *,
    model_id: Optional[str] = None,
    generated_at: Optional[str] = None,
    include_properties: bool = True,
    include_relationships: bool = True,
    geometry: Optional[bytes] = None,
    geo_reference: Optional[GeoReference] = None,
) -> Tuple[ScenePackage, Mapping[str, bytes]]:
    """Convert an IFC file into a package and its payload bytes.

    Returns both together, because a manifest naming payloads nobody can supply is a promise rather
    than a package.
    """
    try:
        import ifcopenshell  # noqa: PLC0415 - optional, and only this function needs it
    except ImportError as exc:  # pragma: no cover - environment-dependent
        raise ScenePackageError(
            "Converting IFC needs ifcopenshell; the reader half of this library does not."
        ) from exc

    source = Path(path)
    if not source.is_file():
        raise ScenePackageError(f"No IFC file at {source}")

    ifc_file = ifcopenshell.open(str(source))
    identifier = model_id or source.stem

    nodes: List[SceneNode] = []
    relationships: List[SceneRelationship] = []
    properties: Dict[str, List[ScenePropertySet]] = {}
    seen: set[str] = set()

    def visit(entity: Any, parent: Optional[str], level: Optional[str]) -> None:
        global_id = getattr(entity, "GlobalId", None)
        ifc_class = entity.is_a()
        next_level = level

        if global_id:
            if ifc_class == _STOREY:
                next_level = global_id

            if global_id not in seen:
                seen.add(global_id)
                nodes.append(
                    SceneNode(
                        global_id=global_id,
                        name=getattr(entity, "Name", None) or None,
                        ifc_class=ifc_class.upper(),
                        parent_global_id=parent,
                        # A storey is not on its own level.
                        level_global_id=next_level if next_level != global_id else None,
                    )
                )
                if parent is not None and include_relationships:
                    relationships.append(
                        SceneRelationship(
                            type="IFCRELCONTAINEDINSPATIALSTRUCTURE",
                            from_global_id=parent,
                            to_global_id=global_id,
                        )
                    )
                if include_properties:
                    sets = _property_sets(entity)
                    if sets:
                        properties[global_id] = sets

            parent = global_id

        for child in _contained(entity):
            visit(child, parent, next_level)

    roots = ifc_file.by_type("IfcProject")
    if not roots:
        raise ScenePackageError("This IFC file declares no IfcProject, so it has no spatial root.")
    for root in roots:
        visit(root, None, None)

    payloads: List[ScenePayload] = []
    payload_bytes: Dict[str, bytes] = {}
    if geometry is not None:
        payload_id = f"geometry-{identifier}"
        payloads.append(
            ScenePayload(
                id=payload_id,
                role="geometry",
                path=payload_path(payload_id, "frag"),
                encoding=FRAGMENTS_ENCODING,
                byte_length=len(geometry),
                hash=content_hash(geometry),
            )
        )
        payload_bytes[payload_id] = geometry
        nodes = [
            SceneNode(**{**node.__dict__, "payload_id": payload_id}) for node in nodes
        ]

    scene = build_scene_package(
        generator=f"massingifc-ifc/{ifcopenshell.version}",
        generated_at=generated_at or _now(),
        sources=[
            SceneSource(
                model_id=identifier,
                model_name=source.name,
                revision=getattr(ifc_file, "schema", None),
            )
        ],
        source_units=_length_unit(ifc_file),
        geo_reference=geo_reference,
        nodes=nodes,
        payloads=payloads,
        properties=properties or None,
        relationships=relationships if include_relationships else None,
    )
    return scene, payload_bytes
