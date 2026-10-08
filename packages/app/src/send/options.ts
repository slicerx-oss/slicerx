// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print options a send offers per printer: what the printer does before or during the job. Which
// ones a printer supports, and their defaults, follow the maker's own slicer for that model (Bambu Studio's
// SelectMachineDialog and resources/printers/<model>.json; Orca's send dialog does the same).
import type { FilamentSlot, PrinterInfo, PrinterStatus, StartOptions } from '@slicerx/contracts'
// The connection methods alone: the catalog's model list stays out of the startup shell.
import { CONNECTION_METHODS } from '@slicerx/printer-catalog/methods'

export type SendOptionId = 'bedLeveling' | 'flowCalibration' | 'vibrationCompensation' | 'timelapse' | 'firstLayerInspection'

export type SendOptions = StartOptions

export interface SendOptionSpec {
  id: SendOptionId
  label: string
  /** What it does, when to turn it on or off, and the time it adds: the toggle's tooltip. */
  tip: { what: string; when: string; time: string }
  default: boolean
}

const BASE: Record<SendOptionId, Omit<SendOptionSpec, 'default'>> = {
  bedLeveling: {
    id: 'bedLeveling',
    label: 'Bed leveling',
    tip: { what: 'Probes the bed before the print and corrects the first layer for any tilt or dip.', when: 'Leave it on. Turn it off only for back-to-back prints on the same plate when the last first layer came out even.', time: 'Adds about 2 to 5 minutes.' },
  },
  flowCalibration: {
    id: 'flowCalibration',
    label: 'Flow dynamics calibration',
    tip: { what: 'Measures how this filament flows at speed and tunes pressure advance to match.', when: 'Keep it on for a new filament, a new nozzle or a fussy material. Turn it off once the filament is calibrated on this printer.', time: 'Adds about 1 to 3 minutes per filament.' },
  },
  vibrationCompensation: {
    id: 'vibrationCompensation',
    label: 'Vibration compensation',
    tip: { what: 'Shakes the axes to measure resonance and sets input shaping, which cuts ringing on walls.', when: 'Turn it on after moving the printer, changing belts or adding weight to the toolhead. Otherwise the last result is kept.', time: 'Adds about 1 to 2 minutes.' },
  },
  timelapse: {
    id: 'timelapse',
    label: 'Timelapse',
    tip: { what: 'Records a video of the print with the printer camera, one frame per layer.', when: 'Turn it on for a print you want to share or check later. Turn it off to save storage.', time: 'Adds a few seconds per layer while the toolhead parks for each frame.' },
  },
  firstLayerInspection: {
    id: 'firstLayerInspection',
    label: 'First layer inspection',
    tip: { what: 'Scans the first layer with the lidar and pauses the print if it finds a problem.', when: 'Leave it on. Turn it off for a first layer the scan misreads, such as a clear or very glossy filament.', time: 'Adds about a minute after the first layer.' },
  },
}

type Model = { match: RegExp; options: Partial<Record<SendOptionId, boolean>> }

/**
 * What Bambu Studio offers per model and what it starts with. It defaults each option to Auto where the model
 * has one and On otherwise; SlicerX sends on or off (Auto's wire value is not public), so Auto shows as on. It
 * turns timelapse off on the A1 series, never shows vibration compensation and sends it off, and sends first layer
 * inspection on, which only the X1 series (lidar) can do. Flow calibration is not offered on the P1 series.
 */
const BAMBU_MODELS: Model[] = [
  { match: /\bX1/i, options: { bedLeveling: true, flowCalibration: true, vibrationCompensation: false, timelapse: true, firstLayerInspection: true } },
  { match: /\bP1/i, options: { bedLeveling: true, vibrationCompensation: false, timelapse: true } },
  { match: /\bA1/i, options: { bedLeveling: true, flowCalibration: true, vibrationCompensation: false, timelapse: false } },
  { match: /\b(H2|P2)/i, options: { bedLeveling: true, flowCalibration: true, vibrationCompensation: false, timelapse: true } },
]

/** A Bambu Lab model the table does not know, and other makers: leveling and inspection on, the rest off. */
const FALLBACK: Record<SendOptionId, boolean> = { bedLeveling: true, flowCalibration: false, vibrationCompensation: false, timelapse: false, firstLayerInspection: true }

const ORDER: SendOptionId[] = ['bedLeveling', 'flowCalibration', 'vibrationCompensation', 'timelapse', 'firstLayerInspection']

const BAMBU = /bambu/i

/**
 * The options this printer can honor, with the maker's defaults: what its connection in the printer catalog
 * lists, narrowed to what the model has (no flow calibration on the P1 series, inspection only on the X1 series,
 * no timelapse without a camera). A connection the catalog does not know gets none.
 */
export function supportedOptions(printer: Pick<PrinterInfo, 'vendor' | 'model'> & { plugin?: string }, status?: Pick<PrinterStatus, 'cameraAvailable' | 'model'> | null): SendOptionSpec[] {
  const camera = status?.cameraAvailable ?? true
  const bambu = BAMBU.test(printer.vendor)
  const method = CONNECTION_METHODS.find((m) => m.id === printer.plugin) ?? (bambu ? CONNECTION_METHODS.find((m) => m.id === 'bambu-lan') : undefined)
  const listed = new Set<string>(method?.startOptions ?? [])
  // The model the printer reports wins over the one it was added as.
  const model = status?.model ?? printer.model
  const known = bambu ? BAMBU_MODELS.find((m) => m.match.test(model))?.options : undefined
  const a1 = /\ba1\b/i.test(model)
  const has = (id: SendOptionId): boolean => (known ? id in known : id === 'firstLayerInspection' ? !a1 : true)
  return ORDER.filter((id) => listed.has(id) && has(id) && (id === 'timelapse' ? camera : true)).map((id) => ({ ...BASE[id], default: known?.[id] ?? FALLBACK[id] }))
}

/** The tooltip text for an option: what it does, when to use it, the time it adds. */
export function optionTip(s: SendOptionSpec): string {
  return `${s.tip.what} ${s.tip.when} ${s.tip.time}`
}

export function defaultOptions(specs: readonly SendOptionSpec[]): SendOptions {
  return Object.fromEntries(specs.map((s) => [s.id, s.default])) as SendOptions
}

/** Saved choices for options the printer still supports, defaults for the rest. */
export function mergeOptions(specs: readonly SendOptionSpec[], saved: Partial<Record<SendOptionId, boolean>> | undefined): SendOptions {
  const out = defaultOptions(specs)
  for (const s of specs) if (typeof saved?.[s.id] === 'boolean') (out as Record<string, boolean>)[s.id] = saved[s.id]!
  return out
}

/**
 * Filament number (1 based, as the app and the Print sheet count them) to the printer's slot id, for the
 * filaments the print uses, in the printer's own slot order. Empty without an AMS or MMU. This is the
 * sheet's map; `startSlotMap` turns it into the start options' 0 based keys.
 */
export function slotMapFor(used: Iterable<number>, printerSlots: readonly FilamentSlot[]): Record<number, string> {
  const out: Record<number, string> = {}
  for (const n of used) {
    const slot = printerSlots[n - 1]
    if (slot) out[n] = slot.id
  }
  return out
}

/**
 * The one place the app turns its 1 based filament numbers into `StartOptions.slotMap`, whose keys are 0 based
 * filament indexes (filament 1 is key 0, the G-code's T0). Numbers below 1 are not filaments and are left out.
 */
export function startSlotMap(map: Record<number, string>): Record<number, string> {
  const out: Record<number, string> = {}
  for (const [k, id] of Object.entries(map)) {
    const n = Number(k)
    if (Number.isInteger(n) && n >= 1) out[n - 1] = id
  }
  return out
}

/** The start options without a slot map, for a printer that would not follow one. */
export function withoutSlotMap(o: SendOptions): SendOptions {
  const { slotMap: _gone, ...rest } = o
  return rest
}

/** One line per choice for the approval card. */
export function optionLines(specs: readonly SendOptionSpec[], o: SendOptions): string[] {
  return specs.map((s) => `${s.label}: ${o[s.id] ? 'on' : 'off'}`)
}

/** What the send step returns: the print options, whether to start after the upload, and the file's name on the printer. */
export interface SendChoice {
  options: SendOptions
  start: boolean
  name: string
  /** Upload now and keep the file in the queue for a start later. */
  queue?: { startAfter?: string }
  /**
   * Filament number (1 based, as the sheet shows it) to printer slot id, as the person set it. Absent when there is
   * nothing to map or the printer would not follow a map for this file.
   */
  slotMap?: Record<number, string>
  /**
   * The person chose "Send as plain G-code" after the printer refused the .gcode.3mf: the file goes as .gcode,
   * which the printer feeds as filament 1 from slot 1 and so on. Only ever set by that button.
   */
  plainGcode?: true
  /**
   * The print goes through Bambu Connect (send/bambu-connect.ts): the .gcode.3mf opens there and the person presses
   * Print in it. Set on a Bambu Lab printer with Developer Mode off, or by the sheet's button after a refusal.
   */
  bambuConnect?: true
}

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/

/** The rules Orca's send dialog applies to the name of a file sent to a printer (SendToPrinter.cpp): not empty, no space at either end, no illegal characters, not too long. Null when fine. */
export function jobNameProblem(name: string): string | null {
  if (name.length === 0) return 'The name cannot be empty.'
  if (name.startsWith(' ')) return 'The name cannot start with a space.'
  if (name.endsWith(' ')) return 'The name cannot end with a space.'
  if (ILLEGAL.test(name)) return 'The name cannot contain < > : " / \\ | ? * or control characters.'
  if (name.length > 100) return 'The name is too long.'
  return null
}

/** The name made fit for the printer by the same rules, so the sheet never has to ask for another one. */
export function safeJobName(name: string): string {
  const out = name.replace(new RegExp(ILLEGAL.source, 'g'), '-').trim().slice(0, 100).trim()
  return out || 'plate'
}

/** The name with a .gcode ending, the way the printer expects it. */
export function withGcodeEnding(name: string): string {
  return /\.(gcode|bgcode)$/i.test(name) ? name : `${name}.gcode`
}

/** The ending of the file a printer gets from the Print sheet. */
export type PrintEnding = '.gcode' | '.gcode.3mf'

/**
 * What the Print sheet sends: a .gcode.3mf to a Bambu Lab printer, which starts it with `project_file` and so
 * follows the slot choice, shows the plate's picture and lists its objects for skipping; plain .gcode elsewhere.
 */
export function printEnding(plugin: string | undefined): PrintEnding {
  return plugin === 'bambu-lan' ? '.gcode.3mf' : '.gcode'
}

/** The name without any print file ending. */
export function bareName(name: string): string {
  return name.replace(/\.(gcode\.3mf|3mf|gcode|bgcode)$/i, '')
}

/** The name with this ending, replacing any print file ending it had. */
export function withEnding(name: string, ending: PrintEnding): string {
  return ending === '.gcode' ? withGcodeEnding(name.replace(/\.(gcode\.3mf|3mf)$/i, '')) : `${bareName(name)}${ending}`
}

/** The external spool as the printer drivers name it: a slot id of "1" (Bambu tray 254). */
export const EXTERNAL_SLOT = '1'

export interface MapFilament {
  index: number
  color: string
  type: string
}

export interface MapSlot {
  id: string
  material?: string
  color?: string
}

const rgb = (hex: string | undefined): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})/i.exec(hex ?? '')
  if (!m) return null
  const n = parseInt(m[1]!, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Distance between two colors, 0 to 441. Colors that cannot be read are far apart. */
export function colorDistance(a: string | undefined, b: string | undefined): number {
  const x = rgb(a)
  const y = rgb(b)
  if (!x || !y) return 441
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

const baseType = (m: string | undefined): string => (m ?? '').toUpperCase().split(/[^A-Z0-9]+/)[0] ?? ''

/**
 * Loaded slots that can take over when the mapped one runs dry: another slot with the same material and a close
 * color, not already mapped to a filament of this print. The printer's own auto refill (Bambu AMS) works the same way, so
 * this shows what it will find. Different material or color does not qualify; a change like that would show in the print.
 */
export function backupSlots(filament: MapFilament, map: Readonly<Record<number, string>>, slots: readonly MapSlot[]): MapSlot[] {
  const mapped = new Set(Object.values(map))
  const own = map[filament.index]
  return slots.filter((s) => s.id !== own && s.id !== EXTERNAL_SLOT && !mapped.has(s.id) && baseType(s.material) === baseType(filament.type) && colorDistance(s.color, filament.color) < 60)
}

/**
 * The starting slot for each filament on a printer that follows a slot map, the way Bambu Studio's mapping
 * dialog picks it: a loaded slot of the same material, the closest color first, each slot used once. The
 * closest pairs across the whole plate go first, so one filament cannot take the slot another matches better. A
 * filament no loaded slot matches by material stays out of the map: the sheet shows it as not loaded and the
 * person picks a slot.
 */
export function matchSlots(filaments: readonly MapFilament[], slots: readonly MapSlot[]): Record<number, string> {
  const pairs: { f: number; s: string; d: number; order: number }[] = []
  slots.forEach((s, order) => {
    if (!s.material) return
    for (const f of filaments) if (baseType(s.material) === baseType(f.type)) pairs.push({ f: f.index, s: s.id, d: colorDistance(s.color, f.color), order })
  })
  pairs.sort((a, b) => a.d - b.d || a.f - b.f || a.order - b.order)
  const out: Record<number, string> = {}
  const taken = new Set<string>()
  for (const p of pairs) {
    if (out[p.f] !== undefined || taken.has(p.s)) continue
    out[p.f] = p.s
    taken.add(p.s)
  }
  return out
}

/** True when two filaments of one print would end up in the same printer slot. */
export function duplicateTargets(map: Readonly<Record<number, string>>): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const id of Object.values(map)) (seen.has(id) ? dup : seen).add(id)
  return [...dup]
}
