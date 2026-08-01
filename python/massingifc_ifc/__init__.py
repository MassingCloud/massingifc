"""``massingifc_ifc`` — IFC to scene package, using IfcOpenShell.

Split from ``massingifc_scene`` so the reader half stays dependency-free: an engine importer or a
CI check should not have to install an IFC toolkit to open a package.
"""

from .convert import convert_ifc

__all__ = ["convert_ifc"]
