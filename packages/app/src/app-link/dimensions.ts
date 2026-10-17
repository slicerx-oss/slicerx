// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { appDimensionInputs, type AppDimensions } from '@slicerx/mcp/toolset'
import { allDimensions, keepDimension, keepableKinds, markFor, objectsFor, removeDimension, type ObjectPick } from '../cad/dimensions'
import { editionHasCad } from '../edition'
import { evaluateDimensions, featureAt, measure, type DimensionAnchor } from '../geom/cad'
import { toGeom } from '../geom/client'
import { history } from '../plate/history'
import { toolStore } from '../plate/tools'
import { get, set, toast, type PlateEntry } from '../state/store'
import { LinkError } from './methods-error'

function snapshot() {
  const before = get()
  if (before.plateLoading) throw new LinkError('busy', 'Wait for the plate to finish loading')
  const guard = () => {
    const now = get()
    if (now.plateLoading || now.activePlate !== before.activePlate || now.plate !== before.plate) throw new LinkError('busy', 'The plate changed while measuring; read it again')
  }
  return { before, guard }
}

const anchor = (a: DimensionAnchor) => ({ object: a.object, localPointMm: [...a.pick.at], triangle: a.pick.triangle })

export async function readDimensions(args: Record<string, unknown>): Promise<AppDimensions> {
  const input = appDimensionInputs.list.safeParse(args)
  if (!input.success) throw new LinkError('invalid_input', input.error.message)
  const { before, guard } = snapshot()
  const kept = allDimensions(before.plate)
  const dims = kept.map((x) => x.d)
  const measured = dims.length ? await evaluateDimensions(dims, objectsFor(before.plate, dims)) : []
  guard()
  const now = get()
  const selected = new Set(now.selectedIds.length ? now.selectedIds : now.selection ? [now.selection] : [])
  return {
    plate: now.activePlate, showAll: now.showDimensions,
    dimensions: kept.map(({ owner, d }, index) => {
      const result = measured[index]
      if (!result || result.id !== d.id) throw new LinkError('busy', 'The measurement result did not match the requested dimensions')
      const mark = markFor(d, result, before.plate)
      return {
        id: d.id, owner: { id: owner, name: before.plate.find((e) => e.id === owner)!.name }, kind: d.kind,
        status: result.status, value: result.status === 'ok' ? result.value ?? null : null, unit: result.unit,
        visible: now.workspace === 'prepare' && mark !== null && (now.showDimensions || selected.has(owner) || selected.has(d.b?.object ?? '')),
        annotation: mark ? { from: [...mark.from], to: [...mark.to], label: mark.label } : null,
        a: anchor(result.a), ...(result.b ? { b: anchor(result.b) } : {}), ...(result.message ? { message: result.message } : {}),
      }
    }),
  }
}

async function editable(ids: readonly string[]) {
  const { replaying } = await import('../cad/history/ops')
  const { before, guard: same } = snapshot()
  const entries = ids.map((id) => {
    const e = before.plate.find((p) => p.id === id)
    if (!e) throw new LinkError('not_found', 'The object is not on the shown plate; use its current ID')
    return e
  })
  const guard = () => {
    same()
    const now = get()
    const tool = toolStore.getState()
    const ordinary = tool.tool === 'select' || (tool.tool === 'move' && !tool.moveArrows) || (tool.tool === 'probe' && now.objectTool === 'measure')
    if (!editionHasCad()) throw new LinkError('refused', 'This edition does not offer kept dimensions')
    if (now.workspace !== 'prepare' || !ordinary || now.rollback || now.dragging || now.liveEdit || (now.objectTool !== null && now.objectTool !== 'measure') || entries.some((e) => now.historyEdit?.objectId === e.id || replaying(e.id))) throw new LinkError('busy', 'Finish the active edit and return to the end of the timeline before changing dimensions')
    if (entries.some((e) => e.locked)) throw new LinkError('refused', 'Unlock the object before changing its dimensions')
  }
  guard()
  history()
  return { entries, guard }
}

function checkedPick(e: PlateEntry, p: { part: number; triangle: number; at: [number, number, number] }): ObjectPick {
  const part = e.parts[p.part]
  if (!part || p.triangle >= part.indices.length / 3) throw new LinkError('invalid_input', 'The part or triangle is outside the object; pick again after geometry changes')
  return { objectId: e.id, partIndex: p.part, triangle: p.triangle, at: p.at }
}

export async function keep(args: Record<string, unknown>, client: string): Promise<AppDimensions> {
  const parsed = appDimensionInputs.keep.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  const input = parsed.data
  const picks = [input.a, ...(input.b ? [input.b] : [])]
  const { entries, guard } = await editable(picks.map((p) => p.object))
  const hits = picks.map((p, i) => checkedPick(entries[i]!, p))
  const features = await Promise.all(hits.map((p, i) => featureAt({ mesh: toGeom(entries[i]!.parts[p.partIndex]!), transform: entries[i]!.transform }, { triangle: p.triangle, at: p.at }, 1.5)))
  const measurement = await measure(features[0]!, features[1])
  guard()
  const kinds = keepableKinds(features, measurement.distanceMm !== undefined, measurement.angleDeg !== undefined && !measurement.parallel)
  if (!kinds.includes(input.kind)) throw new LinkError('invalid_input', 'That dimension kind is not supported by these measured features')
  const value = { distance: measurement.distanceMm, angle: measurement.angleDeg, radius: measurement.radiusMm, diameter: measurement.diameterMm, length: measurement.lengthMm }[input.kind]
  if (value === undefined || !Number.isFinite(value)) throw new LinkError('refused', 'The engine could not measure this dimension')
  const kept = await keepDimension(input.kind, hits, value, guard)
  toast(`${client} kept a ${input.kind} dimension`, 'ok')
  return { ...await readDimensions({}), kept: kept.id }
}

export async function remove(args: Record<string, unknown>, client: string): Promise<AppDimensions> {
  const parsed = appDimensionInputs.remove.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  const found = allDimensions(get().plate).find(({ d }) => d.id === parsed.data.dimension)
  if (!found) throw new LinkError('not_found', 'That kept dimension is not on the shown plate')
  const { guard } = await editable([found.owner])
  guard()
  if (!allDimensions(get().plate).some(({ owner, d }) => owner === found.owner && d === found.d)) throw new LinkError('busy', 'The dimension changed; read it again')
  removeDimension(found.d.id)
  toast(`${client} removed a kept dimension`, 'ok')
  return { ...await readDimensions({}), removed: found.d.id }
}

export async function show(args: Record<string, unknown>): Promise<AppDimensions> {
  const parsed = appDimensionInputs.show.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  // Complete the potentially failing read before changing the display preference.
  const { guard } = snapshot()
  const read = await readDimensions({})
  guard()
  const selected = new Set(get().selectedIds.length ? get().selectedIds : get().selection ? [get().selection!] : [])
  set({ showDimensions: parsed.data.showAll })
  return { ...read, showAll: parsed.data.showAll, dimensions: read.dimensions.map((d) => ({ ...d, visible: get().workspace === 'prepare' && d.annotation !== null && (parsed.data.showAll || selected.has(d.owner.id) || selected.has(d.b?.object ?? '')) })) }
}
