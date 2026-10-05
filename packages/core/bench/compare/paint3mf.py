# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Builds small painted 3MF files (Bambu and Orca `paint_color` on triangles) for the color parity checks."""
import json
import zipfile

# Bit stream of a whole triangle painted with filament n (1 based), as the hex text Orca writes:
# "4" is filament 1, "8" is 2, "0C" is 3, "1C" is 4 and so on.
def paint_code(n):
    if n <= 0:
        return None
    if n == 1:
        return "4"
    if n == 2:
        return "8"
    return f"{n - 3:X}C"


def box(x0, x1, y0, y1, z0, z1):
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    # (triangle, face name); counterclockwise seen from outside
    t = [((0, 2, 1), "bottom"), ((0, 3, 2), "bottom"), ((4, 5, 6), "top"), ((4, 6, 7), "top"),
         ((0, 1, 5), "front"), ((0, 5, 4), "front"), ((1, 2, 6), "right"), ((1, 6, 5), "right"),
         ((2, 3, 7), "back"), ((2, 7, 6), "back"), ((3, 0, 4), "left"), ((3, 4, 7), "left")]
    return v, t


def write_painted(path, cx, cy, size, painted, extruder=1, project=None, raw=None, top_scale=1.0, seam=None):
    """A box `size` = (dx, dy, dz) centered at (cx, cy) on the bed. `painted` maps a face name
    (top, bottom, front, back, left, right) to a filament number; `half_split` optionally paints
    only the triangles listed by index."""
    dx, dy, dz = size
    verts, tris = box(-dx / 2, dx / 2, -dy / 2, dy / 2, 0, dz)
    # A top smaller or larger than the bottom makes the four side faces slanted.
    verts = [(x * top_scale, y * top_scale, z) if z > 0 else (x, y, z) for x, y, z in verts]
    vx = "".join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x, y, z in verts)
    rows = []
    for k, ((a, b, c), face) in enumerate(tris):
        n = painted.get(face)
        code = paint_code(n) if n else None
        if raw and k in raw:
            code = raw[k]
        attr = f' paint_color="{code}"' if code else ""
        # Seam paint uses the same nibble stream: "4" is an enforcer, "8" a blocker.
        if seam and face in seam:
            attr += f' paint_seam="{paint_code(seam[face])}"'
        rows.append(f'<triangle v1="{a}" v2="{b}" v3="{c}"{attr}/>')
    model = ('<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" '
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>'
             f'<object id="1" name="painted" type="model"><mesh><vertices>{vx}</vertices><triangles>{"".join(rows)}</triangles></mesh></object>'
             f'</resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 {cx} {cy} 0"/></build></model>')
    types = ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
             '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
             '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    settings = f'<?xml version="1.0" encoding="UTF-8"?><config><object id="1"><metadata key="name" value="painted"/><metadata key="extruder" value="{extruder}"/></object></config>'
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", types)
        z.writestr("_rels/.rels", rels)
        z.writestr("3D/3dmodel.model", model)
        z.writestr("Metadata/model_settings.config", settings)
        if project:
            z.writestr("Metadata/project_settings.config", json.dumps(project))
