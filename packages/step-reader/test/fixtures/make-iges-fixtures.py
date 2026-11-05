# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Writes the IGES test fixtures in this folder with build123d (Apache-2.0) on OpenCASCADE.
#   python3 -m venv venv && venv/bin/pip install build123d && venv/bin/python make-iges-fixtures.py
# The models are ours, made here, and carry the license of the tests. Time stamps and the author in the global section
# are fixed (stable below); the writer may still list name entities in another order from run to run, which reads the
# same.
import re
from pathlib import Path
from build123d import Align, Axis, Box, BuildPart, Cylinder, Hole, Locations, Pos, fillet
from OCP.IGESCAFControl import IGESCAFControl_Writer
from OCP.IGESControl import IGESControl_Controller, IGESControl_Writer
from OCP.Interface import Interface_Static
from OCP.Quantity import Quantity_Color, Quantity_TOC_sRGB
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.XCAFDoc import XCAFDoc_ColorGen, XCAFDoc_DocumentTool

here = Path(__file__).parent
# Defines the write.iges settings, which are set below.
IGESControl_Controller.Init_s()


def stable(path):
    """Fixes the dates and the author in the global section, so writing the files again changes nothing."""
    text = path.read_text()
    # Dates, as YYYYMMDD.HHNNSS or YYMMDD.HHNNSS.
    text = re.sub(r"15H\d{8}\.\d{6}", "15H20261105.000000", text)
    text = re.sub(r"13H\d{6}\.\d{6}", "13H261105.000000", text)
    # The author field holds the login of whoever ran this; the fixtures name SlicerX instead, at the same length so
    # the 80 column records keep their layout.
    user = re.search(r",(\d+)H([^,;]*),,11,", text)
    if user:
        assert int(user.group(1)) == len("SlicerX"), "pad the author to 7 characters: the records are fixed width"
        text = text.replace(user.group(0), ",7HSlicerX,,11,")
    path.write_text(text)


def write(path, parts):
    """Writes `parts`, a list of (shape, name, sRGB color or None), as solids (entity 186) with names and colors, in mm."""
    assert Interface_Static.SetIVal_s("write.iges.brep.mode", 1)
    doc = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    colors = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    for shape, name, rgb in parts:
        label = shapes.AddShape(shape.wrapped, False)
        TDataStd_Name.Set_s(label, TCollection_ExtendedString(name))
        if rgb:
            colors.SetColor(label, Quantity_Color(*rgb, Quantity_TOC_sRGB), XCAFDoc_ColorGen)
    writer = IGESCAFControl_Writer()
    writer.SetColorMode(True)
    writer.SetNameMode(True)
    assert writer.Transfer(doc)
    assert writer.Write(str(path))
    stable(path)


def write_faces(path, shapes, unit):
    """Writes each face of `shapes` as a loose trimmed surface (entity 144), in `unit`, as many CAD programs do."""
    writer = IGESControl_Writer(unit, 0)
    for shape in shapes:
        assert writer.AddShape(shape.wrapped)
    writer.ComputeModel()
    assert writer.Write(str(path))
    stable(path)


# Two bodies that touch (a post standing on a base) and one apart from them, as solids, with a red base and a blue
# cube; the post has no color of its own.
base = Box(20, 20, 5, align=(Align.CENTER, Align.CENTER, Align.MIN))
post = Pos(0, 0, 5) * Cylinder(6, 20, align=(Align.CENTER, Align.CENTER, Align.MIN))
cube = Pos(30, 0, 0) * Box(10, 10, 10, align=(Align.CENTER, Align.CENTER, Align.MIN))
write(here / "assembly.igs", [(base, "base", (1.0, 0.0, 0.0)), (post, "post", None), (cube, "cube", (0.0, 0.25, 1.0))])

# A 2 x 1 x 0.25 inch bracket with rounded corners and a hole, saved in inches as loose trimmed surfaces, the way most
# IGES files reach a slicer.
with BuildPart() as bracket:
    Box(2 * 25.4, 1 * 25.4, 0.25 * 25.4)
    fillet(bracket.edges().filter_by(Axis.Z), 0.125 * 25.4)
    with Locations((0.5 * 25.4, 0, 0.125 * 25.4)):
        Hole(0.125 * 25.4)
write_faces(here / "bracket-inch.iges", [bracket.part], "IN")

# Two 10 mm cubes 20 mm apart, each face its own loose surface: the file has no solids and two separate groups of
# touching surfaces.
cubes = [Pos(x, 0, 0) * Box(10, 10, 10, align=(Align.CENTER, Align.CENTER, Align.MIN)) for x in (0, 30)]
write_faces(here / "cubes-faces.igs", [face for c in cubes for face in c.faces()], "MM")

# Two 100 mm boxes 50 mm apart, each face a loose surface. The first box's top sits 0.005 mm above its sides, a gap
# that closes at the reader's sewing tolerance (scaled to the model) and not at OpenCASCADE's default of 0.000001 mm;
# the second box has no top, so it cannot close.
boxes = [Pos(x, 0, 0) * Box(100, 100, 100, align=(Align.CENTER, Align.CENTER, Align.MIN)) for x in (0, 150)]
lifted = boxes[0].faces().sort_by(Axis.Z)
open_box = boxes[1].faces().sort_by(Axis.Z)
write_faces(here / "boxes-gap-open.igs", [*lifted[:-1], Pos(0, 0, 0.005) * lifted[-1], *open_box[:-1]], "MM")
