// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The objects of any 3MF project as design parts: each build item's printed parts with their component transforms
// baked in, their filament slots and names from Bambu Studio and Orca's model_settings.config, and their painted
// triangles. Modifiers and other volume types are left out and named. sx-geom's format reader takes this over once
// its JSON op ships; until then this reads only what a design needs.
import { bakeMesh, IDENTITY, multiply, type HistoryMesh, type Mat4 } from '@slicerx/cad-history'
import { ToolInputError } from './models'
import type { ZipReader } from './zip'

/** Painted triangles of a part by kind, each triangle's code as the file has it (Bambu Studio and Orca's form). */
export type PaintCodes = Partial<Record<'color' | 'seam' | 'support' | 'fuzzy', Record<number, string>>>

export type FilePart = HistoryMesh & { paint?: PaintCodes }

export interface FileObject {
  /** The object id in the root model, as histories and kept dimensions name it. */
  id: string
  name: string
  /** The build item's transform. */
  transform: Mat4
  parts: FilePart[]
  /** Parts that are not printed parts (modifiers, negative volumes, blockers), by name. */
  skipped: string[]
}

const MAX_TRIANGLES = 20_000_000
const MAX_DEPTH = 16

const UNIT_MM: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, meter: 1000, inch: 25.4, foot: 304.8 }

const PAINT_ATTRS: Record<string, keyof PaintCodes> = { paint_color: 'color', paint_seam: 'seam', paint_supports: 'support', paint_fuzzy_skin: 'fuzzy' }

const unescape = (v: string): string => v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

export function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) out[m[1]!] = unescape(m[2]!)
  return out
}

/** A 3MF transform attribute (row-major 3x4) as a column-major Mat4. */
export function matOf(attr: string | undefined): Mat4 {
  const v = attr?.trim().split(/\s+/).map(Number)
  if (!v || v.length !== 12 || v.some((x) => !Number.isFinite(x))) return [...IDENTITY]
  return [v[0]!, v[1]!, v[2]!, 0, v[3]!, v[4]!, v[5]!, 0, v[6]!, v[7]!, v[8]!, 0, v[9]!, v[10]!, v[11]!, 1]
}

interface Mesh {
  positions: number[]
  indices: number[]
  paint?: PaintCodes
}

interface ObjectEl {
  id: string
  name?: string
  mesh?: Mesh
  components: { objectId: string; path?: string; transform: Mat4 }[]
}

/** The objects of one model part, by id. */
function parseModel(xml: string, label: string, budget: { triangles: number }): { objects: Map<string, ObjectEl>; scale: number; items: Record<string, string>[] } {
  const unit = attrs(/<model\b[^>]*>/.exec(xml)?.[0] ?? '')['unit'] ?? 'millimeter'
  const scale = UNIT_MM[unit]
  if (scale === undefined) throw new ToolInputError(`${label}: unknown unit "${unit}"`, 'invalid_model')
  const objects = new Map<string, ObjectEl>()
  let at = 0
  for (;;) {
    const open = xml.indexOf('<object', at)
    if (open < 0) break
    const head = xml.indexOf('>', open)
    const end = xml.indexOf('</object>', head)
    if (head < 0 || end < 0) throw new ToolInputError(`${label}: an object is not closed`, 'invalid_model')
    const a = attrs(xml.slice(open, head))
    const body = xml.slice(head + 1, end)
    at = end + 9
    const id = a['id']
    if (!id) continue
    const el: ObjectEl = { id, ...(a['name'] ? { name: a['name'] } : {}), components: [] }
    if (body.includes('<mesh')) {
      const positions: number[] = []
      for (const v of body.matchAll(/<vertex\b([^>]*)\/?>/g)) {
        const p = attrs(v[1]!)
        positions.push(Number(p['x']) * scale, Number(p['y']) * scale, Number(p['z']) * scale)
      }
      if (positions.some((x) => !Number.isFinite(x))) throw new ToolInputError(`${label}: object ${id} has a vertex that is not a number`, 'invalid_model')
      const indices: number[] = []
      const paint: PaintCodes = {}
      const count = positions.length / 3
      for (const t of body.matchAll(/<triangle\b([^>]*)\/?>/g)) {
        const p = attrs(t[1]!)
        const v = [Number(p['v1']), Number(p['v2']), Number(p['v3'])]
        if (v.some((x) => !Number.isInteger(x) || x < 0 || x >= count)) throw new ToolInputError(`${label}: object ${id} has a triangle with a bad vertex index`, 'invalid_model')
        const tri = indices.length / 3
        indices.push(v[0]!, v[1]!, v[2]!)
        for (const [k, kind] of Object.entries(PAINT_ATTRS)) {
          const code = p[k]
          if (code) (paint[kind] ??= {})[tri] = code
        }
      }
      budget.triangles += indices.length / 3
      if (budget.triangles > MAX_TRIANGLES) throw new ToolInputError(`${label}: more than ${MAX_TRIANGLES} triangles`, 'invalid_model')
      el.mesh = { positions, indices, ...(Object.keys(paint).length ? { paint } : {}) }
    }
    for (const c of body.matchAll(/<component\b([^>]*)\/?>/g)) {
      const ca = attrs(c[1]!)
      if (ca['objectid']) el.components.push({ objectId: ca['objectid'], ...(ca['p:path'] ? { path: ca['p:path'].replace(/^\/+/, '') } : {}), transform: matOf(ca['transform']) })
    }
    objects.set(id, el)
  }
  const build = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(xml)?.[1] ?? ''
  const items = [...build.matchAll(/<item\b([^>]*)\/?>/g)].map((m) => attrs(m[1]!))
  return { objects, scale, items }
}

interface PartInfo {
  name?: string
  subtype?: string
  extruder?: number
}

/** Object and part names, slots and subtypes from Bambu Studio and Orca's settings file. */
function modelSettings(text: string | undefined): Map<string, { name?: string; extruder?: number; parts: Map<string, PartInfo> }> {
  const out = new Map<string, { name?: string; extruder?: number; parts: Map<string, PartInfo> }>()
  if (!text) return out
  const meta = (body: string): Record<string, string> => Object.fromEntries([...body.matchAll(/<metadata\b([^>]*)\/?>/g)].map((m) => attrs(m[1]!)).map((a) => [a['key'] ?? '', a['value'] ?? '']))
  const slot = (v: string | undefined): number | undefined => {
    const n = Number(v)
    return Number.isInteger(n) && n > 0 ? n : undefined
  }
  for (const o of text.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const id = attrs(o[1]!)['id']
    if (!id) continue
    const body = o[2]!
    const parts = new Map<string, PartInfo>()
    for (const p of body.matchAll(/<part\b([^>]*)>([\s\S]*?)<\/part>/g)) {
      const pa = attrs(p[1]!)
      const pm = meta(p[2]!)
      const ext = slot(pm['extruder'])
      parts.set(pa['id'] ?? '', { ...(pm['name'] ? { name: pm['name'] } : {}), ...(pa['subtype'] ? { subtype: pa['subtype'] } : {}), ...(ext ? { extruder: ext } : {}) })
    }
    const om = meta(body.replace(/<part\b[\s\S]*?<\/part>/g, ''))
    const ext = slot(om['extruder'])
    out.set(id, { ...(om['name'] ? { name: om['name'] } : {}), ...(ext ? { extruder: ext } : {}), parts })
  }
  return out
}

/** Every build item of a 3MF as an object with its printed parts in its own frame. */
export function readFileObjects(zip: ZipReader, label: string): FileObject[] {
  const budget = { triangles: 0 }
  const models = new Map<string, ReturnType<typeof parseModel>>()
  const model = (path: string): ReturnType<typeof parseModel> => {
    let m = models.get(path)
    if (!m) {
      const text = zip.text(path)
      if (text === undefined) throw new ToolInputError(`${label} points at ${path}, which is not in the file`, 'invalid_model')
      m = parseModel(text, label, budget)
      models.set(path, m)
    }
    return m
  }
  const root = model('3D/3dmodel.model')
  const settings = modelSettings(zip.text('Metadata/model_settings.config'))
  const out: FileObject[] = []
  for (const item of root.items) {
    const id = item['objectid']
    const obj = id ? root.objects.get(id) : undefined
    if (!id || !obj) continue
    const info = settings.get(id)
    const parts: FilePart[] = []
    const skipped: string[] = []
    const walk = (el: ObjectEl, path: string, t: Mat4, depth: number, partId: string): void => {
      if (depth > MAX_DEPTH) throw new ToolInputError(`${label}: components nest too deep`, 'invalid_model')
      if (el.mesh) {
        const pi = info?.parts.get(partId)
        const name = pi?.name ?? el.name ?? info?.name ?? 'Part'
        if (pi?.subtype && pi.subtype !== 'normal_part') {
          skipped.push(`${name} (${pi.subtype.replace(/_/g, ' ')})`)
          return
        }
        const baked = bakeMesh({ name, slot: pi?.extruder ?? info?.extruder ?? 1, positions: el.mesh.positions, indices: el.mesh.indices }, t)
        parts.push({ ...baked, ...(el.mesh.paint ? { paint: el.mesh.paint } : {}) })
      }
      for (const c of el.components) {
        const p = c.path ?? path
        const child = model(p).objects.get(c.objectId)
        if (!child) throw new ToolInputError(`${label}: a component points at an object it does not have`, 'invalid_model')
        walk(child, p, multiply(t, c.transform), depth + 1, c.objectId)
      }
    }
    walk(obj, '3D/3dmodel.model', [...IDENTITY], 0, id)
    if (parts.length) out.push({ id, name: info?.name ?? obj.name ?? `Object ${id}`, transform: matOf(item['transform']), parts, skipped })
  }
  return out
}
