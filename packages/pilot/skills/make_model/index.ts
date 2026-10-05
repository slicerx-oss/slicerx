// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// make_model: build a multi-color model from a request, put it in the project on
// its own plate, slice it and report time and grams per color. Parts are boxes,
// cylinders, extruded text and marks (the SlicerX X, or an SVG the user gives),
// stacked on each other, each with a color that becomes a filament slot.
// Geometry comes from sx-geom (`build`, `subtract`, `text.polygons`, `extrude.svg`).
import type { Cell, MeshPart, SliceResult } from '@slicerx/contracts'
import { z } from 'zod'
import type { ProjectExportSlot } from '../../src/hosts'
import { defineSkill, type ToolContext } from '../../src/tool'
import { arr, oneLine } from '../d_common/index'
import { geomRun, geomTry, needsGeometry, num, partFromGeom, rec, round, toGeomMesh, vec3 } from '../geom_common/index'
import { partsBox } from '../orientation_search/geometry'
import { fmtDuration, fmtGrams } from '../../src/shared'
import { pickPreset, resolveColor, type ResolvedColor, type SlotPreset } from './colors'
import { SLICERX_X_PATH, pathRings, placeRing, type Pt } from './marks'

const Color = z.string().min(1).max(40).describe('A color: a brand name such as "SlicerX black" or "X pink", a plain name such as "blue", or hex such as "#ff79c6"')
const Xy = z.tuple([z.number(), z.number()])
const Xyz = z.tuple([z.number(), z.number(), z.number()])
const Common = {
  name: z.string().max(40).optional().describe('Part name'),
  onPart: z.number().int().min(0).optional().describe('Index of an earlier part to sit on: this part starts at that part top and is centered on it'),
  offsetMm: Xy.optional().describe('With onPart: move from the center of that part, in mm (x right, y back)'),
}

const Part = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('box'), ...Common, color: Color, sizeMm: Xyz.describe('Width, depth and height in mm'), atMm: Xyz.optional().describe('Minimum corner, without onPart. Default 0, 0, 0') }),
  z.object({ kind: z.literal('cylinder'), ...Common, color: Color, diameterMm: z.number().positive().max(400), heightMm: z.number().positive().max(400), atMm: Xyz.optional().describe('Base center, without onPart. Default 0, 0, 0') }),
  z.object({ kind: z.literal('text'), ...Common, color: Color, text: z.string().min(1).max(60), sizeMm: z.number().positive().max(200).describe('Letter height in mm'), heightMm: z.number().positive().max(20).describe('How far the letters stand up in mm'), atMm: Xyz.optional().describe('Text center, without onPart') }),
  z.object({
    kind: z.literal('mark'),
    ...Common,
    color: Color.optional().describe('Color of the mark. Optional when fillColors names every fill of the SVG'),
    mark: z.enum(['slicerx-x', 'svg']).describe('slicerx-x is the SlicerX X. svg needs the svg field'),
    svg: z.string().max(200_000).optional().describe('SVG text, when mark is svg. Untrusted: only its shapes are used'),
    widthMm: z.number().positive().max(300),
    heightMm: z.number().positive().max(20).describe('How far the mark stands up in mm'),
    atMm: Xyz.optional().describe('Mark center, without onPart'),
    fillColors: z.record(z.string(), Color).optional().describe('When the SVG has several fills: SVG fill hex, such as "#ff79c6", to the color to print it in. Fills not listed use the mark color'),
  }),
])
type PartIn = z.infer<typeof Part>

const input = z.object({
  name: z.string().min(1).max(60).describe('Model name, such as "SlicerX logo"'),
  parts: z.array(Part).min(1).max(16).describe('Parts in build order. The first sits on the bed unless atMm says otherwise'),
  holes: z
    .array(
      z
        .object({
          part: z.number().int().min(0).describe('Index of the part in parts, 0 for the first'),
          diameterMm: z.number().positive().max(100),
          // Parts take x, y, z, so models often give a hole three numbers; the hole goes straight through, so z is ignored.
          atMm: z.union([Xy, Xyz]).describe('x and y in mm from the center of that part (a z value is ignored)'),
        })
        .describe('A hole straight through one part'),
    )
    .max(8)
    .default([]),
  material: z.string().max(20).optional().describe('Filament material for every color, such as "PLA". Default the loaded material'),
  slice: z.boolean().default(true).describe('Slice the plate with the current printer after adding it'),
  export3mf: z.boolean().default(false).describe('Also write a 3MF project file. Only when the user asked for a file; the app asks where to save it'),
})
type Input = z.infer<typeof input>

export interface SlotPlan {
  slot: number
  color: ResolvedColor
  material: string
  preset: SlotPreset | null
  parts: number[]
}

/** Slots in order of first use, one per distinct color. Returns the unknown color names when there are any. */
export function planSlots(parts: PartIn[], material: string, printerId: string | undefined): { slots: SlotPlan[]; slotOf: number[]; unknown: string[] } {
  const slots: SlotPlan[] = []
  const slotOf: number[] = []
  const unknown: string[] = []
  parts.forEach((p, i) => {
    const fills = p.kind === 'mark' ? Object.values(p.fillColors ?? {}) : []
    const main = p.color ?? (p.kind === 'mark' ? fills[0] : undefined)
    const c = main ? resolveColor(main) : null
    if (!c) {
      unknown.push(main ?? `part ${i + 1} has no color`)
      slotOf.push(0)
      return
    }
    const use = (col: ResolvedColor): SlotPlan => {
      let s = slots.find((x) => x.color.hex === col.hex)
      if (!s) {
        s = { slot: slots.length + 1, color: col, material, preset: pickPreset(material, printerId), parts: [] }
        slots.push(s)
      }
      if (!s.parts.includes(i)) s.parts.push(i)
      return s
    }
    slotOf.push(use(c).slot)
    if (p.kind === 'mark') {
      for (const extra of Object.values(p.fillColors ?? {})) {
        const e = resolveColor(extra)
        if (e) use(e)
        else unknown.push(extra)
      }
    }
  })
  return { slots, slotOf, unknown }
}

interface Made {
  meshes: MeshPart[]
  min: [number, number, number]
  max: [number, number, number]
}

const centerOf = (m: Made): [number, number] => [(m.min[0] + m.max[0]) / 2, (m.min[1] + m.max[1]) / 2]

function bounds(parts: MeshPart[]): { min: [number, number, number]; max: [number, number, number] } {
  const b = partsBox(parts)
  return { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] }
}

/**
 * sx-geom's extrude frame for axis +Z has u along +Y and v along -X. This turns points meant
 * as (x, y) from the origin into that frame, so the outline lands where it is drawn.
 */
export const forZ = (pts: Pt[]): Pt[] => pts.map(([x, y]): Pt => [y, -x])

async function buildSolids(ctx: ToolContext, solids: unknown[], name: string, slot: number): Promise<MeshPart> {
  const r = await geomRun(ctx, 'build', { solids })
  const part = partFromGeom(r['mesh'], name, slot)
  if (!part) throw new Error(`The geometry engine returned no mesh for ${name}`)
  return part
}

/** Where a part goes: the center on the bed plane (or on the parent) and the height it starts at. */
function target(p: PartIn, made: Made[]): { at: [number, number]; z: number } | string {
  if (p.onPart !== undefined) {
    const parent = made[p.onPart]
    if (!parent) return `onPart ${p.onPart} does not refer to an earlier part`
    const [cx, cy] = centerOf(parent)
    return { at: [cx + (p.offsetMm?.[0] ?? 0), cy + (p.offsetMm?.[1] ?? 0)], z: parent.max[2] }
  }
  const a = p.atMm ?? [0, 0, 0]
  return { at: [a[0], a[1]], z: a[2] }
}

async function makePart(ctx: ToolContext, p: PartIn, i: number, slot: number, made: Made[], slotFor: (color: string) => number): Promise<Made | string> {
  const name = p.name ?? `${p.kind} ${i + 1}`
  const t = target(p, made)
  if (typeof t === 'string') return t
  const [cx, cy] = t.at
  if (p.kind === 'box') {
    const [w, d, h] = p.sizeMm
    const min: [number, number, number] = p.onPart !== undefined ? [cx - w / 2, cy - d / 2, t.z] : [...(p.atMm ?? [0, 0, 0])] as [number, number, number]
    const part = await buildSolids(ctx, [{ type: 'box', min, max: [min[0] + w, min[1] + d, min[2] + h] }], name, slot)
    return { meshes: [part], ...bounds([part]) }
  }
  if (p.kind === 'cylinder') {
    const part = await buildSolids(ctx, [{ type: 'cylinder', origin: [cx, cy, t.z], axis: [0, 0, 1], diameterMm: p.diameterMm, heightMm: p.heightMm }], name, slot)
    return { meshes: [part], ...bounds([part]) }
  }
  if (p.kind === 'text') {
    const r = await geomTry(ctx, 'text.polygons', { text: p.text, sizeMm: p.sizeMm })
    if (!r) return 'This geometry build has no text.polygons operation, so multi-color text is not available yet'
    const polys = arr(r['polygons']).map(rec)
    const b = rec(r['bounds'])
    const lo = arr(b['min']).map((x) => num(x))
    const hi = arr(b['max']).map((x) => num(x))
    if (polys.length === 0) return `No letters could be made from "${oneLine(p.text, 30)}"`
    const ox = cx - ((lo[0] ?? 0) + (hi[0] ?? 0)) / 2
    const oy = cy - ((lo[1] ?? 0) + (hi[1] ?? 0)) / 2
    const solids = polys.map((g) => ({ type: 'extrude', origin: [ox, oy, t.z], axis: [0, 0, 1], points: forZ(arr(g['points']) as Pt[]), holes: arr(g['holes']).map((h) => forZ(arr(h) as Pt[])), heightMm: p.heightMm }))
    const part = await buildSolids(ctx, solids, name, slot)
    return { meshes: [part], ...bounds([part]) }
  }
  // mark
  if (p.mark === 'slicerx-x') {
    const ring = pathRings(SLICERX_X_PATH)?.[0]
    if (!ring) return 'The SlicerX mark could not be read'
    const placed = placeRing(ring, p.widthMm)
    const origin: [number, number, number] = [cx - placed.widthMm / 2, cy - placed.heightMm / 2, t.z]
    const part = await buildSolids(ctx, [{ type: 'extrude', origin, axis: [0, 0, 1], points: forZ(placed.points), heightMm: p.heightMm }], name, slot)
    return { meshes: [part], ...bounds([part]) }
  }
  if (!p.svg) return 'A mark with mark "svg" needs the svg text'
  const rings = pathRings(([...p.svg.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]).join(' ')) || '')
  if (rings && rings.length === 1 && !/<(circle|ellipse|rect|polygon|image|script)/i.test(p.svg)) {
    const placed = placeRing(rings[0] as Pt[], p.widthMm)
    const origin: [number, number, number] = [cx - placed.widthMm / 2, cy - placed.heightMm / 2, t.z]
    const part = await buildSolids(ctx, [{ type: 'extrude', origin, axis: [0, 0, 1], points: forZ(placed.points), heightMm: p.heightMm }], name, slot)
    return { meshes: [part], ...bounds([part]) }
  }
  const r = await geomTry(ctx, 'extrude.svg', { svg: p.svg, options: { fitWidthMm: p.widthMm, heightMm: p.heightMm } })
  if (!r) return 'This SVG has curves, holes or several shapes, and this geometry build has no extrude.svg operation yet'
  const meshes: MeshPart[] = []
  for (const [k, g] of arr(r['parts']).map(rec).entries()) {
    const fill = typeof g['color'] === 'string' ? g['color'].toLowerCase() : ''
    const mapped = Object.entries(p.fillColors ?? {}).find(([hex]) => hex.toLowerCase() === fill)?.[1]
    const part = partFromGeom(g['mesh'], `${name} ${k + 1}`, mapped ? slotFor(mapped) : slot)
    if (part) meshes.push(part)
  }
  if (meshes.length === 0) return 'The SVG produced no solid shapes'
  const b = bounds(meshes)
  const dx = cx - (b.min[0] + b.max[0]) / 2
  const dy = cy - (b.min[1] + b.max[1]) / 2
  const dz = t.z - b.min[2]
  for (const m of meshes) for (let v = 0; v + 2 < m.positions.length; v += 3) {
    m.positions[v] = (m.positions[v] ?? 0) + dx
    m.positions[v + 1] = (m.positions[v + 1] ?? 0) + dy
    m.positions[v + 2] = (m.positions[v + 2] ?? 0) + dz
  }
  return { meshes, ...bounds(meshes) }
}

async function cutHole(ctx: ToolContext, m: Made, at: [number, number], diameterMm: number): Promise<{ made: Made; removedMm3: number } | string> {
  const [cx, cy] = centerOf(m)
  const r = await geomTry(ctx, 'subtract', { mesh: toGeomMesh(m.meshes), solids: [{ type: 'cylinder', origin: [cx + at[0], cy + at[1], m.min[2] - 1], axis: [0, 0, 1], diameterMm, heightMm: m.max[2] - m.min[2] + 2 }] })
  if (!r) return 'This geometry build has no subtract operation, so holes cannot be cut'
  const base = m.meshes[0]
  const part = partFromGeom(r['mesh'], base?.name ?? 'part', base?.slot ?? 1)
  if (!part) return 'The hole left no mesh'
  const removed = num(r['removedVolumeMm3'])
  if (removed <= 0) return `The ${diameterMm} mm hole at ${at.join(', ')} misses the part`
  return { made: { meshes: [part], ...bounds([part]) }, removedMm3: removed }
}

async function sliceObject(ctx: ToolContext, objectId: string): Promise<{ plate: number; result: SliceResult } | string> {
  const project = ctx.project
  if (!project) return 'no project is open'
  if (!ctx.host.slicer) return 'this host has no slicer'
  const plate = [...project.plates()].reverse().find((pl) => pl.items.some((it) => it.objectId === objectId))
  if (!plate) return 'the model is not on a plate'
  const result = await ctx.host.slicer.slice({ plate: await project.plate(plate.index), config: project.config(plate.index), options: { emitGcode: false, emitPreview: false } }, { signal: ctx.signal })
  return { plate: plate.index, result }
}

export function createMakeModel() {
  const machineMaterial = (ctx: ToolContext): string => ctx.context.machine?.material?.toUpperCase() ?? 'PLA'
  return defineSkill({
    name: 'make_model',
    version: '0.1.0',
    permission: 'slice',
    description:
      'Builds a multi-color model from a request and slices it. Parts are boxes, cylinders, extruded text and marks (the SlicerX X, or an SVG the user provides), each with a color: a brand name such as "SlicerX black" or "X pink", a plain name, or hex. Parts stack with onPart (a mark or text sits on top of a base plate). Each distinct color becomes a filament slot, with a matching filament preset. Add holes straight through a part for keychains. It adds the model to the project on a new plate, slices it with the current printer and reports time and grams per color; with export3mf it also writes a 3MF project. Units are mm, Z up. The app asks before the project changes. The SlicerX logo is the X mark; add lettering only when asked. Example: a 60 by 30 by 2 mm SlicerX black box as the base plate, with the X mark, 22 mm wide and 1 mm tall, in X pink on top.',
    input,
    args: (i: Input) => `"${i.name}" --parts ${i.parts.map((p) => p.kind).join(',')}${i.export3mf ? ' --3mf' : ''}`,
    async approval(i: Input, ctx) {
      const plan = planSlots(i.parts, i.material?.toUpperCase() ?? machineMaterial(ctx), ctx.context.machine?.printer)
      if (plan.unknown.length) throw new Error(`Unknown colors: ${plan.unknown.join(', ')}`)
      return {
        title: `Add "${oneLine(i.name, 40)}" to the project?`,
        lines: [`${i.parts.length} part${i.parts.length === 1 ? '' : 's'} on a new plate${i.slice ? ', then slice it' : ''}`, ...plan.slots.map((s) => `Slot ${s.slot}: ${s.color.label} ${s.color.hex}, ${s.material}`), ...(i.export3mf ? ['Then you choose where to save the 3MF'] : [])],
        actions: [],
      }
    },
    async run(i: Input, ctx) {
      const project = ctx.project
      if (!project?.addObject) return { ok: false, summary: 'This project cannot take new objects' }
      if (!ctx.host.geom) return needsGeometry('Building a model')
      const material = i.material?.toUpperCase() ?? machineMaterial(ctx)
      const plan = planSlots(i.parts, material, ctx.context.machine?.printer)
      if (plan.unknown.length) return { ok: false, summary: `Unknown color${plan.unknown.length === 1 ? '' : 's'}: ${plan.unknown.join(', ')}. Use a name like "blue", a brand name like "X pink", or hex.` }
      const made: Made[] = []
      for (const [k, p] of i.parts.entries()) {
        const m = await makePart(ctx, p, k, plan.slotOf[k] ?? 1, made, (c) => plan.slots.find((x) => x.color.hex === resolveColor(c)?.hex)?.slot ?? 1)
        if (typeof m === 'string') return { ok: false, summary: `Part ${k + 1} (${p.kind}): ${m}` }
        made.push(m)
      }
      const notes: string[] = []
      for (const h of i.holes) {
        const m = made[h.part]
        if (!m) return { ok: false, summary: `Hole refers to part ${h.part}, which does not exist` }
        const r = await cutHole(ctx, m, [h.atMm[0], h.atMm[1]], h.diameterMm)
        if (typeof r === 'string') return { ok: false, summary: r }
        made[h.part] = r.made
      }
      const meshes = made.flatMap((m) => m.meshes)
      const box = partsBox(meshes)
      const size: [number, number, number] = [round(box.size[0], 2), round(box.size[1], 2), round(box.size[2], 2)]
      if (box.min[2] < -1e-6) notes.push('Part of the model is below the bed; the slicer drops it onto the bed.')
      const taken = new Set(project.objects().map((o) => o.id))
      const base = i.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'model'
      let id = base
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
      await project.addObject({ id, name: i.name, bboxMm: size, triangles: meshes.reduce((a, m) => a + m.indices.length / 3, 0) }, meshes)

      let sliced: { plate: number; result: SliceResult } | null = null
      if (i.slice) {
        const s = await sliceObject(ctx, id)
        if (typeof s === 'string') notes.push(`Not sliced: ${s}.`)
        else sliced = s
      }
      const grams = sliced?.result.stats.filamentG ?? []
      const mm = sliced?.result.stats.filamentMm ?? []
      let file: { fileName: string; bytes: number } | null | 'none' = 'none'
      if (i.export3mf) {
        const exp = ctx.host.projectExport
        if (!exp) notes.push('This host cannot write a 3MF file.')
        else {
          const slots: ProjectExportSlot[] = plan.slots.map((s) => ({ slot: s.slot, color: s.color.hex, material: s.material, ...(s.preset ? { preset: s.preset.family } : {}) }))
          file = await exp.export3mf({ objectId: id, plate: sliced?.plate ?? 0, name: i.name, slots })
        }
      }
      try {
        const rows: Cell[][] = plan.slots.map((s) => [`${s.slot}`, s.color.label, s.color.hex, s.material, s.preset?.family ?? 'no preset', grams[s.slot - 1] !== undefined ? fmtGrams(grams[s.slot - 1] as number) : ''])
        const timeS = sliced ? Math.round(sliced.result.stats.timeS) : null
        return {
          summary: `Added ${i.name}, ${size.join(' x ')} mm, ${plan.slots.length} color${plan.slots.length === 1 ? '' : 's'}${timeS !== null ? `, ${fmtDuration(timeS)}, ${fmtGrams(grams.reduce((a, b) => a + b, 0))}` : ''}`,
          output: {
            objectId: id,
            sizeMm: size,
            slots: plan.slots.map((s) => ({ slot: s.slot, color: s.color.label, hex: s.color.hex, material: s.material, preset: s.preset?.family ?? null, parts: s.parts, grams: grams[s.slot - 1] !== undefined ? round(grams[s.slot - 1] as number, 1) : null, meters: mm[s.slot - 1] !== undefined ? round((mm[s.slot - 1] as number) / 1000, 2) : null })),
            slice: sliced ? { plate: sliced.plate, timeS, toolChanges: sliced.result.stats.toolChanges, layers: sliced.result.layerCount, warnings: sliced.result.warnings.map((w) => oneLine(w.message, 160)) } : null,
            file: file === 'none' ? null : file ? { fileName: file.fileName, bytes: file.bytes } : { canceled: true },
            ...(notes.length ? { notes } : {}),
          },
          display: [
            { kind: 'table', head: ['slot', 'color', 'hex', 'material', 'filament preset', 'used'], rows },
            ...(notes.length ? [{ kind: 'text' as const, text: notes.join(' ') }] : []),
          ],
        }
      } finally {
        if (sliced) ctx.host.slicer?.release(sliced.result.id)
      }
    },
  })
}

export { vec3 }
