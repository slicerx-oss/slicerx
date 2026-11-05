# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
"""Writes the texture paint fixtures, all made here:

  python3 make.py <dir>

  quadrants.png        16 x 16: red top left, green top right, blue bottom left, white bottom right
  textured-cube.obj    a 20 mm cube on one material (textured-cube.mtl, map_Kd quadrants.png): the top shows the whole
                       image, a quarter each; the bottom and the right side red, the front green, the back blue and
                       the left side white, so red covers 900 mm2 and the others 500 mm2 each
  textured-cube.3mf    the same cube as a 3MF with texture2d groups: the top the whole image; the bottom green; the
                       front red through a mirrored texture (u 1.55 to 1.95); the back blue through a clamped one
                       (u -0.9 to -0.5); left and right white, so white covers 900 mm2 and the others 500 mm2 each
  textured-square.obj  a 20 mm square on quadrants.jpg (textured-square.mtl): 100 mm2 a quarter

quadrants.jpg is quadrants.png scaled to 64 x 64 and saved as a JPEG
(ffmpeg -i quadrants.png -vf scale=64:64:flags=neighbor -q:v 2 quadrants.jpg); this script does not write it.
"""
import struct
import sys
import zipfile
import zlib
from pathlib import Path

RED, GREEN, BLUE, WHITE = (230, 20, 30), (20, 200, 40), (20, 40, 220), (245, 245, 245)
# a quarter of the image as (u0, v0, u1, v1), v from the bottom, inset a little
QUARTER = {RED: (0.05, 0.55, 0.45, 0.95), GREEN: (0.55, 0.55, 0.95, 0.95), BLUE: (0.05, 0.05, 0.45, 0.45), WHITE: (0.55, 0.05, 0.95, 0.45)}


def png(w, h, pixel):
    raw = b''.join(b'\0' + b''.join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)
    head = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', head) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def quadrant(x, y, n=16):
    top, left = y < n // 2, x < n // 2
    if top:
        return RED if left else GREEN
    return BLUE if left else WHITE


S = 20
P = [(x, y, z) for z in (0, S) for y in (0, S) for x in (0, S)]

# each face's corners, counterclockwise seen from outside
FACES = {
    'bottom': [(0, 0, 0), (0, S, 0), (S, S, 0), (S, 0, 0)],
    'top': [(0, 0, S), (S, 0, S), (S, S, S), (0, S, S)],
    'front': [(0, 0, 0), (S, 0, 0), (S, 0, S), (0, 0, S)],
    'back': [(S, S, 0), (0, S, 0), (0, S, S), (S, S, S)],
    'left': [(0, S, 0), (0, 0, 0), (0, 0, S), (0, S, S)],
    'right': [(S, 0, 0), (S, S, 0), (S, S, S), (S, 0, S)],
}


def box_uv(u0, v0, u1, v1):
    return [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]


def cube_obj(out):
    looks = {'top': box_uv(0, 0, 1, 1), 'bottom': box_uv(*QUARTER[RED]), 'right': box_uv(*QUARTER[RED]),
             'front': box_uv(*QUARTER[GREEN]), 'back': box_uv(*QUARTER[BLUE]), 'left': box_uv(*QUARTER[WHITE])}
    lines = ['# a 20 mm cube with a texture', 'mtllib textured-cube.mtl']
    lines += [f'v {x} {y} {z}' for x, y, z in P]
    lines.append('usemtl quadrants')
    t = 0
    for name, corners in FACES.items():
        lines += [f'vt {u} {v}' for u, v in looks[name]]
        lines.append('f ' + ' '.join(f'{P.index(c) + 1}/{t + k + 1}' for k, c in enumerate(corners)))
        t += 4
    (out / 'textured-cube.obj').write_text('\n'.join(lines) + '\n', newline='\n')
    (out / 'textured-cube.mtl').write_text('newmtl quadrants\nKd 1 1 1\nmap_Kd quadrants.png\n', newline='\n')


def square_obj(out):
    lines = ['mtllib textured-square.mtl', 'v 0 0 0', f'v {S} 0 0', f'v {S} {S} 0', f'v 0 {S} 0',
             'vt 0 0', 'vt 1 0', 'vt 1 1', 'vt 0 1', 'usemtl q', 'f 1/1 2/2 3/3 4/4']
    (out / 'textured-square.obj').write_text('\n'.join(lines) + '\n', newline='\n')
    (out / 'textured-square.mtl').write_text('newmtl q\nKd 1 1 1\nmap_Kd quadrants.jpg\n', newline='\n')


def cube_3mf(out):
    # group 20 on a wrapping texture, 21 on a mirrored one, 22 on a clamped one; four coordinates a face
    looks = {'top': (20, box_uv(0, 0, 1, 1)), 'bottom': (20, box_uv(*QUARTER[GREEN])),
             'front': (21, box_uv(1.55, 0.55, 1.95, 0.95)), 'back': (22, box_uv(-0.9, 0.05, -0.5, 0.45)),
             'left': (20, box_uv(*QUARTER[WHITE])), 'right': (20, box_uv(*QUARTER[WHITE]))}
    coords = {20: [], 21: [], 22: []}
    tris = []
    for name, corners in FACES.items():
        g, uv = looks[name]
        base = len(coords[g])
        coords[g] += uv
        idx = [P.index(c) for c in corners]
        for a, b in ((1, 2), (2, 3)):
            tris.append(f'<triangle v1="{idx[0]}" v2="{idx[a]}" v3="{idx[b]}" pid="{g}" p1="{base}" p2="{base + a}" p3="{base + b}"/>')
    groups = ''.join(f'<m:texture2dgroup id="{g}" texid="{g - 10}">' + ''.join(f'<m:tex2coord u="{u}" v="{v}"/>' for u, v in c)
                     + '</m:texture2dgroup>' for g, c in coords.items())
    textures = ''.join(f'<m:texture2d id="{i}" path="/3D/Texture/quadrants.png" contenttype="image/png" tilestyleu="{s}" tilestylev="wrap"/>'
                       for i, s in ((10, 'wrap'), (11, 'mirror'), (12, 'clamp')))
    verts = ''.join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x, y, z in P)
    model = ('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" '
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
             'xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">'
             f'<resources>{textures}{groups}<object id="1" type="model" name="textured cube"><mesh><vertices>{verts}</vertices>'
             f'<triangles>{"".join(tris)}</triangles></mesh></object></resources>'
             '<build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 100 0"/></build></model>')
    with zipfile.ZipFile(out / 'textured-cube.3mf', 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?>\n'
                   '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
                   '<Default Extension="png" ContentType="image/png"/></Types>')
        z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?>\n'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
                   '</Relationships>')
        z.writestr('3D/3dmodel.model', model)
        z.writestr('3D/Texture/quadrants.png', png(16, 16, quadrant))


if __name__ == '__main__':
    d = Path(sys.argv[1])
    d.mkdir(parents=True, exist_ok=True)
    (d / 'quadrants.png').write_bytes(png(16, 16, quadrant))
    cube_obj(d)
    square_obj(d)
    cube_3mf(d)
