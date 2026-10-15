// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { appPaintReadInput, appPaintPreviewInput, appPaintApplyInput, appPaintClearInput, storedTarget } from '@slicerx/mcp/toolset'
import { geom } from '../geom/client'
import { slotCount } from '../filament/slots'
import { history, inStep } from '../plate/history'
import { objectOverrides } from '../plate/object-settings'
import { clearPaint, commitStroke, needsPaintedFuzzy, type StrokeEdits } from '../plate/paint'
import { allPlates } from '../plate/plates'
import { toolStore } from '../plate/tools'
import { get, toast, type PaintData, type PaintLayerName, type PlateEntry } from '../state/store'
import { LinkError } from './methods-error'
import type { LinkClient } from './methods'

type Region = { areaMm2: number; triangles: number; boundsMm: { min: number[]; max: number[] } }
type States = { state: number; areaMm2: number; triangles: number; regionCount: number; regions: Region[] }[]
type Preview = { client: string; object: string; plate: string; revision: string; layer: PaintLayerName; edits: StrokeEdits[]; result: Awaited<ReturnType<typeof regions>> }
const previews = new Map<string, Preview>()
let sequence = 0

function target(name: string): PlateEntry {
  const exact = get().plate.find((e) => e.id === name)
  const matches = exact ? [exact] : get().plate.filter((e) => e.name === name)
  if (!matches.length) throw new LinkError('not_found', 'The object is not on the shown plate')
  if (matches.length > 1) throw new LinkError('invalid_input', 'More than one object has that name; use its id')
  return matches[0]!
}

function stamp() { return { plate: get().activePlate, revision: history().state().revision } }
function unchanged(before: ReturnType<typeof stamp>) {
  const now = stamp()
  if (now.plate !== before.plate || now.revision !== before.revision) throw new LinkError('busy', 'The project changed; read or preview the paint again')
}
async function editable(e: PlateEntry) {
  const { replaying } = await import('../cad/history/ops')
  const s = get()
  if (s.plateLoading || s.liveEdit || s.dragging || s.objectTool || s.historyEdit || s.rollback || s.slice.status === 'running' || ['paint', 'brim', 'face'].includes(toolStore.getState().tool) || replaying(e.id)) throw new LinkError('busy', 'Finish the current load, slice or object edit first')
  if (target(e.id).locked) throw new LinkError('refused', 'Unlock the object first')
}

async function regions(e: PlateEntry, layer: PaintLayerName, paint = e.paint) {
  const parts: { part: number; name: string; states: States }[] = []
  for (const [part, mesh] of e.parts.entries()) {
    const texts = paint?.[part]?.[layer]
    const result = texts && Object.keys(texts).length
      ? await geom().call<{ states: States }>('paint.regions', { mesh: { positions: mesh.positions, indices: mesh.indices }, transform: e.transform, paint: texts })
      : { states: [] }
    parts.push({ part, name: mesh.name, states: result.states })
  }
  return { object: e.id, name: e.name, layer, colorSlots: slotCount(get()), parts }
}

export async function readPaint(args: Record<string, unknown>) {
  const parsed = appPaintReadInput.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  const before = stamp()
  const result = await regions(target(parsed.data.object), parsed.data.layer)
  unchanged(before)
  return { summary: `${result.name}: ${result.layer} paint`, output: { ...before, ...result, objectSettings: objectOverrides(get(), target(result.object)) } }
}

export async function previewPaint(args: Record<string, unknown>, client: LinkClient) {
  const parsed = appPaintPreviewInput.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  const i = parsed.data
  if ((i.layer === 'seam' || i.layer === 'support') && i.state > 2 || i.layer === 'fuzzy' && i.state > 1) throw new LinkError('invalid_input', 'The state is outside this paint layer')
  const before = stamp()
  const e = target(i.object)
  if (i.layer === 'color' && i.state > slotCount(get())) throw new LinkError('invalid_input', 'Choose an existing filament slot from app_paint')
  if (!e.parts.length || i.part !== undefined && i.part >= e.parts.length) throw new LinkError('invalid_input', 'The part index is outside this object')
  if (i.target.kind === 'seed' && e.parts.length > 1 && i.part === undefined) throw new LinkError('invalid_input', 'Choose a part index for a seed on a multipart object')
  let selected: ReturnType<typeof storedTarget>
  try { selected = storedTarget(i.target) }
  catch (error) { throw new LinkError('invalid_input', error instanceof Error ? error.message : String(error)) }
  const paint: PaintData = { ...e.paint }
  const edits: StrokeEdits[] = []
  let areaMm2 = 0
  for (const [part, mesh] of e.parts.entries()) {
    if (i.part !== undefined && part !== i.part) continue
    const old = e.paint?.[part]?.[i.layer] ?? {}
    const result = await geom().call<{ changed: Record<string, string>; selectedAreaMm2: number }>('paint.select', { mesh: { positions: mesh.positions, indices: mesh.indices }, transform: e.transform, paint: old, state: i.state, target: selected, ...(i.max_depth === undefined ? {} : { maxDepth: i.max_depth }) })
    const changed = Object.entries(result.changed).filter(([key, value]) => (old[Number(key)] ?? '') !== value).map(([key, value]) => ({ triangle: Number(key), after: value || null }))
    const texts = { ...old }
    for (const { triangle, after } of changed) { if (after) texts[triangle] = after; else delete texts[triangle] }
    paint[part] = { ...paint[part], [i.layer]: texts }
    if (changed.length) edits.push({ objectId: e.id, partIndex: part, layer: i.layer, edits: changed })
    areaMm2 += result.selectedAreaMm2
  }
  const result = await regions(e, i.layer, paint)
  unchanged(before)
  const id = `paint-${Date.now().toString(36)}-${++sequence}`
  previews.set(id, { ...before, client: client.id, object: e.id, layer: i.layer, edits, result })
  if (previews.size > 32) previews.delete(previews.keys().next().value!)
  return { summary: `Paint preview for ${e.name}; no changes applied`, output: { ...before, preview: id, changed: edits.length > 0, areaMm2, ...result } }
}

export async function applyPaint(args: Record<string, unknown>, client: LinkClient) {
  const parsed = appPaintApplyInput.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  const pv = previews.get(parsed.data.preview)
  if (!pv || pv.client !== client.id) throw new LinkError('not_found', 'No paint preview for this client; preview again')
  unchanged(pv)
  const e = target(pv.object)
  await editable(e)
  unchanged(pv)
  // fuzzy activation uses the same shared object setting as the brush.
  if (pv.layer === 'fuzzy' && needsPaintedFuzzy(e) && pv.edits.some((edit) => edit.edits.some((item) => item.after))) {
    const root = e.instanceOf ?? e.id
    const family = allPlates(get()).flatMap((p) => p.objects).filter((p) => p.id === root || p.instanceOf === root)
    if (family.some((p) => p.locked)) throw new LinkError('refused', 'Unlock linked copies before painting fuzzy skin; its setting is shared')
  }
  inStep({}, () => { for (const edit of pv.edits) commitStroke(edit) })
  previews.delete(parsed.data.preview)
  if (pv.edits.length) toast(`${client.name} painted ${e.name}.`, 'info', { label: 'Undo', run: () => void history().undo() })
  return { summary: `Paint ${pv.edits.length ? 'applied to' : 'unchanged on'} ${e.name}`, output: { ...stamp(), ...pv.result, objectSettings: objectOverrides(get(), target(e.id)), changed: pv.edits.length > 0 } }
}

export async function clearLayer(args: Record<string, unknown>, client: LinkClient) {
  const parsed = appPaintClearInput.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  const i = parsed.data
  const before = { ...stamp(), revision: i.revision }
  unchanged(before)
  const e = target(i.object)
  await editable(e)
  unchanged(before)
  const changed = Object.values(e.paint ?? {}).some((p) => Object.keys(p[i.layer] ?? {}).length)
  if (changed) {
    clearPaint(e.id, i.layer)
    toast(`${client.name} cleared ${i.layer} paint on ${e.name}.`, 'info', { label: 'Undo', run: () => void history().undo() })
  }
  return { summary: `${e.name}: ${i.layer} paint cleared`, output: { ...stamp(), object: e.id, name: e.name, layer: i.layer, colorSlots: slotCount(get()), objectSettings: objectOverrides(get(), target(e.id)), parts: e.parts.map((p, part) => ({ part, name: p.name, states: [] })), changed } }
}
