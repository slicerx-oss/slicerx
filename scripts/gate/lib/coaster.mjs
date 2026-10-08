// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The release gate's upload model: an original two-color coaster made fresh for each run, a 70 mm disc (filament 1)
// with a raised ring (filament 2), as a plain 3MF with its filament colors and no thumbnail or cover, so the upload
// derives the swatches and draws the cover itself. Each run's ring differs a little, so no two uploads are the same file.
import { crc32, deflateRawSync } from 'node:zlib'

const SEG = 96

/** A closed annulus (rIn > 0) or disc (rIn = 0) between z0 and z1, as vertices and triangles. */
export function ring(rOut, rIn, z0, z1) {
  const v = []
  const t = []
  const circle = (r, z) => {
    for (let i = 0; i < SEG; i++) {
      const a = (2 * Math.PI * i) / SEG
      v.push([r * Math.cos(a), r * Math.sin(a), z])
    }
  }
  circle(rOut, z0)
  circle(rOut, z1)
  if (rIn > 0) {
    circle(rIn, z0)
    circle(rIn, z1)
  }
  const [ob, ot, ib, it] = [0, SEG, 2 * SEG, 3 * SEG]
  for (let i = 0; i < SEG; i++) {
    const j = (i + 1) % SEG
    t.push([ob + i, ob + j, ot + j], [ob + i, ot + j, ot + i])
    if (rIn > 0) {
      t.push([ib + i, it + j, ib + j], [ib + i, it + i, it + j])
      t.push([ot + i, ot + j, it + j], [ot + i, it + j, it + i])
      t.push([ob + i, ib + j, ob + j], [ob + i, ib + i, ib + j])
    }
  }
  if (rIn === 0) {
    v.push([0, 0, z0], [0, 0, z1])
    const [cb, ct] = [v.length - 2, v.length - 1]
    for (let i = 0; i < SEG; i++) {
      const j = (i + 1) % SEG
      t.push([cb, ob + j, ob + i], [ct, ot + i, ot + j])
    }
  }
  return { v, t }
}

const xml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c])

function mesh(id, { v, t }) {
  const vs = v.map(([x, y, z]) => `<vertex x="${x.toFixed(4)}" y="${y.toFixed(4)}" z="${z.toFixed(4)}"/>`).join('')
  const ts = t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')
  return `<object id="${id}" type="model"><mesh><vertices>${vs}</vertices><triangles>${ts}</triangles></mesh></object>`
}

/** 1 January 1980, the first date a zip entry can carry. */
const DOS_DATE = (1 << 5) | 1

/** A zip archive of `files` ({ name, data }), deflated, as 3MF readers expect. */
export function zip(files) {
  const locals = []
  const central = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8')
    const packed = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6)
    head.writeUInt16LE(8, 8)
    head.writeUInt16LE(DOS_DATE, 12)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(packed.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(name.length, 26)
    locals.push(head, name, packed)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(8, 10)
    dir.writeUInt16LE(DOS_DATE, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(packed.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(name.length, 28)
    dir.writeUInt32LE(offset, 42)
    central.push(dir, name)
    offset += head.length + name.length + packed.length
  }
  const size = central.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...central, end])
}

export const COASTER_COLORS = ['#2E86AB', '#F6AE2D']

/**
 * The coaster as 3MF bytes. `seed` (any number) sets the ring's inner radius between 27 and 29 mm, so each run's file
 * is new; `title` names the object.
 */
export function coaster3mf({ title, seed = Date.now(), colors = COASTER_COLORS }) {
  const rIn = 27 + (Math.abs(Math.floor(seed)) % 200) / 100
  const base = ring(35, 0, 0, 3)
  const rim = ring(33, rIn, 3, 5)
  const model =
    '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    `<metadata name="Application">SlicerX release gate</metadata><metadata name="Title">${xml(title)}</metadata>` +
    `<resources>${mesh(1, base)}${mesh(2, rim)}<object id="3" type="model"><components><component objectid="1"/><component objectid="2"/></components></object></resources>` +
    '<build><item objectid="3" transform="1 0 0 0 1 0 0 0 1 128 128 0" printable="1"/></build></model>'
  const config =
    '<?xml version="1.0" encoding="UTF-8"?>\n<config><object id="3">' +
    `<metadata key="name" value="${xml(title)}"/><metadata key="extruder" value="1"/>` +
    '<part id="1" subtype="normal_part"><metadata key="name" value="Coaster"/><metadata key="extruder" value="1"/></part>' +
    '<part id="2" subtype="normal_part"><metadata key="name" value="Ring"/><metadata key="extruder" value="2"/></part>' +
    '</object><plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Plate 1"/>' +
    '<model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/></model_instance></plate></config>'
  const types =
    '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    '<Default Extension="config" ContentType="text/xml"/></Types>'
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
  const settings = JSON.stringify({ filament_colour: colors }, null, 2)
  return {
    bytes: zip([
      { name: '[Content_Types].xml', data: types },
      { name: '_rels/.rels', data: rels },
      { name: '3D/3dmodel.model', data: model },
      { name: 'Metadata/model_settings.config', data: config },
      { name: 'Metadata/project_settings.config', data: settings },
    ]),
    colors,
    ringInnerMm: rIn,
  }
}
