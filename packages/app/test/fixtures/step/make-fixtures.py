# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Writes the STEP test fixtures in this folder with build123d (Apache-2.0) on OpenCASCADE.
#   python3 -m venv venv && venv/bin/pip install build123d && venv/bin/python make-fixtures.py
# The models are ours, made here, and carry the license of the tests. empty.step is written by hand.
import re
from pathlib import Path
from build123d import Align, Axis, Box, BuildPart, Compound, Cylinder, Hole, Locations, Pos, export_step, fillet

here = Path(__file__).parent


def stamp(text):
    """A fixed time stamp, so writing the files again changes nothing."""
    return re.sub(r"(FILE_NAME\([^,]*,)'[0-9T:-]+'", lambda m: m.group(1) + "'2026-10-02T00:00:00'", text)


# Two bodies that touch (a post standing on a base) and one apart from them.
base = Box(20, 20, 5, align=(Align.CENTER, Align.CENTER, Align.MIN))
base.label = "base"
post = Pos(0, 0, 5) * Cylinder(6, 20, align=(Align.CENTER, Align.CENTER, Align.MIN))
post.label = "post"
cube = Pos(30, 0, 0) * Box(10, 10, 10, align=(Align.CENTER, Align.CENTER, Align.MIN))
cube.label = "cube"
export_step(Compound(label="widget", children=[base, post, cube]), str(here / "assembly.step"))
(here / "assembly.step").write_text(stamp((here / "assembly.step").read_text()))

# A 2 x 1 x 0.25 inch bracket with rounded corners and a hole, saved in inches. OpenCASCADE writes
# millimeters only, so the part is modeled in inch numbers and the file's length unit is then changed
# to the standard conversion based inch.
with BuildPart() as bracket:
    Box(2, 1, 0.25)
    fillet(bracket.edges().filter_by(Axis.Z), 0.125)
    with Locations((0.5, 0, 0.125)):
        Hole(0.125)
bracket.part.label = "bracket"
tmp = here / "bracket-tmp.step"
export_step(bracket.part, str(tmp))
s = tmp.read_text()
tmp.unlink()
m = re.search(r"#(\d+) = \( LENGTH_UNIT\(\) NAMED_UNIT\(\*\) SI_UNIT\(\.MILLI\.,\.METRE\.\) \);", s)
top = max(int(x) for x in re.findall(r"^#(\d+) =", s, re.M))
a, b, c = top + 1, top + 2, top + 3
s = s.replace(m.group(0), f"#{m.group(1)} = ( CONVERSION_BASED_UNIT('INCH',#{a}) LENGTH_UNIT() NAMED_UNIT(#{b}) );")
extra = (
    f"#{a} = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#{c});\n"
    f"#{b} = DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);\n"
    f"#{c} = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );\n"
)
i = s.rindex("ENDSEC;")
(here / "bracket-inch.stp").write_text(stamp(s[:i] + extra + s[i:]))
