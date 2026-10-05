// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A sliced plate as a .gcode.3mf the way Bambu Lab printers and print queues take it: Metadata/plate_1.gcode with
// its MD5, slice_info.config with the time, weight and filaments, model_settings.config pointing at the G-code, and
// the plate pictures the engine drew. Like Bambu Studio's upload to a printer, it carries no geometry, so it is for
// printing, not for editing.
import { createHash } from 'node:crypto'
import type { SettingValue } from '@slicerx/contracts'
import type { SliceSummary } from './slicer'
import { writeZip } from './zip'

/** Bambu Lab printer models by their `printer_model` name, as slice_info.config names them (the app's export uses the same ids). */
const BAMBU_MODEL_IDS: Readonly<Record<string, string>> = {
  'Bambu Lab A1': 'N2S',
  'Bambu Lab A1 mini': 'N1',
  'Bambu Lab H2D': 'O1D',
  'Bambu Lab H2D Pro': 'O1E',
  'Bambu Lab H2S': 'O1S',
  'Bambu Lab P1P': 'C11',
  'Bambu Lab P1S': 'C12',
  'Bambu Lab P2S': 'N7',
  'Bambu Lab X1': 'BL-P002',
  'Bambu Lab X1 Carbon': 'BL-P001',
  'Bambu Lab X1E': 'C13',
  'Bambu Lab X2D': 'N6',
}

/** The slicer version Bambu Lab firmware and Bambu Handy read from the header, the one OrcaSlicer 2.4.2 sends. */
const CLIENT_VERSION = '02.06.00.51'

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const list = (v: SettingValue | undefined): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : v === undefined || v === '' ? [] : [String(v)])
const truthy = (v: SettingValue | undefined): boolean => ['true', '1'].includes(list(v)[0] ?? '')

/** Thumbnail sizes asked of the engine for a .gcode.3mf when the settings name none: the plate picture and its small copy. */
export const PLATE_THUMBNAILS = ['512x512/PNG', '128x128/PNG']

/** The PNG thumbnails at the top of the G-code (`; thumbnail begin WxH SIZE`, base64 rows), largest first. */
export function gcodeThumbnails(gcode: string): { w: number; h: number; png: Buffer }[] {
  const end = gcode.lastIndexOf('; THUMBNAIL_BLOCK_END', 4_000_000)
  const head = end >= 0 ? gcode.slice(0, end) : gcode.slice(0, 4_000_000)
  const out: { w: number; h: number; png: Buffer }[] = []
  for (const m of head.matchAll(/^; thumbnail begin (\d+)x(\d+) \d+\r?\n([\s\S]*?)^; thumbnail end/gm)) {
    const png = Buffer.from(m[3]!.split('\n').map((l) => l.replace(/^;\s?/, '').trim()).join(''), 'base64')
    if (png[0] === 0x89 && png[1] === 0x50) out.push({ w: Number(m[1]), h: Number(m[2]), png })
  }
  return out.sort((a, b) => b.w * b.h - a.w * a.h)
}

/** The G-code without its thumbnail blocks: the pictures go into the 3MF as files, as OrcaSlicer does for Bambu Lab printers. */
export function withoutThumbnails(gcode: string): string {
  const end = gcode.lastIndexOf('; THUMBNAIL_BLOCK_END', 4_000_000)
  if (end < 0) return gcode
  const cut = gcode.indexOf('\n', end) + 1 || gcode.length
  return gcode.slice(0, cut).replace(/^; THUMBNAIL_BLOCK_START\r?\n[\s\S]*?^; THUMBNAIL_BLOCK_END\r?\n(?:\r?\n)?/gm, '') + gcode.slice(cut)
}

export function gcode3mf(sliced: string, summary: SliceSummary, config: Record<string, SettingValue>): Buffer {
  const shots = gcodeThumbnails(sliced)
  const gcode = shots.length ? withoutThumbnails(sliced) : sliced
  const meta = (key: string, value: string | number | boolean): string => `    <metadata key="${key}" value="${esc(String(value))}"/>\n`
  const types = list(config['filament_type'])
  const colors = list(config['filament_colour'])
  const ids = list(config['filament_ids'])
  const nozzle = Number(list(config['nozzle_diameter'])[0] ?? 0.4) || 0.4
  const support = truthy(config['enable_support'])
  // The label ids the engine lists in its "; model label id:" header line (Bambu Lab printers), for skipping objects.
  const labels = (/^; model label id: ([\d,]+)/m.exec(gcode)?.[1] ?? '').split(',').filter(Boolean)
  const used = summary.filaments.filter((f) => f.filament_mm > 0)
  const sliceInfo =
    `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n    <header_item key="X-BBL-Client-Version" value="${CLIENT_VERSION}"/>\n  </header>\n  <plate>\n` +
    meta('index', 1) +
    meta('printer_model_id', BAMBU_MODEL_IDS[list(config['printer_model'])[0] ?? ''] ?? '') +
    meta('nozzle_diameters', nozzle) +
    meta('prediction', summary.time_s) +
    meta('weight', summary.filament_g.toFixed(2)) +
    meta('outside', false) +
    meta('support_used', support) +
    meta('label_object_enabled', labels.length > 0) +
    labels.map((id, k) => `    <object identify_id="${id}" name="${esc(k === 0 ? summary.model.name : `${summary.model.name} ${k + 1}`)}" skipped="false" />\n`).join('') +
    used
      .map((f) => {
        const i = f.slot - 1
        const color = (colors[i] ?? colors[0] ?? '#FFFFFF').toUpperCase()
        return `    <filament id="${f.slot}" tray_info_idx="${esc(ids[i] ?? '')}" type="${esc(types[i] ?? types[0] ?? 'PLA')}" color="${esc(color)}" used_m="${(f.filament_mm / 1000).toFixed(2)}" used_g="${f.filament_g.toFixed(2)}" used_for_object="true" used_for_support="${support}"/>\n`
      })
      .join('') +
    `  </plate>\n</config>\n`
  const md5 = createHash('md5').update(gcode, 'utf8').digest('hex').toUpperCase()
  const big = shots[0]
  const small = shots[shots.length - 1]
  const cover = big
    ? `<Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/><Relationship Target="/Metadata/plate_1.png" Id="rel-4" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"/><Relationship Target="/Metadata/plate_1_small.png" Id="rel-5" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-small"/>`
    : ''
  return writeZip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="gcode" ContentType="text/x.gcode"/><Default Extension="config" ContentType="text/xml"/><Default Extension="md5" ContentType="text/plain"/><Default Extension="png" ContentType="image/png"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>${cover}</Relationships>`,
    },
    {
      name: '3D/3dmodel.model',
      data: `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">SlicerX</metadata><resources/><build/></model>`,
    },
    {
      name: 'Metadata/model_settings.config',
      data: `<?xml version="1.0" encoding="UTF-8"?>\n<config><plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value=""/><metadata key="locked" value="false"/><metadata key="gcode_file" value="Metadata/plate_1.gcode"/>${big ? '<metadata key="thumbnail_file" value="Metadata/plate_1.png"/>' : ''}</plate></config>`,
    },
    {
      name: 'Metadata/_rels/model_settings.config.rels',
      data: `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/Metadata/plate_1.gcode" Id="rel-1" Type="http://schemas.bambulab.com/package/2021/gcode"/></Relationships>`,
    },
    { name: 'Metadata/slice_info.config', data: sliceInfo },
    { name: 'Metadata/plate_1.gcode', data: gcode },
    { name: 'Metadata/plate_1.gcode.md5', data: md5 },
    ...(big && small ? [{ name: 'Metadata/plate_1.png', data: big.png }, { name: 'Metadata/plate_1_small.png', data: small.png }] : []),
  ])
}
