// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opening a 3MF project onto the plate (actions.ts hands project files here): loaded with the first project, so none
// of it is in the app's startup code.
import type { Host, MeshHandle, SettingValue } from '@slicerx/contracts'
import { resolveConfig } from '../adapters/config'
import { objectPalette } from '../edition'
import { markOpenStage } from '../lib/open-mark'
import { bake } from '../plate/mesh-ops'
import { bounds, compose } from '../plate/transform'
import { clearProject } from '../project/new'
import { confirmDiscard, type OpenScope } from '../project/unsaved'
import { identity, uid } from './actions'
import { get, markStale, set, toast, type PlateEntry, type PlateVolumeEntry } from './store'

/**
 * Opens a 3MF project with its objects, parts and volumes (negative parts, support blockers and
 * enforcers). Returns false when the file is not one we can read as a project, so the caller falls back
 * to the engine's own loader; `told` when it already showed the person a note of its own.
 */
export async function addProject(host: Host, data: ArrayBuffer, name: string, scope?: OpenScope): Promise<false | 'opened' | 'told'> {
  const { scanProjectFile, projectOf, ProjectReadError } = await import('../export/import3mf')
  // A project opened onto an empty plate shows its own picture of the plate at once, until its objects are there.
  const empty = get().plates.every((p) => p.objects.length === 0) && get().plate.length === 0
  const hidePreview = empty ? (await import('../project/opening-preview')).showOpeningPreview(new Uint8Array(data), name) : () => undefined
  try {
    return await addProjectShown(host, data, name, scope, { scanProjectFile, projectOf, ProjectReadError }, hidePreview)
  } finally {
    hidePreview()
  }
}

async function addProjectShown(
  host: Host,
  data: ArrayBuffer,
  name: string,
  scope: OpenScope | undefined,
  { scanProjectFile, projectOf, ProjectReadError }: Pick<typeof import('../export/import3mf'), 'scanProjectFile' | 'projectOf' | 'ProjectReadError'>,
  hidePreview: () => void,
): Promise<false | 'opened' | 'told'> {
  // The open's own changes, so an edit made while it runs is not taken for part of it.
  const mine = <T>(fn: () => T): T => (scope ? scope.run(fn) : fn())
  let project
  let scanned
  try {
    // Inflated and scanned in the project worker; only the settings files and the layout are read here.
    scanned = await scanProjectFile(new Uint8Array(data))
    markOpenStage('unzip', { at: scanned.unzippedAt })
    markOpenStage('parse', { at: scanned.scannedAt, parsedIn: scanned.parsedIn })
    project = await projectOf(scanned, get().bed)
  } catch (e) {
    if (e instanceof ProjectReadError && /too many|too large|unsafe|encrypted|inflates|damaged/.test(e.message)) throw e
    return false
  }
  const { addPlate, switchPlate } = await import('../plate/plates')
  const own = /\.sx3mf$/i.test(name)
  const hasSettings = Object.keys(project.settings).length > 0
  let wasEmpty = get().plates.every((p) => p.objects.length === 0) && get().plate.length === 0
  // Another slicer's project onto a plate that has objects asks: the whole project in its place, or its geometry alone.
  // Our own designs add to the plate as they are.
  let geometryOnly = false
  if (!wasEmpty && hasSettings && !own) {
    const choice = await (await import('../project/open-ask')).askOpenProject(name)
    if (choice === null) return 'told'
    if (choice === 'geometry') geometryOnly = true
    else {
      if (!(await confirmDiscard('open this project'))) return 'told'
      mine(() => clearProject())
      wasEmpty = true
    }
  }
  // A project onto plates the person emptied starts a clean project: the plates, printer and settings an earlier
  // project left behind go first, so they never mix with this one.
  if (wasEmpty && (get().projectSettings || get().projectPrinter)) mine(() => clearProject())
  // What the person had before this project, so clearing it later puts their values back.
  const overridesBefore = get().overrides
  // Every object goes to the engine now, side by side, while the printer is switched: a mesh does not depend on it.
  const loads = project.plates.map((pl) => pl.objects.map((o) => host.slicer.loadParts(o.name, o.parts)))
  for (const l of loads.flat()) l.catch(() => undefined)
  // Another slicer's project opens as its own printer, first, so its objects land on that printer's bed.
  const asProject = wasEmpty && !own && project.settingsFrom === 'orca' && hasSettings
  const pp = asProject ? await import('../project/project-printer') : null
  let match: import('../project/project-printer').ProjectPrinterMatch | null = null
  if (pp) {
    // A printer of the person's own that matches it is picked over the project's own.
    const printers = host.printers ? await host.printers.list().catch(() => []) : []
    match = await pp.switchToProjectPrinter(name, project.settings, printers)
    markOpenStage('printer')
  }
  // Its objects on the bed the plate slices for: a layout made for a larger bed moves onto this one.
  const { placeOnSelectedBed } = await import('../project/place-import')
  let movedOnto = false
  for (const [i, pl] of project.plates.entries()) if (placeOnSelectedBed(pl.objects, get().bed, i === 0 ? get().plate : []) !== 'kept') movedOnto = true
  const startPlate = get().activePlate
  // Ids up front, so kept dimensions can name objects on any plate.
  const idOf = new Map<string, string>()
  for (const pl of project.plates) for (const o of pl.objects) if (!idOf.has(o.fileId)) idOf.set(o.fileId, uid('obj'))
  const dimsOf = (fileId: string) =>
    project.dimensions
      .filter((d) => d.a.object === fileId)
      .map((d) => ({ ...d, a: { ...d.a, object: idOf.get(d.a.object)! }, ...(d.b ? { b: { ...d.b, object: idOf.get(d.b.object)! } } : {}) }))
  if (project.historyNote) toast(project.historyNote, 'warn')
  // Named values come with the project; a name the open project already has keeps its own value.
  if (project.namedValues.length) {
    mine(() => set((s) => ({ namedValues: [...s.namedValues, ...project.namedValues.filter((v) => !s.namedValues.some((o) => o.name === v.name))] })))
  }
  // The file's filament colors stay per slot; a second file only fills slots the first left without one.
  if (project.colors.length) mine(() => set((s) => ({ fileSlotColors: wasEmpty ? [...project.colors] : project.colors.map((c, i) => s.fileSlotColors[i] ?? c) })))
  const placed = new Set<string>()
  // Every setting key the file brings, so a value the engine refuses can be dropped at the slice.
  const brought = new Set<string>()
  const rangesLeft = new Set<string>()
  const { usableRanges } = await import('../plate/layer-ranges')
  const entries = async (objects: typeof project.plates[number]['objects'], handles: Promise<MeshHandle>[]): Promise<PlateEntry[]> => {
    const out: PlateEntry[] = []
    for (const [k, o] of objects.entries()) {
      const handle = await (handles[k] ?? host.slicer.loadParts(o.name, o.parts))
      const volumes: PlateVolumeEntry[] = []
      for (const v of o.volumes) {
        // Centered on its own origin with the placement in `local`, so the position fields read as an offset.
        const b = bounds([v.part], identity())
        const c: [number, number, number] = b ? [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2] : [0, 0, 0]
        const move = (d: [number, number, number]) => compose({ position: d, rotation: [0, 0, 0], scale: [1, 1, 1] })
        const centeredPart = bake(v.part, move([-c[0], -c[1], -c[2]]))
        const vh = await host.slicer.loadParts(v.name, [centeredPart])
        const mod = !geometryOnly && v.role === 'modifier' && v.rawSettings ? (await import('../export/project-settings')).modifierSettings(v.rawSettings) : undefined
        for (const k of Object.keys(mod ?? {})) brought.add(k)
        volumes.push({ id: uid('vol'), name: v.name, role: v.role, handle: vh, part: centeredPart, local: move(c), ...(mod && Object.keys(mod).length ? { settings: mod } : {}) })
      }
      const palette = objectPalette()
      const colors = project.colors.length ? project.colors : palette
      const partSettings: Record<string, Record<string, SettingValue>> = {}
      for (const [part, raw] of Object.entries(geometryOnly ? {} : (o.rawPartSettings ?? {}))) {
        const v = (await import('../export/project-settings')).modifierSettings(raw)
        if (Object.keys(v).length) partSettings[part] = v
        for (const k of Object.keys(v)) brought.add(k)
      }
      // A file object placed twice keeps its dimensions on the first placement only.
      const first = !placed.has(o.fileId)
      placed.add(o.fileId)
      const dims = first ? dimsOf(o.fileId) : []
      // So does its CAD history, which needs the parts to be the ones it made.
      const history = first ? project.histories.get(o.fileId) : undefined
      // Its settings by height, what of them the plate can use.
      const ranges = !geometryOnly && o.layerRanges ? usableRanges(o.layerRanges) : null
      for (const k of ranges?.left ?? []) rangesLeft.add(k)
      out.push({ id: first ? idOf.get(o.fileId)! : uid('obj'), name: o.name, ...(dims.length ? { dimensions: dims } : {}), ...(history ? { history } : {}), handle, parts: o.parts, ...(Object.keys(partSettings).length ? { partSettings } : {}), colors: o.parts.map((p) => colors[p.slot - 1] ?? palette[0]!), transform: o.transform, ...(o.paint ? { paint: o.paint } : {}), ...(o.printable === false ? { printable: false } : {}), ...(o.brimPoints?.length ? { brimPoints: o.brimPoints } : {}), ...(volumes.length ? { volumes } : {}), ...(o.source ? { source: o.source } : {}), ...(ranges?.ranges.length ? { layerRanges: ranges.ranges } : {}) })
    }
    return out
  }
  for (const [i, plate] of project.plates.entries()) {
    if (plate.objects.length === 0) continue
    const made = await entries(plate.objects, loads[i] ?? [])
    markOpenStage('engine')
    if (i > 0) {
      const id = mine(() => addPlate({ ...(plate.sequence ? { sequence: plate.sequence } : {}), ...(plate.nozzleMap ? { nozzleMap: plate.nozzleMap } : {}) }))
      mine(() => set((s) => ({ plates: s.plates.map((p) => (p.id === id ? { ...p, name: plate.name } : p)) })))
    }
    mine(() => set((s) => ({ plate: [...s.plate, ...made], selection: made[0]?.id ?? s.selection })))
    markOpenStage('objects')
    hidePreview()
    if (plate.marks?.length) {
      const { customGcodeProblem, markId } = await import('../plate/layer-marks')
      // Custom text from a file is untrusted: it passes the same check as text typed in.
      const ok = plate.marks.filter((m) => m.kind !== 'custom' || customGcodeProblem(m.gcode ?? '') === null).map((m) => ({ id: markId(), z: m.z, kind: m.kind, ...(m.kind === 'custom' ? { gcode: (m.gcode ?? '').trim() } : {}) }))
      mine(() => set((s) => ({ layerMarks: { ...s.layerMarks, [s.activePlate]: [...(s.layerMarks[s.activePlate] ?? []), ...ok].sort((a, b) => a.z - b.z) } })))
    }
    const sequence = plate.sequence
    if (i === 0 && sequence) mine(() => set((s) => ({ plates: s.plates.map((p) => (p.id === s.activePlate ? { ...p, settings: { ...p.settings, sequence } } : p)) })))
    const nozzleMap = plate.nozzleMap
    if (i === 0 && nozzleMap) mine(() => set((s) => ({ plates: s.plates.map((p) => (p.id === s.activePlate ? { ...p, settings: { ...p.settings, nozzleMap } } : p)) })))
  }
  mine(() => switchPlate(startPlate))
  // An Orca or Bambu Studio project (anything but our .sx3mf) opens with its own fixed layers, so
  // sleipnir goes off and the layer count matches the slicer that made it.
  if (wasEmpty && !own) mine(() => set((s) => ({ easy: { ...s.easy, varyLayerHeight: false }, goal: 'custom' as const })))
  let note: string | null = null
  if (pp) {
    // Another slicer's project: its settings on top of its own printer's profile, or what suits the current printer.
    const r = mine(() => pp.applyProjectSettings(name, project.settings, match))
    markOpenStage('settings')
    for (const k of r.keys) brought.add(k)
    note = r.note
  } else if (wasEmpty && hasSettings) {
    // Our own project, or a PrusaSlicer one: its print and filament settings on the current printer.
    const { projectSettingChanges } = await import('../export/project-settings')
    const { values } = projectSettingChanges(project.settings, resolveConfig(get().easy, get().overrides))
    const n = Object.keys(values).length
    if (n) {
      mine(() => set((s) => ({ overrides: { ...s.overrides, ...values }, goal: 'custom' as const })))
      note = `Applied ${n} settings from ${name}`
    }
    for (const k of Object.keys(values)) brought.add(k)
    // Its printer G-code: stock text needs nothing, anything else waits for the person at the next slice.
    markOpenStage('settings')
    mine(() => undefined)
    await (await import('./project-gcode')).reviewOpenedGcode(name, project.settings)
    markOpenStage('gcode')
  }
  if (!geometryOnly && (await import('../plate/layer-ranges')).layerHeightsDiffer(get().plate)) {
    note = `${note ? `${note} ` : ''}Per-object layer heights are not imported yet: its objects change layer height at different heights, so the plate uses one layer height.`
  }
  if (movedOnto) note = `${note ? `${note} ` : ''}Its objects were off this bed where the file placed them, so they were moved onto it.`
  if (rangesLeft.size) {
    const { settingDef } = await import('@slicerx/settings')
    note = `${note ? `${note} ` : ''}Not imported from its height ranges: ${[...rangesLeft].map((k) => (settingDef(k)?.label ?? k).toLowerCase()).join(', ')}.`
  }
  if (brought.size) {
    const prior: Record<string, SettingValue | null> = {}
    for (const k of brought) {
      const was = overridesBefore[k]
      if (JSON.stringify(get().overrides[k]) !== JSON.stringify(was)) prior[k] = was === undefined ? null : was
    }
    mine(() => set((s) => ({ projectSettings: { source: name, keys: [...new Set([...(wasEmpty ? [] : (s.projectSettings?.keys ?? [])), ...brought])], prior: { ...prior, ...(wasEmpty ? {} : s.projectSettings?.prior) } } })))
  }
  markStale()
  if (!note) return 'opened'
  // A newer open took over meanwhile: its note is the one to show.
  mine(() => undefined)
  toast(note, 'info', match?.kind === 'match' ? pp?.CHANGE_PRINTER : undefined)
  return 'told'
}

