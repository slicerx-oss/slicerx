// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opening a 3MF project onto the plate (actions.ts hands project files here): loaded with the first project, so none
// of it is in the app's startup code.
import type { Host, MeshHandle, SettingValue } from '@slicerx/contracts'
import { resolveConfig } from '../adapters/config'
import { objectPalette } from '../edition'
import { withAutoSpools } from '../filament/pick'
import { projectSlotTypes, projectSlotVendors } from '@slicerx/settings/slot-settings'
import { markOpenStage } from '../lib/open-mark'
import { bake } from '../plate/mesh-ops'
import type { ImportedObject } from '../export/import3mf'
import { clearanceFor } from '../plate/clearance'
import { slotCount, usedSlots } from '../filament/slots'
import { bounds, compose } from '../plate/transform'
import { clearProject } from '../project/new'
import { keepBeforeOpen } from '../project/autosave'
import type { OpenScope } from '../project/unsaved'
import { identity, uid } from './actions'
import { get, markStale, openNote, set, toast, type PlateEntry, type PlateVolumeEntry, type ToastAction } from './store'
import { quietly } from '../plate/history'

/**
 * Opens a 3MF project with its objects, parts and volumes (negative parts, support blockers and
 * enforcers). Returns false when the file is not one we can read as a project, so the caller falls back
 * to the engine's own loader; `told` when it already showed the person a note of its own.
 */
export async function addProject(host: Host, data: ArrayBuffer, name: string, scope?: OpenScope): Promise<false | 'opened' | 'told'> {
  const { scanProjectFile, projectOf, ProjectReadError } = await import('../export/import3mf')
  return addProjectShown(host, data, name, scope, { scanProjectFile, projectOf, ProjectReadError })
}

async function addProjectShown(
  host: Host,
  data: ArrayBuffer,
  name: string,
  scope: OpenScope | undefined,
  { scanProjectFile, projectOf, ProjectReadError }: Pick<typeof import('../export/import3mf'), 'scanProjectFile' | 'projectOf' | 'ProjectReadError'>,
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
      // Unsaved work is kept as a recent project first, with no question (keepBeforeOpen).
      if (!(await keepBeforeOpen(host, 'open this project'))) return 'told'
      mine(() => clearProject())
      wasEmpty = true
    }
  }
  // A project onto plates the person emptied starts a clean project: the plates, printer and settings an earlier
  // project left behind go first, so they never mix with this one.
  if (wasEmpty && (get().projectSettings || get().projectPrinter)) mine(() => clearProject())
  // What the person had before this project, so clearing it later puts their values back.
  const overridesBefore = get().overrides
  const beforeImport = get()
  const selectedFlavor = resolveConfig(beforeImport.easy, beforeImport.overrides).gcode_flavor
  const scriptTarget = beforeImport.printerId && beforeImport.printerId !== 'project-printer' && beforeImport.profile && typeof selectedFlavor === 'string'
    ? { model: beforeImport.profile.printerId, firmware: selectedFlavor }
    : null
  // A plain 3MF's objects that touch or overlap are one model's parts: they open as one object with those parts.
  const joins = !own && !hasSettings ? await joinTouching(project.plates, name) : []
  // The objects go to the engine now, while the printer is switched: a mesh does not depend on it. One plate at a time,
  // in the file's order: each load encodes its object whole before it goes (about 18 bytes a triangle), and a big
  // project's plates sent side by side held every one of those copies at once. A plate's own objects go together.
  let before: Promise<unknown> = Promise.resolve()
  const loads = project.plates.map((pl) => {
    const gate = before
    const handles = pl.objects.map((o) => gate.then(() => host.slicer.loadParts(o.name, o.parts)))
    // an empty plate waits for the one before it too
    before = Promise.allSettled([gate, ...handles])
    return handles
  })
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
  if (project.earsNote) toast(project.earsNote, 'warn')
  // Paint the project cannot show opens unpainted (paint-check.ts). Its filaments are the ones on the rail once it is
  // open: the printer's, those set by hand, those its parts and tool changes use, never fewer than the file lists. A
  // file of another app may list only the filaments its parts use, so paint on another one would otherwise be lost.
  const painted = project.plates.flatMap((pl) => pl.objects.filter((o) => o.paint))
  if (painted.length) {
    const { checkOpenedPaint } = await import('../export/paint-check')
    const fileSlots = project.plates.flatMap((pl) => [...pl.objects.flatMap((o) => o.parts.map((p) => p.slot)), ...(pl.marks ?? []).flatMap((m) => (m.kind === 'tool_change' && !m.skip && m.slot ? [m.slot] : []))])
    const filaments = Math.max(slotCount(get()), project.colors.length, ...fileSlots)
    const paintNote = checkOpenedPaint(painted.map((o) => o.paint!), filaments)
    for (const o of painted) if (!Object.keys(o.paint!).length) delete o.paint
    if (paintNote) toast(paintNote, 'warn')
  }
  // The design timeline as it was before the open: the file's goes in at its marker once every object is placed.
  const designBefore = get().timeline
  // Named values come with the project; a name the open project already has keeps its own value.
  if (project.namedValues.length) {
    mine(() => set((s) => ({ namedValues: [...s.namedValues, ...project.namedValues.filter((v) => !s.namedValues.some((o) => o.name === v.name))] })))
  }
  // The file's filament colors stay per slot; a second file only fills slots the first left without one.
  if (project.colors.length) mine(() => set((s) => ({ fileSlotColors: wasEmpty ? [...project.colors] : project.colors.map((c, i) => s.fileSlotColors[i] ?? c) })))
  // So do its filament makers, which the slice sends while a slot holds the file's filament.
  const vendors = projectSlotVendors(project.settings)
  if (vendors.length) mine(() => set((s) => ({ fileSlotVendors: wasEmpty ? vendors : vendors.map((v, i) => s.fileSlotVendors[i] || v) })))
  // And its filament types, which a slot the person has not set takes in place of PLA.
  const types = projectSlotTypes(project.settings)
  if (types.length) mine(() => set((s) => ({ fileSlotTypes: wasEmpty ? types : types.map((t, i) => s.fileSlotTypes[i] || t) })))
  const placed = new Set<string>()
  // Every setting key the file brings, so a value the engine refuses can be dropped at the slice.
  const brought = new Set<string>()
  // The plate settings the open pinned from the project's values, which the layer it lands on may already give.
  const pinned = new Set<string>()
  const rangesLeft = new Set<string>()
  // Each object's own settings from the file, by its plate entry, as the object settings panel sets them.
  const fileObjectSettings: Record<string, Record<string, SettingValue>> = {}
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
      const objectRaw = geometryOnly ? undefined : o.rawObjectSettings
      const objectOwn = objectRaw && Object.keys(objectRaw).length ? (await import('../export/project-settings')).modifierSettings(objectRaw) : {}
      for (const k of Object.keys(objectOwn)) brought.add(k)
      // A file object placed twice keeps its dimensions on the first placement only.
      const first = !placed.has(o.fileId)
      placed.add(o.fileId)
      const dims = first ? dimsOf(o.fileId) : []
      // So does its CAD history, which needs the parts to be the ones it made.
      const history = first ? project.histories.get(o.fileId) : undefined
      // Its settings by height, what of them the plate can use.
      const ranges = !geometryOnly && o.layerRanges ? usableRanges(o.layerRanges) : null
      for (const k of ranges?.left ?? []) rangesLeft.add(k)
      const entry: PlateEntry = { id: first ? idOf.get(o.fileId)! : uid('obj'), name: o.name, ...(dims.length ? { dimensions: dims } : {}), ...(history ? { history } : {}), handle, parts: o.parts, ...(Object.keys(partSettings).length ? { partSettings } : {}), colors: o.parts.map((p) => colors[p.slot - 1] ?? palette[0]!), transform: o.transform, ...(o.paint ? { paint: o.paint } : {}), ...(o.printable === false ? { printable: false } : {}), ...(o.brimPoints?.length ? { brimPoints: o.brimPoints } : {}), ...(volumes.length ? { volumes } : {}), ...(o.source ? { source: o.source } : {}), ...(ranges?.ranges.length ? { layerRanges: ranges.ranges } : {}) }
      if (Object.keys(objectOwn).length) fileObjectSettings[entry.id] = objectOwn
      // a part the file gives no filament starts on the auto-picked spool
      out.push(o.noSlot?.length ? withAutoSpools([entry], { own: (_e, part) => !o.noSlot!.includes(part) })[0]! : entry)
    }
    return out
  }
  // The app's plate made of each of the file's plates, with the file's plate number (the project's tower spots are per plate).
  const madePlates: { id: string; plateNo?: number }[] = []
  // Each plate's objects with the layer height profiles the file gives them, taken once the settings are in.
  const fileProfiles: { plateId: string; objects: import('../plate/layer-profile').FileObjectProfile[] }[] = []
  for (const [i, plate] of project.plates.entries()) {
    // A project opened as the job keeps the file's plates as they are, empty ones too, so plate N here is plate N in the
    // file. Added to plates the person already has, it brings only the plates with objects on them.
    if (plate.objects.length === 0 && !wasEmpty) continue
    const made = await entries(plate.objects, loads[i] ?? [])
    markOpenStage('engine')
    if (i > 0) {
      const id = mine(() => addPlate({ ...(plate.sequence ? { sequence: plate.sequence } : {}), ...(plate.nozzleMap ? { nozzleMap: plate.nozzleMap } : {}), ...(plate.bedType ? { bedType: plate.bedType } : {}) }))
      mine(() => set((s) => ({ plates: s.plates.map((p) => (p.id === id ? { ...p, name: plate.name } : p)) })))
      madePlates.push({ id, ...(plate.plateNo ? { plateNo: plate.plateNo } : {}) })
    } else {
      madePlates.push({ id: get().activePlate, ...(plate.plateNo ? { plateNo: plate.plateNo } : {}) })
      // The plate the project opens onto drops layer heights drawn for objects that are gone, as a new plate never
      // takes them; the file's own come in below.
      if (wasEmpty && get().plates.find((p) => p.id === get().activePlate)?.settings.layerProfile) {
        const { setPlateLayerProfile } = await import('../plate/plates')
        mine(() => setPlateLayerProfile(get().activePlate, null))
      }
    }
    if (i === 0 && wasEmpty && !/^Plate \d+$/.test(plate.name)) {
      // The file's first plate is the one the project opens onto, so it takes the file's name as the others do.
      mine(() => set((s) => ({ plates: s.plates.map((p) => (p.id === s.activePlate ? { ...p, name: plate.name } : p)) })))
    }
    if (wasEmpty && !geometryOnly && plate.objects.some((o) => o.layerProfile?.length)) fileProfiles.push({ plateId: madePlates[madePlates.length - 1]!.id, objects: plate.objects.map((o, k) => ({ name: o.name, ...(o.layerProfile ? { points: o.layerProfile } : {}), ...(made[k] ? { entry: made[k] } : {}) })) })
    mine(() => set((s) => ({ plate: [...s.plate, ...made], objectSettings: { ...s.objectSettings, ...fileObjectSettings }, selection: made[0]?.id ?? s.selection })))
    markOpenStage('objects')
    if (plate.marks?.length) {
      const { customGcodeProblem, markId } = await import('../plate/layer-marks')
      // Custom text from a file is untrusted: it passes the same check as text typed in.
      const ok = plate.marks.filter((m) => m.kind !== 'custom' || customGcodeProblem(m.gcode ?? '') === null).map((m) => ({ id: markId(), z: m.z, kind: m.kind, ...(m.kind === 'custom' ? { gcode: (m.gcode ?? '').trim() } : {}), ...((m.kind === 'color_change' || m.kind === 'tool_change') && m.slot ? { slot: m.slot } : {}), ...(m.kind === 'tool_change' && m.skip ? { skip: m.skip } : {}) }))
      mine(() => set((s) => ({ layerMarks: { ...s.layerMarks, [s.activePlate]: [...(s.layerMarks[s.activePlate] ?? []), ...ok].sort((a, b) => a.z - b.z) } })))
    }
    const sequence = plate.sequence
    if (i === 0 && sequence) mine(() => set((s) => ({ plates: s.plates.map((p) => (p.id === s.activePlate ? { ...p, settings: { ...p.settings, sequence } } : p)) })))
    const nozzleMap = plate.nozzleMap
    if (i === 0 && nozzleMap) mine(() => set((s) => ({ plates: s.plates.map((p) => (p.id === s.activePlate ? { ...p, settings: { ...p.settings, nozzleMap } } : p)) })))
    // The plate's own plate type wins over the project's (curr_bed_type in its settings) and the printer's default.
    const bedType = plate.bedType
    if (i === 0 && bedType) mine(() => set((s) => ({ plates: s.plates.map((p) => (p.id === s.activePlate ? { ...p, settings: { ...p.settings, bedType } } : p)) })))
  }
  if (project.timeline) {
    const { joinTimelines, withBodyIds } = await import('@slicerx/cad-history')
    const ours = withBodyIds(project.timeline, (fileId) => idOf.get(fileId))
    mine(() => quietly(() => set({ timeline: joinTimelines(designBefore, ours) })))
    if (ours.marker < ours.items.length) mine((await import('../cad/history/rollback')).settleRollback)
  }
  mine(() => switchPlate(startPlate))
  // An Orca or Bambu Studio project (anything but our .sx3mf) opens with its own fixed layers, so
  // sleipnir goes off and the layer count matches the slicer that made it. This is the project's, not the person's
  // choice: the list of moved controls is passed on as it is, so profile sync does not mark sleipnir as moved, and the
  // next fresh plate has it back (lib/sleipnir-default.ts).
  if (wasEmpty && !own) mine(() => set((s) => ({ easy: { ...s.easy, varyLayerHeight: false }, goal: 'custom' as const, easyTouched: [...s.easyTouched] })))
  // Settings the file has but that could not be read are said, never dropped without a word.
  let note: string | null = project.settingsNote ?? null
  let offerNote: { action?: ToastAction; details: string; settle?: () => void } | undefined
  if (wasEmpty && hasSettings && !geometryOnly) {
    const { reviewImportedScripts } = await import('../project/script-review')
    const records = await reviewImportedScripts(host.slicer, project.settings, scriptTarget)
    mine(() => set({ projectScriptReviews: { source: name, records } }))
    // Its values for keys no setting models, for a printer G-code of its that names one (the variants that slice, as the
    // MCP server reads them).
    const { ProjectVariantError, selectVariants, unmodeledValues } = await import('@slicerx/settings')
    let picked = project.settings
    try {
      picked = selectVariants(project.settings)
    } catch (e) {
      if (!(e instanceof ProjectVariantError)) throw e
    }
    mine(() => set({ projectScriptKeys: unmodeledValues(picked) }))
  }
  // The keys the file's objects, parts and modifiers bring, which stay the project's whatever the plate values do.
  const objectBrought = new Set(brought)
  // What the open really changes against the layer it started from, which stays pinned whatever layer it lands on.
  const real = new Set<string>()
  if (pp) {
    // Another slicer's project: its settings on top of its own printer's profile, or what suits the current printer.
    const r = mine(() => pp.applyProjectSettings(name, project.settings, match))
    markOpenStage('settings')
    for (const k of r.keys) {
      brought.add(k)
      pinned.add(k)
    }
    // against the project printer's Standard layer, whatever goal the plate is on, as the MCP server measures them; the
    // plate's own layer only when there is no Standard one
    for (const k of pp.realChanges(project.settings, await pp.standardLayer(), true) ?? r.changed) real.add(k)
    note = r.note
    // What its settings did not carry over, with the engine choices and walls SlicerX used: Settings > Presets shows it.
    const { projectReport } = await import('@slicerx/settings')
    const report = projectReport(name, project.settings)
    mine(() => set({ projectImport: { name, report } }))
    const left = report.items.length
    if (left) note = `${note} Settings > Presets lists the ${left} ${left === 1 ? 'setting' : 'settings'} it did not carry over.`
    // the file's flush volumes and tower spot, as Bambu Studio opens them
    const { keepProjectFlushAndTower } = await import('../filament/project-kept')
    const kept = mine(() => keepProjectFlushAndTower(project.settings, madePlates))
    if (kept) note = `${note} ${kept}`
    // On a printer whose hotends are its tools (the H3C), the tools the project set by hand, read as the MCP server reads
    // them: the first plate prints on them, as it does with a filament map set by hand.
    const { projectHotends } = await import('@slicerx/settings/hotends')
    const first = madePlates[0]?.id
    const s = get()
    const hotends = first ? projectHotends(project.settings, resolveConfig(s.easy, s.overrides) as Record<string, unknown>, Math.max(slotCount(s), project.colors.length), [...usedSlots(s)]) : undefined
    if (hotends) mine(() => set((st) => ({ plates: st.plates.map((p) => (p.id === first ? { ...p, settings: { ...p.settings, hotendMap: hotends.map((h) => h + 1) } } : p)) })))
  } else if (wasEmpty && hasSettings) {
    mine(() => set({ projectImport: null }))
    // Our own project, or a PrusaSlicer one: its print and filament settings on the current printer.
    const { projectSettingChanges } = await import('../export/project-settings')
    // Every value it holds goes over the printer's, also one equal to the current value, so the nearest goal below
    // does not replace it; the note counts the real changes.
    const { values: changed, taken: values } = projectSettingChanges(project.settings, resolveConfig(get().easy, get().overrides))
    const pins = Object.keys(values).length
    // Its real changes against the Standard layer, whatever goal the plate is on; the note counts them.
    const { realChanges, standardLayer } = await import('../project/project-printer')
    for (const k of realChanges(project.settings, await standardLayer(), false) ?? Object.keys(changed)) real.add(k)
    const n = real.size
    // Our own project reopened with nothing changed against the plate brings nothing and keeps its goal.
    const apply = pins > 0 && (Object.keys(changed).length > 0 || !own)
    if (apply) mine(() => set((s) => ({ overrides: { ...s.overrides, ...values }, goal: 'custom' as const })))
    // A PrusaSlicer project made for another printer stays on this one, and its note offers the printer it was made for.
    const offer = project.settingsFrom === 'prusaslicer' ? await printerOffer(host, name, project.settings, values, n, [...real]) : null
    if (offer) {
      note = `${offer.text}${note ? ` ${note}` : ''}`
      offerNote = { ...(offer.action ? { action: offer.action } : {}), details: offer.details, ...(offer.settle ? { settle: offer.settle } : {}) }
    } else if (n && apply) note = `Applied ${n} settings from ${name}${note ? `. ${note}` : ''}`
    if (apply) {
      for (const k of Object.keys(values)) {
        brought.add(k)
        pinned.add(k)
      }
    }
    // Its printer G-code: stock text needs nothing, anything else waits for the person at the next slice.
    markOpenStage('settings')
    mine(() => undefined)
    await (await import('./project-gcode')).reviewOpenedGcode(name, project.settings)
    markOpenStage('gcode')
  }
  // Settings that match no goal start from the nearest one by layer height, its tile marked edited.
  if (wasEmpty && get().goal === 'custom') {
    const { nearestGoal } = await import('../lib/goal-edits')
    mine(() => set((s) => ({ goalBase: nearestGoal(resolveConfig(s.easy, s.overrides), s.profile?.goalValues) })))
  }
  // A pinned value the project did not change that equals the layer the plate now sits on is let go, so it follows a
  // later goal, filament or printer change as the layer's own values do; one that differs (a 0.2 mm gap on a Fine
  // layer) stays, and so do a real change (its 0.12 mm layers, on another printer's Fine too) and a person's own.
  // With no printer there is no layer yet, so the values stay until one is built. A value let go is no longer the
  // project's, so New project leaves a later edit to it alone.
  if (pinned.size) {
    await (await import('./profile-sync')).profileReady()
    mine(() =>
      set((s) => {
        if (!s.profile) return {}
        const layer = resolveConfig(s.easy, {}) as unknown as Record<string, SettingValue | undefined>
        const overrides = { ...s.overrides }
        for (const k of pinned) {
          if (real.has(k) || overridesBefore[k] !== undefined || !(k in overrides) || JSON.stringify(overrides[k]) !== JSON.stringify(layer[k])) continue
          delete overrides[k]
          if (!objectBrought.has(k)) brought.delete(k)
        }
        return { overrides }
      }),
    )
  }
  if (fileProfiles.length) {
    // The file's own layer heights, kept inside what this printer prints.
    const { layerLimits, MAX_POINTS, plateProfileFromFile } = await import('../plate/layer-profile')
    const { setPlateLayerProfile } = await import('../plate/plates')
    const limits = layerLimits(resolveConfig(get().easy, get().overrides))
    let clamped = false
    let dropped = false
    const mixed: string[] = []
    for (const { plateId, objects } of fileProfiles) {
      const got = plateProfileFromFile(objects, limits)
      if (!got) continue
      mine(() => setPlateLayerProfile(plateId, got.points))
      if (got.clamped) clamped = true
      if (got.dropped) dropped = true
      if (got.from) mixed.push(got.from)
    }
    if (mixed.length) note = `${note ? `${note} ` : ''}Its objects have different layer height profiles, and layers are shared on a plate, so ${mixed.length === 1 ? 'the plate uses the one of' : 'each plate uses the one of its tallest object:'} ${mixed.join(', ')}${mixed.length === 1 ? ', the tallest' : ''}.`
    if (clamped) note = `${note ? `${note} ` : ''}Its layer height profile asks for layers this printer does not print, so those use the nearest it does (${limits.minMm} to ${limits.maxMm} mm).`
    if (dropped) note = `${note ? `${note} ` : ''}Some points of its layer height profile were left out: unreadable or repeated ones, and past ${MAX_POINTS}, the ones that change the curve least.`
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
      // A person's own override the open kept as it was is recorded too, so New project gives it back.
      if (was !== undefined || JSON.stringify(get().overrides[k]) !== JSON.stringify(was)) prior[k] = was === undefined ? null : was
    }
    mine(() => set((s) => ({ projectSettings: { source: name, keys: [...new Set([...(wasEmpty ? [] : (s.projectSettings?.keys ?? [])), ...brought])], prior: { ...prior, ...(wasEmpty ? {} : s.projectSettings?.prior) } } })))
  }
  markStale()
  const joined = joins.flatMap((j) => {
    const e = get().plate.find((p) => p.id === idOf.get(j.joined.fileId))
    return e ? [{ ...j, id: e.id, parts: e.parts }] : []
  })
  if (joined.length) {
    const n = joined.reduce((sum, j) => sum + j.from.length, 0)
    note = `${note ? `${note} ` : ''}${n} of its objects touch, so they were loaded as ${joined.length === 1 ? 'one object' : `${joined.length} objects`} with parts.`
  }
  // What the reader left out of the file or read another way (paint in a newer format, parts of a type it does not
  // know, read as normal parts) is said too, on two lines (wrap), so it is not hidden behind Details.
  if (project.readerNote) note = `${note ? `${note} ` : ''}${project.readerNote}`
  if (!note) return 'opened'
  // A newer open took over meanwhile: its note is the one to show.
  mine(() => undefined)
  offerNote?.settle?.()
  openNote(note, joined.length ? { label: 'Keep separate', run: () => void keepSeparate(host, joined) } : match?.kind === 'match' ? pp?.CHANGE_PRINTER : offerNote?.action, offerNote ? { details: offerNote.details, wrap: true } : project.readerNote ? { wrap: true } : {})
  return 'told'
}

/** The open note's line about the printer a PrusaSlicer project was made for, and its Switch to (project-printer.ts). */
async function printerOffer(host: Host, name: string, settings: Record<string, unknown>, applied: Record<string, SettingValue>, changed: number, real: readonly string[]): Promise<import('../project/project-printer').PrinterNote | null> {
  const [{ projectPrinterNote }, { profileReady }] = await Promise.all([import('../project/project-printer'), import('./profile-sync')])
  await profileReady()
  const printers = host.printers ? await host.printers.list().catch(() => []) : []
  return projectPrinterNote(name, settings, printers, applied, changed, real)
}

/** A joined object, the file's objects it was made of, and where it was before the open placed it on this bed. */
type Join = { joined: ImportedObject; from: ImportedObject[]; at: number[] }

/** Joins each group of touching objects on each plate into one object with their parts (open-join.ts). */
async function joinTouching(plates: { objects: ImportedObject[] }[], name: string): Promise<Join[]> {
  const { touchGroups, touchingPairs, joinObjects } = await import('./open-join')
  const s = get()
  const minGapMm = clearanceFor(s).mm
  const layerHeightMm = Number(resolveConfig(s.easy, s.overrides)['layer_height']) || 0.2
  const out: Join[] = []
  for (const pl of plates) {
    if (pl.objects.length < 2) continue
    let pairs: [number, number][]
    try {
      pairs = await touchingPairs(pl.objects, minGapMm, layerHeightMm)
    } catch {
      continue
    }
    const groups = touchGroups(pl.objects.length, pairs)
    if (groups.length === 0) continue
    // All of the file's objects as one is the file's model, named for it, as Bambu Studio names it.
    const whole = groups.length === 1 && groups[0]!.length === pl.objects.length
    const lead = new Map(groups.map((g) => [g[0]!, g]))
    const taken = new Set(groups.flat())
    const objects: ImportedObject[] = []
    pl.objects.forEach((o, k) => {
      const g = lead.get(k)
      if (g) {
        const from = g.map((i) => pl.objects[i]!)
        const joined = joinObjects(from, whole ? name.replace(/\.3mf$/i, '') : o.name)
        out.push({ joined, from, at: [...joined.transform] })
        objects.push(joined)
      } else if (!taken.has(k)) objects.push(o)
    })
    pl.objects = objects
  }
  return out
}

/** The open note's Keep separate: each joined object back to the file's objects, where the joined one is now. */
async function keepSeparate(host: Host, joined: (Join & { id: string; parts: PlateEntry['parts'] })[]): Promise<void> {
  const { separateAgain } = await import('./open-join')
  for (const j of joined) {
    const now = get().plate.find((p) => p.id === j.id)
    // A joined object edited since (cut, parts changed) stays as it is.
    if (!now || now.parts !== j.parts) continue
    const at = separateAgain(now.transform, j.at, j.from)
    let k = 0
    const made: PlateEntry[] = []
    for (const [i, o] of j.from.entries()) {
      const colors = o.parts.map(() => now.colors[k++] ?? now.colors[0]!)
      made.push({ id: i === 0 ? now.id : uid('obj'), name: o.name, handle: await host.slicer.loadParts(o.name, o.parts), parts: o.parts, colors, transform: at[i]!, ...(o.source ? { source: o.source } : {}) })
    }
    if (get().plate.find((p) => p.id === j.id)?.parts !== j.parts) continue
    set((s) => ({ plate: s.plate.flatMap((p) => (p.id === j.id ? made : [p])), selection: made[0]!.id, selectedIds: made.map((e) => e.id) }))
    host.slicer.release?.(now.handle.id)
  }
  markStale()
}

