// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { brimEditInput, brimReadInput } from '@slicerx/mcp/toolset'
import { addEar, autoGenerateEars, AUTO_DEFAULTS, clearEars, detectionRange, headDiameter, positionEar, removeEars, resizeEars, worldEars } from '../plate/brim-ears'
import { history } from '../plate/history'
import { objectOverrides } from '../plate/object-settings'
import { activeMeta, allPlates } from '../plate/plates'
import { toolStore } from '../plate/tools'
import { plateSliceConfig } from '../state/slice-plate'
import { get, toast, type PlateEntry } from '../state/store'
import { LinkError } from './methods-error'

function target(name: string): PlateEntry {
  const plate = get().plate
  const exact = plate.find((e) => e.id === name)
  const matches = exact ? [exact] : plate.filter((e) => e.name === name)
  if (!matches.length) throw new LinkError('not_found', 'The object is not on the shown plate')
  if (matches.length > 1) throw new LinkError('invalid_input', 'More than one object has that name; use its id')
  return matches[0]!
}

function read(objects: PlateEntry[]) {
  const s = get()
  const config = plateSliceConfig(s, activeMeta(s))
  const entries = allPlates(s).flatMap((p) => p.objects.map((e) => ({ plate: p.id, entry: e })))
  return {
    summary: `Brim ears for ${objects.length} objects on the shown plate`,
    output: {
      plate: s.activePlate, revision: history().state().revision,
      defaults: { diameter_mm: headDiameter(), max_angle: AUTO_DEFAULTS.maxAngle, detection_mm: AUTO_DEFAULTS.detection },
      objects: objects.map((e) => {
        const root = e.instanceOf ?? e.id
        const world = worldEars(e)
        const brimType = String(objectOverrides(s, e)['brim_type'] ?? config['brim_type'] ?? '')
        return {
          id: e.id, name: e.name, brimType, enabled: brimType === 'painted',
          detectionMaxMm: detectionRange(e.id),
          linked: entries.filter(({ entry: p }) => p.id === root || p.instanceOf === root).map(({ plate, entry }) => ({ plate, id: entry.id })),
          ears: (e.brimPoints ?? []).map((q, index) => ({ index, localMm: q.slice(0, 3), bedMm: [world[index]!.x, world[index]!.y, world[index]!.z], diameterMm: q[3] * 2, connected: !world[index]!.error })),
        }
      }),
    },
  }
}

export function readBrim(args: Record<string, unknown>) {
  const parsed = brimReadInput.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  return read(parsed.data.object ? [target(parsed.data.object)] : get().plate)
}

export async function editBrim(args: Record<string, unknown>, client: string) {
  const parsed = brimEditInput.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  const { replaying } = await import('../cad/history/ops')
  const i = parsed.data
  const s = get()
  const e = target(i.object)
  const root = e.instanceOf ?? e.id
  const family = allPlates(s).flatMap((p) => p.objects).filter((p) => p.id === root || p.instanceOf === root)
  if (s.plateLoading || s.liveEdit || s.dragging || s.objectTool || s.historyEdit || s.rollback || s.slice.status === 'running' || ['paint', 'brim', 'face'].includes(toolStore.getState().tool) || family.some((p) => replaying(p.id))) throw new LinkError('busy', 'Finish the current load, slice or object edit first')
  if (family.some((p) => p.locked)) throw new LinkError('refused', 'Unlock the object and its linked copies first')
  if (i.revision !== history().state().revision) throw new LinkError('busy', 'The project changed; read app_brim_ears again before editing')
  if (i.indices?.some((n) => n >= (e.brimPoints?.length ?? 0))) throw new LinkError('invalid_input', 'An ear index is outside the current list')
  if (i.detection_mm !== undefined && i.detection_mm > detectionRange(e.id)) throw new LinkError('invalid_input', 'detection_mm exceeds detectionMaxMm from app_brim_ears')
  let added = 0
  let changed: boolean
  if (i.action === 'add') changed = addEar(e.id, i.x_mm!, i.y_mm!, i.diameter_mm)
  else if (i.action === 'move') changed = positionEar(e.id, i.indices![0]!, i.x_mm!, i.y_mm!)
  else if (i.action === 'resize') changed = resizeEars(e.id, i.indices!, i.diameter_mm!)
  else if (i.action === 'remove') changed = removeEars(e.id, i.indices!)
  else if (i.action === 'clear') changed = clearEars(e.id)
  else {
    added = autoGenerateEars(e.id, { maxAngle: i.max_angle ?? AUTO_DEFAULTS.maxAngle, detection: i.detection_mm ?? Math.min(AUTO_DEFAULTS.detection, detectionRange(e.id)), ...(i.diameter_mm === undefined ? {} : { diameter: i.diameter_mm }) })
    changed = added > 0
  }
  if (changed) toast(`${client} edited brim ears on ${e.name}.`, 'info', { label: 'Undo', run: () => void history().undo() })
  const out = read([target(e.id)])
  return { ...out, output: { ...out.output, action: i.action, changed, ...(i.action === 'generate' ? { added } : {}) } }
}
