// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { appVolumeInputs, type AppVolumes } from '@slicerx/mcp/toolset'
import type { MeshHandle, MeshPart, SettingValue } from '@slicerx/contracts'
import { pasteVolumesInto } from '../plate/clipboard'
import { history, inStep } from '../plate/history'
import { modifierDefinition, modifierValues } from '../plate/modifier-settings'
import { bounds, compose, decompose, multiply, type Vec3 } from '../plate/transform'
import { addPrimitiveVolume, removeVolume, setModifierSetting, setVolumeRole, setVolumeTrs, useObjectAsVolume, volumeSize } from '../plate/volumes'
import { get, toast, type AppState, type PlateEntry, type PlateVolumeEntry } from '../state/store'
import { LinkError } from './methods-error'

function object(s: AppState, name: string): PlateEntry {
  const exact = s.plate.find((p) => p.id === name)
  const matches = exact ? [exact] : s.plate.filter((p) => p.name === name)
  if (!matches.length) throw new LinkError('not_found', 'The object is not on the shown plate')
  if (matches.length > 1) throw new LinkError('invalid_input', 'More than one object has that name; use its id')
  return matches[0]!
}

function state(s: AppState, e: PlateEntry): AppVolumes {
  return {
    object: { id: e.id, name: e.name }, plate: s.activePlate,
    volumes: (e.volumes ?? []).map((v) => {
      const t = decompose(v.local)
      const world = multiply(e.transform, v.local)
      const box = bounds([v.part], world)
      return {
        id: v.id, name: v.name, role: v.role,
        positionMm: t.position, rotationDeg: t.rotation, sizeMm: volumeSize(v),
        local: [...v.local], world, boundsMm: box ? { min: box.min, max: box.max } : null,
        triangles: v.handle.triangles, settings: { ...v.settings },
      }
    }),
  }
}

export function readVolumes(args: Record<string, unknown>): AppVolumes {
  const parsed = appVolumeInputs.list.safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  const s = get()
  return state(s, object(s, parsed.data.object))
}

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }
type Action = Exclude<keyof typeof appVolumeInputs, 'list'>
type Placement = { positionMm?: Vec3 | undefined; rotationDeg?: Vec3 | undefined; sizeMm?: Vec3 | undefined }

function input<K extends keyof typeof appVolumeInputs>(key: K, args: Record<string, unknown>): ReturnType<(typeof appVolumeInputs)[K]['parse']> {
  const parsed = appVolumeInputs[key].safeParse(args)
  if (!parsed.success) throw new LinkError('invalid_input', parsed.error.message)
  return parsed.data as ReturnType<(typeof appVolumeInputs)[K]['parse']>
}

function volume(e: PlateEntry, id: string): PlateVolumeEntry {
  const found = e.volumes?.find((v) => v.id === id)
  if (!found) throw new LinkError('not_found', 'The volume is not in this object')
  return found
}

async function editable(name: string, sourceName?: string, consume = false) {
  const { replaying } = await import('../cad/history/ops')
  const s = get()
  const e = object(s, name)
  const source = sourceName === undefined ? undefined : object(s, sourceName)
  const entries = [e, ...(source ? [source] : [])]
  const guard = () => {
    const now = get()
    if (now.activePlate !== s.activePlate || entries.some((p) => now.plate.find((v) => v.id === p.id) !== p)) throw new LinkError('busy', 'An object changed while the volume was loading; read it again and retry')
    const family = [...now.plate, ...now.plates.filter((p) => p.id !== now.activePlate).flatMap((p) => p.objects)]
      .filter((p) => entries.some((e) => p.id === e.id) || (consume && source && p.instanceOf === source.id))
    if (now.rollback || now.plateLoading || now.dragging || now.liveEdit || family.some((p) => now.historyEdit?.objectId === p.id || replaying(p.id))) throw new LinkError('busy', 'Finish the current load or object edit and return to the end of the timeline first')
    if (e.locked || (consume && source?.locked)) throw new LinkError('refused', 'Unlock the object before changing its volumes or using it as a volume')
  }
  guard()
  history()
  return { e, source, guard }
}

function settings(values: Record<string, unknown>, clear: readonly string[], role: PlateVolumeEntry['role']): Record<string, SettingValue> {
  if (role !== 'modifier' && (Object.keys(values).length || clear.length)) throw new LinkError('invalid_input', 'Only a modifier volume can carry print settings')
  try {
    clear.forEach(modifierDefinition)
    return modifierValues(values)
  } catch (e) {
    throw new LinkError('invalid_input', e instanceof Error ? e.message : String(e))
  }
}

const sameVector = (a: readonly number[], b: readonly number[]) => a.every((n, i) => Math.abs(n - b[i]!) <= 1e-10)
const sameSettings = (a: Record<string, SettingValue> = {}, b: Record<string, SettingValue> = {}) => [...new Set([...Object.keys(a), ...Object.keys(b)])].every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]))

/** Compute and validate placement before any shared setter changes the project. */
function placed(e: PlateEntry, v: PlateVolumeEntry, patch: Placement): PlateVolumeEntry {
  const t = decompose(v.local)
  const currentSize = volumeSize(v)
  const resize = patch.sizeMm && !sameVector(currentSize, patch.sizeMm)
  if (resize && currentSize.some((n) => n <= 0)) throw new LinkError('invalid_input', 'A flat or empty volume cannot be resized in all three dimensions')
  const scale = resize ? t.scale.map((n, i) => n * patch.sizeMm![i]! / currentSize[i]!) as Vec3 : t.scale
  const moved = patch.positionMm && !sameVector(t.position, patch.positionMm)
  const rotated = patch.rotationDeg && !sameVector(t.rotation, patch.rotationDeg)
  const requested = resize || moved || rotated ? compose({ position: patch.positionMm ?? t.position, rotation: patch.rotationDeg ?? t.rotation, scale }) : v.local
  const local = requested === v.local ? v.local : compose(decompose(requested))
  const world = multiply(e.transform, local)
  const box = bounds([v.part], world)
  // Mesh positions are float32, including transformed vertices sent to the slicer.
  if (decompose(local).scale.some((n) => !Number.isFinite(n) || n === 0) || !world.every(Number.isFinite) || !box || [...box.min, ...box.max].some((n) => !Number.isFinite(Math.fround(n)))) throw new LinkError('invalid_input', 'The requested volume placement is outside the finite geometry range')
  return { ...v, local }
}

function finished(e: PlateEntry, client: string, extra: Pick<AppVolumes, 'changed' | 'removed' | 'consumedObject'> = {}): AppVolumes {
  if (extra.changed?.length || extra.removed?.length) toast(`${client} changed volumes of ${e.name}.`, 'info', { label: 'Undo', run: () => void history().undo() })
  return { ...state(get(), object(get(), e.id)), ...extra }
}

export async function volumeAction(action: Action, args: Record<string, unknown>, client: string, loader: Loader | null): Promise<AppVolumes> {
  if (action === 'add') {
    const i = input('add', args)
    const typed = settings(i.settings, [], i.role)
    if (!loader) throw new LinkError('not_ready', 'The app is still starting its geometry loader')
    const { e, guard } = await editable(i.object)
    const id = await addPrimitiveVolume(loader, i.role, i.shape, e.id, {
      beforeCommit: guard,
      prepare: (v) => ({ ...placed(e, v, i), ...(Object.keys(typed).length ? { settings: typed } : {}) }),
    })
    return finished(e, client, { changed: [id] })
  }
  if (action === 'fromObject') {
    const i = input('fromObject', args)
    if (!loader) throw new LinkError('not_ready', 'The app is still starting its geometry loader')
    const { e, source, guard } = await editable(i.object, i.source, true)
    if (source!.id === e.id) throw new LinkError('invalid_input', 'Choose a different source object')
    const id = await useObjectAsVolume(loader, i.role, source!.id, e.id, { beforeCommit: guard, prepare: (v) => placed(e, v, {}) })
    return finished(e, client, { changed: [id], consumedObject: source!.id })
  }
  if (action === 'copy') {
    const i = input('copy', args)
    const { e, source } = await editable(i.target ?? i.object, i.object)
    const v = volume(source!, i.volume)
    const ids = pasteVolumesInto([v], source!.id, e.id, (copy) => { placed(e, copy, {}) })
    return finished(e, client, { changed: ids })
  }
  if (action === 'remove') {
    const i = input('remove', args)
    const { e } = await editable(i.object)
    volume(e, i.volume)
    removeVolume(e.id, i.volume)
    return finished(e, client, { removed: [i.volume] })
  }
  const i = input('set', args)
  const { e } = await editable(i.object)
  const v = volume(e, i.volume)
  const role = i.role ?? v.role
  const typed = settings(i.set, i.clear, role)
  const next = i.role !== undefined && role !== 'modifier' ? {} : { ...v.settings }
  for (const key of i.clear) delete next[key]
  Object.assign(next, typed)
  const proposed = placed(e, v, i)
  const transformChanged = !sameVector(proposed.local, v.local)
  if (role === v.role && !transformChanged && sameSettings(v.settings, next)) return finished(e, client)
  inStep({}, () => {
    if (i.role !== undefined) setVolumeRole(e.id, v.id, role)
    if (transformChanged) setVolumeTrs(e.id, v.id, decompose(proposed.local))
    for (const key of new Set([...i.clear, ...Object.keys(typed)])) setModifierSetting(e.id, v.id, key, next[key])
  })
  return finished(e, client, { changed: [v.id] })
}
