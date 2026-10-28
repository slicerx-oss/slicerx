// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Another slicer's project opened on the printer a slice names, the way the app opens it: the printer's layer (the
// maker's machine, process and filament presets as the app builds them, sleipnir off and aegis walls), then what the
// app's project open applies over it. A PrusaSlicer project's print and filament values go on that printer. A Bambu
// Studio or Orca project made for it opens as on its own printer, with what it changed of the printer; one made for
// another printer carries its settings over as the app does when the person switches printers. The engine then slices
// the same settings the app sends.
import type { EasyGoal, SettingValue } from '@slicerx/contracts'
import { EASY_DEFAULTS } from '@slicerx/contracts'
import { subban } from '@slicerx/ui/theme'
import { areaOrigin } from '@slicerx/threemf/area'
import { loadFlushData } from '@slicerx/settings/flush'
import { FLUSH_DEFAULTS } from '@slicerx/settings/flush-defaults'
import { defaultSlotColors, normalizeColor, objectPaletteColors, plateTowerIndexes, projectFlushFrom, projectTowerFrom, slotSettings } from '@slicerx/settings/slot-settings'
import { carryOver, GCODE_TEXT_KEYS, layerConfig, matchProjectPrinter, nearestGoalBy, printerProfile, projectPrinterChanges, projectSettingChanges, sliceBedType, stockLayer, type ProjectPrinterMatch } from '@slicerx/settings'
import type { ProfileCatalog } from './profiles'
import type { ProjectRead } from './projectfile'

/** The settings the app slices an opened project with on one printer, and what the slice needs to know about them. */
export interface OpenedProject {
  /** The printer profile the project slices on, such as `prusa-mk4`. */
  printer: string
  nozzle: number
  /** Every setting, as the app sends them: the printer's layer, then the project's. */
  config: Record<string, SettingValue>
  /** The project slices on its own printer, so its G-code goes through the review (the app's project printer). */
  ownGcode: boolean
}

/** A project open leaves sleipnir off: the layers are the project's (open-project.ts). The other Easy controls keep the layer's values. */
const OPENED_EASY = { ...EASY_DEFAULTS, varyLayerHeight: false }
const LAYER_TOUCHED: ReadonlySet<string> = new Set(['smartLayer', 'varyLayerHeight'])

/**
 * The printer a project opens on and how its settings reach it, following the app: the last `machine:` profile in
 * `names` is the printer the person slices for, and `nozzle` the nozzle the slice asks for. Without one there is no
 * printer to open the project on, and the slice keeps to the project's own settings, as `sx slice <project.3mf>` does.
 * A Bambu Studio or Orca project for that printer opens as the app opens it on its own printer (`project`); for another
 * printer SlicerX has a profile for, it opens there and moves to the named one (`switched`); a PrusaSlicer project, or
 * one for a printer SlicerX has no profile for, opens on the named printer (`current`).
 */
function route(read: ProjectRead, profiles: ProfileCatalog, names: readonly string[], nozzle: number | undefined): { printer: string; nozzle: number | undefined; match: ProjectPrinterMatch | null; mode: 'current' | 'project' | 'switched' } | undefined {
  const opened = read.opened
  const named = names.map((n) => profiles.find(n)?.id).filter((id): id is string => id?.startsWith('machine:') === true).pop()?.slice('machine:'.length)
  if (!opened || !named) return undefined
  if (opened.from === 'prusaslicer') return { printer: named, nozzle, match: null, mode: 'current' }
  const match = matchProjectPrinter(opened.settings)
  if (match?.kind !== 'match') return { printer: named, nozzle, match, mode: 'current' }
  const same = named === match.profileId && (nozzle === undefined ? match.nozzle === printerProfile(named)?.defaultNozzle : Math.abs(nozzle - match.nozzle) < 1e-6)
  return same ? { printer: named, nozzle: match.nozzle, match, mode: 'project' } : { printer: named, nozzle, match, mode: 'switched' }
}

/**
 * The slots a fresh plate gives a project's filaments (resolveSlots and slotsOf in the app): PLA, one, or one per slot
 * up to the last its parts print with.
 */
function plateSlots(read: ProjectRead): { type: string }[] {
  const n = read.opened?.slots ?? 1
  return Array.from({ length: n >= 2 ? n : 1 }, () => ({ type: 'PLA' }))
}

/**
 * The settings `read`'s project slices with on the printer the slice names, as the app opens it; undefined when the
 * slice names no printer, or the project is SlicerX's own.
 */
export async function openProject(read: ProjectRead, profiles: ProfileCatalog, names: readonly string[], nozzle: number | undefined, plate?: number): Promise<OpenedProject | undefined> {
  const r = route(read, profiles, names, nozzle)
  if (!r || !read.opened) return undefined
  const { settings, from } = read.opened
  const slots = plateSlots(read)
  const layerFor = (printer: string, tier: EasyGoal, mm: number | undefined) => stockLayer({ printerId: printer, tier, slots, nozzle: mm })
  // The printer the project opens on, on the Standard tier a fresh plate starts from: on a switch, the project's own.
  const opensOn = r.mode === 'switched' && r.match?.kind === 'match' ? { printer: r.match.profileId, nozzle: r.match.nozzle } : { printer: r.printer, nozzle: r.nozzle }
  const at = await layerFor(opensOn.printer, 'standard', opensOn.nozzle)
  if (!at) return undefined
  const current = layerConfig(at.values, OPENED_EASY, LAYER_TOUCHED)
  // What the open puts over the printer's settings: a PrusaSlicer project's values (open-project.ts), another
  // project's through the project printer route (project-printer.ts applyProjectSettings).
  let values = from === 'prusaslicer' ? projectSettingChanges(settings, current as never).values : projectPrinterChanges(settings, r.match, current as never, at.nozzle).values
  // Another slicer's project leaves the goal custom, and the plate starts from the goal nearest its layer height.
  const tier = nearestGoalBy({ ...current, ...values }, (g) => at.goalValues[g]?.['layer_height'])
  let printer = opensOn
  if (r.mode === 'switched') {
    // The person's printer instead of the project's: the settings made for the project's nozzle stay behind (leaveProjectPrinter).
    const to = await layerFor(r.printer, 'standard', r.nozzle)
    if (!to) return undefined
    values = carryOver(values, GCODE_TEXT_KEYS, Math.abs(to.nozzle - at.nozzle) < 1e-6).kept
    printer = { printer: r.printer, nozzle: r.nozzle }
  }
  const layer = await layerFor(printer.printer, tier, printer.nozzle)
  if (!layer) return undefined
  const config = { ...layerConfig(layer.values, OPENED_EASY, LAYER_TOUCHED), ...values }
  const slotKeys = slots.length >= 2 ? await plateSlotKeys(read, config, layerConfig(at.values, OPENED_EASY, LAYER_TOUCHED), plate) : {}
  return { printer: layer.printerId, nozzle: layer.nozzle, config: { ...config, ...slotKeys, ...sliceBedType(config) }, ownGcode: r.mode === 'project' }
}

/**
 * The filament keys of a plate of two or more slots, as the app's slot config gives them on a fresh plate (slots.ts
 * resolveSlots, slot-config.ts): each slot's color from the file (where it names none, its parts' color on open, else a
 * default), PLA, no brand; the flush matrix, the file's own while it has one for those filaments; and for another
 * slicer's project with
 * project_settings.config, the tower spot it saved for the plate (project-kept.ts keepProjectFlushAndTower).
 * `opensOn` is the settings of the printer the project opened on, whose bed the file's spot is read against.
 */
async function plateSlotKeys(read: ProjectRead, cfg: Record<string, SettingValue>, opensOn: Record<string, SettingValue>, plate: number | undefined): Promise<Record<string, SettingValue>> {
  const { settings, from, slots, used } = read.opened!
  // The measured flush tables, which the app has loaded by the time it slices.
  await loadFlushData()
  const colors = Array.isArray(settings['filament_colour']) ? settings['filament_colour'].filter((c): c is string => typeof c === 'string') : []
  const fallback = defaultSlotColors(subban.colors.purple)
  // A slot the file names no color for takes the color the app gave its first part on open (open-project.ts): the
  // object palette's first while the file names any colors, else the palette's own for that slot.
  const palette = objectPaletteColors(subban.colors.purple)
  const partColor = (i: number) => (used.includes(i + 1) ? (colors.length ? palette[0] : palette[i] ?? palette[0]) : undefined)
  const list = Array.from({ length: slots }, (_, i) => ({ color: normalizeColor(colors[i] ?? partColor(i), fallback[i % 8]!), type: 'PLA', brand: '' }))
  let tower = { auto: true, x: 0, y: 0 }
  const projectFlush = from === 'orca' ? projectFlushFrom(settings) : null
  if (from === 'orca') {
    const plates = read.summary.plates
    const indexes = plateTowerIndexes(plates.map((p) => p.index))
    const origin = areaOrigin(opensOn['printable_area'])
    const towers = plates.map((_, i) => (indexes[i] === null || indexes[i] === undefined ? null : projectTowerFrom(settings, origin, indexes[i]!)))
    const at = Math.max(0, plates.findIndex((p) => p.index === (plate ?? plates[0]?.index)))
    const own = towers[at]
    if (towers.some(Boolean) && own) tower = { auto: false, ...own }
  }
  return slotSettings({ cfg, list, flush: FLUSH_DEFAULTS, nozzleVolume: 0, projectFlush, tower, origin: areaOrigin(cfg['printable_area']) })
}
