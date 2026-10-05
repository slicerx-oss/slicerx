// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings embedded in a Bambu Studio or Orca project (.3mf): the whole config in
// Metadata/project_settings.config, per object and per part overrides in
// Metadata/model_settings.config, layer range overrides in Metadata/layer_config_ranges.xml.
// Unzipping is the caller's job; this reads the three files' contents.
import type { PrintConfig } from '@slicerx/contracts/settings'
import { importFlat } from './import'
import { PROJECT_KEYS } from './schema'

interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }
const decode = (s: string): string => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m)

/** A small XML reader for the flat config files above: elements, attributes and text. No DTDs, no namespaces. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  const tag = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = tag.exec(xml))) {
    const top = stack[stack.length - 1] as XmlNode
    if (m[5] !== undefined) {
      top.text += decode(m[5])
    } else if (m[2] !== undefined) {
      if (m[1] === '/') {
        if (stack.length > 1) stack.pop()
      } else {
        const attrs: Record<string, string> = {}
        for (const a of (m[3] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1] as string] = decode(a[2] ?? a[3] ?? '')
        const node: XmlNode = { name: m[2], attrs, children: [], text: '' }
        top.children.push(node)
        if (m[4] !== '/') stack.push(node)
      }
    }
  }
  return root
}

/** Metadata keys that describe the model, not a setting. */
const STRUCTURAL = new Set([
  'name', 'extruder', 'matrix', 'source_file', 'source_object_id', 'source_volume_id', 'source_offset_x', 'source_offset_y',
  'source_offset_z', 'object_id', 'instance_id', 'identify_id', 'plater_id', 'plater_name', 'locked', 'filament_map_mode',
  'filament_maps', 'filament_volume_maps', 'thumbnail_file', 'thumbnail_no_light_file', 'top_file', 'pick_file', 'pattern_file',
  'gcode_file', 'subtype', 'mesh_stat', 'face_count', 'volume_type',
])

export interface ProjectPart {
  id: string
  name?: string
  subtype?: string
  /** 1 based filament slot. */
  extruder?: number
  overrides: PrintConfig
}

export interface ProjectObject {
  id: string
  name?: string
  extruder?: number
  /** Settings this object overrides on top of the project config. */
  overrides: PrintConfig
  parts: ProjectPart[]
}

export interface LayerRange {
  objectId: string
  minZ: number
  maxZ: number
  overrides: PrintConfig
}

export interface ProjectImport {
  /** The project's settings: process, filament and printer in one config. */
  config: PrintConfig
  names: { process?: string; printer?: string; filaments: string[]; version?: string }
  /** Project level values Orca defines outside presets, raw as stored: `filament_colour`, `wipe_tower_x`, `flush_volumes_matrix`. */
  extras: Record<string, unknown>
  objects: ProjectObject[]
  plates: { id: string; name?: string }[]
  layerRanges: LayerRange[]
  unknownKeys: string[]
  ignoredKeys: string[]
  nilKeys: string[]
  invalidKeys: string[]
}

function metadata(node: XmlNode): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of node.children) if (c.name === 'metadata' && c.attrs['key'] !== undefined) out[c.attrs['key']] = c.attrs['value'] ?? ''
  return out
}

function overridesFrom(meta: Record<string, string>, into: Set<string>): { overrides: PrintConfig; bad: string[] } {
  const raw: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) if (!STRUCTURAL.has(k)) raw[k] = v
  const r = importFlat(raw)
  for (const k of r.unknownKeys) into.add(k)
  return { overrides: r.config, bad: r.invalidKeys }
}

const asInt = (s: string | undefined): number | undefined => {
  const n = s === undefined ? NaN : Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : undefined
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [])

/**
 * Read the settings a project carries. `projectSettings` is the parsed JSON of
 * Metadata/project_settings.config; the two XML files are optional text.
 */
export function importProject(files: { projectSettings: unknown; modelSettings?: string; layerRanges?: string }): ProjectImport {
  const src = files.projectSettings
  if (src === null || typeof src !== 'object' || Array.isArray(src)) throw new TypeError('project_settings.config is not a JSON object')
  const obj = src as Record<string, unknown>
  const extras: Record<string, unknown> = {}
  const settingsOnly: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (PROJECT_KEYS.has(k)) extras[k] = v
    else settingsOnly[k] = v
  }
  const flat = importFlat(settingsOnly)
  const unknown = new Set(flat.unknownKeys)
  const invalid = new Set(flat.invalidKeys)
  const objects: ProjectObject[] = []
  const plates: { id: string; name?: string }[] = []
  if (files.modelSettings) {
    const nodes = parseXml(files.modelSettings).children.flatMap((c) => c.children)
    for (const n of nodes) {
      if (n.name === 'object') {
        const meta = metadata(n)
        const o = overridesFrom(meta, unknown)
        o.bad.forEach((k) => invalid.add(k))
        const parts: ProjectPart[] = n.children
          .filter((c) => c.name === 'part')
          .map((p) => {
            const pm = metadata(p)
            const po = overridesFrom(pm, unknown)
            po.bad.forEach((k) => invalid.add(k))
            const ext = asInt(pm['extruder'])
            return { id: p.attrs['id'] ?? '', ...(pm['name'] !== undefined ? { name: pm['name'] } : {}), ...(p.attrs['subtype'] !== undefined ? { subtype: p.attrs['subtype'] } : {}), ...(ext !== undefined ? { extruder: ext } : {}), overrides: po.overrides }
          })
        const ext = asInt(meta['extruder'])
        objects.push({ id: n.attrs['id'] ?? '', ...(meta['name'] !== undefined ? { name: meta['name'] } : {}), ...(ext !== undefined ? { extruder: ext } : {}), overrides: o.overrides, parts })
      } else if (n.name === 'plate') {
        const meta = metadata(n)
        plates.push({ id: meta['plater_id'] ?? String(plates.length + 1), ...(meta['plater_name'] ? { name: meta['plater_name'] } : {}) })
      }
    }
  }
  const layerRanges: LayerRange[] = []
  if (files.layerRanges) {
    for (const o of parseXml(files.layerRanges).children.flatMap((c) => c.children)) {
      if (o.name !== 'object') continue
      for (const r of o.children.filter((c) => c.name === 'range')) {
        const raw: Record<string, unknown> = {}
        for (const opt of r.children) if (opt.name === 'option' && opt.attrs['opt_key']) raw[opt.attrs['opt_key']] = opt.text.trim()
        const res = importFlat(raw)
        res.unknownKeys.forEach((k) => unknown.add(k))
        layerRanges.push({ objectId: o.attrs['id'] ?? '', minZ: Number(r.attrs['min_z'] ?? 0), maxZ: Number(r.attrs['max_z'] ?? 0), overrides: res.config })
      }
    }
  }
  const version = typeof obj['version'] === 'string' ? obj['version'] : undefined
  const proc = typeof obj['print_settings_id'] === 'string' ? obj['print_settings_id'] : undefined
  const printer = typeof obj['printer_settings_id'] === 'string' ? obj['printer_settings_id'] : undefined
  return {
    config: flat.config,
    names: { ...(proc ? { process: proc } : {}), ...(printer ? { printer } : {}), filaments: strings(obj['filament_settings_id']), ...(version ? { version } : {}) },
    extras,
    objects,
    plates,
    layerRanges,
    unknownKeys: [...unknown].sort(),
    ignoredKeys: flat.ignoredKeys,
    nilKeys: flat.nilKeys,
    invalidKeys: [...invalid].sort(),
  }
}
