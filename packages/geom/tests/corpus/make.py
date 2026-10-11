# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Writes the corpus files SlicerX makes itself, all plain boxes:

  python3 make.py <dir>

  subtypes.3mf         a Bambu Studio style project: one object with a 20 x 20 x 10 mm body and one part of each other
                       subtype (negative_part notching a corner, modifier_part, support_blocker, support_enforcer)
  two-colors.obj       two objects with vertex colors, red and blue
  two-materials.amf    two objects on two colored materials
  box-ascii.stl        an ASCII STL of a 20 mm cube
"""
import sys
import zipfile
from pathlib import Path

TRIS = [(0, 2, 1), (1, 2, 3), (4, 5, 6), (5, 7, 6), (0, 1, 4), (1, 5, 4),
        (2, 6, 3), (3, 6, 7), (0, 4, 2), (2, 4, 6), (1, 3, 5), (3, 7, 5)]


def box(x0, y0, z0, x1, y1, z1):
    return [(x, y, z) for z in (z0, z1) for y in (y0, y1) for x in (x0, x1)]


def subtypes(out):
    parts = [
        (1, 'body', 'normal_part', box(0, 0, 0, 20, 20, 10)),
        (2, 'notch', 'negative_part', box(17, 17, 4, 23, 23, 10)),
        (3, 'modifier', 'modifier_part', box(30, 0, 0, 36, 6, 4)),
        (4, 'blocker', 'support_blocker', box(30, 10, 0, 36, 16, 4)),
        (5, 'enforcer', 'support_enforcer', box(30, 20, 0, 36, 26, 4)),
    ]
    core = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02'
    objs = ''.join(
        f'<object id="{i}" type="model"><mesh><vertices>'
        + ''.join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x, y, z in v)
        + '</vertices><triangles>'
        + ''.join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in TRIS)
        + '</triangles></mesh></object>'
        for i, _, _, v in parts)
    comps = ''.join(f'<component p:path="/3D/Objects/object_1.model" objectid="{i}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>'
                    for i, *_ in parts)
    ident = 'metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"'
    settings = ('<?xml version="1.0" encoding="UTF-8"?>\n<config><object id="10"><metadata key="name" value="subtypes"/>'
                '<metadata key="extruder" value="1"/>'
                + ''.join(f'<part id="{i}" subtype="{s}"><metadata key="name" value="{n}"/><{ident}/></part>' for i, n, s, _ in parts)
                + '</object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="10"/>'
                '<metadata key="instance_id" value="0"/></model_instance></plate></config>')
    rel = ('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
           '<Relationship Target="{}" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    with zipfile.ZipFile(out / 'subtypes.3mf', 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
        z.writestr('_rels/.rels', rel.format('/3D/3dmodel.model'))
        z.writestr('3D/3dmodel.model', f'<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xmlns="{core}" '
                   'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">'
                   f'<resources><object id="10" type="model"><components>{comps}</components></object></resources>'
                   '<build><item objectid="10" transform="1 0 0 0 1 0 0 0 1 118 118 0" printable="1"/></build></model>')
        z.writestr('3D/_rels/3dmodel.model.rels', rel.format('/3D/Objects/object_1.model'))
        z.writestr('3D/Objects/object_1.model', f'<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xmlns="{core}">'
                   f'<resources>{objs}</resources><build/></model>')
        z.writestr('Metadata/model_settings.config', settings)


def obj(out):
    lines = ['# two boxes with vertex colors']
    base = 0
    for name, (x0, x1), rgb in (('red', (0, 10), '1 0 0'), ('blue', (15, 25), '0 0 1')):
        lines.append(f'o {name}')
        lines += [f'v {x} {y} {z} {rgb}' for x, y, z in box(x0, 0, 0, x1, 10, 10)]
        lines += [f'f {a + base + 1} {b + base + 1} {c + base + 1}' for a, b, c in TRIS]
        base += 8
    (out / 'two-colors.obj').write_text('\n'.join(lines) + '\n')


def amf(out):
    objs = []
    for oid, (x0, x1) in ((1, (0, 10)), (2, (15, 25))):
        vs = ''.join(f'<vertex><coordinates><x>{x}</x><y>{y}</y><z>{z}</z></coordinates></vertex>' for x, y, z in box(x0, 0, 0, x1, 10, 10))
        ts = ''.join(f'<triangle><v1>{a}</v1><v2>{b}</v2><v3>{c}</v3></triangle>' for a, b, c in TRIS)
        objs.append(f'<object id="{oid}"><metadata type="name">box {oid}</metadata><mesh><vertices>{vs}</vertices>'
                    f'<volume materialid="{oid}">{ts}</volume></mesh></object>')
    mats = ('<material id="1"><color><r>1</r><g>0</g><b>0</b></color></material>'
            '<material id="2"><color><r>0</r><g>0</g><b>1</b></color></material>')
    (out / 'two-materials.amf').write_text(f'<?xml version="1.0" encoding="UTF-8"?>\n<amf unit="millimeter">{mats}{"".join(objs)}</amf>\n')


def stl(out):
    v = box(0, 0, 0, 20, 20, 20)
    body = ''.join('facet normal 0 0 0\n outer loop\n' + ''.join(f'  vertex {v[i][0]} {v[i][1]} {v[i][2]}\n' for i in t)
                   + ' endloop\nendfacet\n' for t in TRIS)
    (out / 'box-ascii.stl').write_text(f'solid box\n{body}endsolid box\n')


if __name__ == '__main__':
    d = Path(sys.argv[1])
    d.mkdir(parents=True, exist_ok=True)
    subtypes(d)
    obj(d)
    amf(d)
    stl(d)
