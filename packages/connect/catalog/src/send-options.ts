// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print options a send offers per printer: what the printer does before or during the job. Which
// ones a printer supports, and their defaults, follow the maker's own slicer for that model. The Print sheet
// and printer.queue both read this table, so a client's send offers and defaults what the sheet does.
import type { PrinterInfo, PrinterStatus, StartOptions } from '@slicerx/contracts'
import { CONNECTION_METHODS } from './methods.ts'
import type { StartOptionKey } from './types.ts'

export type SendOptionId = StartOptionKey

/** Choices for some of the options, such as the Print sheet's saved ones or a client's: true for on, false for off. */
export type SendOptionChoices = { readonly [K in SendOptionId]?: boolean | undefined }

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

/** Every print option, in the order the Print sheet lists them. */
export const SEND_OPTION_IDS: readonly SendOptionId[] = ['bedLeveling', 'flowCalibration', 'vibrationCompensation', 'timelapse', 'firstLayerInspection']

const BAMBU = /bambu/i

/** The option's name as the Print sheet shows it, such as "Bed leveling". */
export function optionLabel(id: SendOptionId): string {
  return BASE[id].label
}

/**
 * The options this printer can honor, with the maker's defaults: what its connection in the printer catalog
 * lists, narrowed to what the model has (no flow calibration on the P1 series, inspection only on the X1 series,
 * no timelapse without a camera). A connection the catalog does not know gets none.
 */
export function supportedOptions(printer: Pick<PrinterInfo, 'vendor' | 'model'> & { plugin?: string | undefined }, status?: Pick<PrinterStatus, 'cameraAvailable' | 'model'> | null): SendOptionSpec[] {
  const camera = status?.cameraAvailable ?? true
  const bambu = BAMBU.test(printer.vendor)
  const method = CONNECTION_METHODS.find((m) => m.id === printer.plugin) ?? (bambu ? CONNECTION_METHODS.find((m) => m.id === 'bambu-lan') : undefined)
  const listed = new Set<string>(method?.startOptions ?? [])
  // The model the printer reports wins over the one it was added as.
  const model = status?.model ?? printer.model
  const known = bambu ? BAMBU_MODELS.find((m) => m.match.test(model))?.options : undefined
  const a1 = /\ba1\b/i.test(model)
  const has = (id: SendOptionId): boolean => (known ? id in known : id === 'firstLayerInspection' ? !a1 : true)
  return SEND_OPTION_IDS.filter((id) => listed.has(id) && has(id) && (id === 'timelapse' ? camera : true)).map((id) => ({ ...BASE[id], default: known?.[id] ?? FALLBACK[id] }))
}

/** The tooltip text for an option: what it does, when to use it, the time it adds. */
export function optionTip(s: SendOptionSpec): string {
  return `${s.tip.what} ${s.tip.when} ${s.tip.time}`
}

export function defaultOptions(specs: readonly SendOptionSpec[]): StartOptions {
  return Object.fromEntries(specs.map((s) => [s.id, s.default])) as StartOptions
}

/** Saved or given choices for options the printer supports, defaults for the rest. */
export function mergeOptions(specs: readonly SendOptionSpec[], saved: SendOptionChoices | undefined): StartOptions {
  const out = defaultOptions(specs)
  for (const s of specs) if (typeof saved?.[s.id] === 'boolean') (out as Record<string, boolean>)[s.id] = saved[s.id]!
  return out
}

/** The options named in `given` that this printer does not offer, in the sheet's order. */
export function unsupportedOptions(specs: readonly SendOptionSpec[], given: SendOptionChoices | undefined): SendOptionId[] {
  const offered = new Set(specs.map((s) => s.id))
  return SEND_OPTION_IDS.filter((id) => given?.[id] !== undefined && !offered.has(id))
}

/** Just the print options of a start, without its plate or slot map, in the sheet's order. */
export function chosenOptions(o: StartOptions): Partial<Record<SendOptionId, boolean>> {
  const out: Partial<Record<SendOptionId, boolean>> = {}
  for (const id of SEND_OPTION_IDS) if (typeof o[id] === 'boolean') out[id] = o[id]
  return out
}

/** One line per choice for the approval card. */
export function optionLines(specs: readonly SendOptionSpec[], o: StartOptions): string[] {
  return specs.map((s) => `${s.label}: ${o[s.id] ? 'on' : 'off'}`)
}
