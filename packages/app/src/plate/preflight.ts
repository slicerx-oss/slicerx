// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Preflight before a file goes to a printer (docs/safety.md): compares what was sliced with the
// printer as it is right now. Errors block the send; warnings need the person's yes on the card.
// The facts it returns go on the approval card, with the file's SHA-256.
import { formatDuration } from '../lib/preview-stats'
import { degC } from '../lib/temp'
import type { Collision, PrinterInfo, PrinterStatus, SettingValue } from '@slicerx/contracts'
import { PRINTER_MODELS, type PrinterModel } from '@slicerx/printer-catalog'
import { appName } from '../edition'
import { closeCallNote, collisionDetail, collisionTitle } from './heimdall-words'

export interface PreflightInput {
  printer: PrinterInfo
  status: PrinterStatus | null
  /** The resolved slice config, Orca keys. */
  config: Record<string, SettingValue | undefined>
  /** Bounds of everything on the plate, bed frame, mm. */
  plateBounds: { min: [number, number, number]; max: [number, number, number] } | null
  /** The bed the plate was laid out on. */
  plateBed: { widthMm: number; depthMm: number; heightMm: number }
  file: { name: string; sha256: string; layers: number; timeS: number; grams: number }
  /** heimdall's collisions of the slice: a hit blocks the send, a close call needs the person's yes. */
  collisions?: readonly Collision[]
  /** The plate's object names by id, for the collisions' words. */
  objectNames?: Readonly<Record<string, string>>
}

export interface Preflight {
  errors: string[]
  warnings: string[]
  /** Lines for the approval card. */
  facts: string[]
}

const first = (v: SettingValue | undefined): SettingValue | undefined => (Array.isArray(v) ? v[0] : v)
const num = (v: SettingValue | undefined): number | null => {
  const x = Number(first(v))
  return Number.isFinite(x) ? x : null
}

/** The catalog model for a printer, matched on brand and model name. Undefined when unsure. */
export function catalogModel(p: Pick<PrinterInfo, 'vendor' | 'model'>): PrinterModel | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const vendor = norm(p.vendor)
  const want = norm(p.model)
  const pool = PRINTER_MODELS.filter((m) => vendor.startsWith(norm(m.brand)) || norm(m.brand).startsWith(vendor))
  return pool.find((m) => norm(m.name) === want) ?? pool.find((m) => norm(m.name).startsWith(want) || want.startsWith(norm(m.name)))
}

/** G-code flavors each connection's firmware takes. */
const FLAVORS: Record<string, readonly string[]> = {
  'bambu-lan': ['marlin', 'marlin2'],
  moonraker: ['klipper', 'marlin', 'marlin2'],
  prusalink: ['marlin2', 'marlin'],
  duet: ['reprapfirmware', 'reprap'],
  creality: ['klipper', 'marlin', 'marlin2'],
  elegoo: ['klipper', 'marlin2', 'marlin'],
  snapmaker: ['marlin', 'marlin2'],
  ultimaker: ['griffin'],
  anycubic: ['klipper', 'marlin2', 'marlin'],
}

export function preflight(input: PreflightInput): Preflight {
  const errors: string[] = []
  const warnings: string[] = []
  // What could not be checked goes on the card as a plain fact, not as a warning the person cannot act on.
  const unchecked: string[] = []
  const { printer, status, config, plateBounds, file } = input
  // The model the printer reports (Bambu Lab get_version) wins over the one it was added as.
  const model = catalogModel(status?.model ? { ...printer, model: status.model } : printer)
  const vol = model?.buildVolume

  // The printer must be free.
  if (status && !['idle', 'finished', 'error'].includes(status.state)) errors.push(`${printer.name} is ${status.state === 'offline' ? 'offline' : `busy (${status.state})`}. Wait until it is idle.`)
  if (status?.state === 'error') errors.push(`${printer.name} reports an error${status.message ? `: ${status.message}` : ''}. Clear it on the printer first.`)

  // Bed and height against the printer's real build volume.
  if (vol && plateBounds) {
    const w = vol.shape === 'rectangular' ? vol.x : vol.diameter
    const d = vol.shape === 'rectangular' ? vol.y : vol.diameter
    if (plateBounds.max[0] > w + 0.01 || plateBounds.max[1] > d + 0.01 || plateBounds.min[0] < -0.01 || plateBounds.min[1] < -0.01) errors.push(`The plate is laid out past the ${w} x ${d} mm bed of the ${model?.name}. Arrange it for this printer and slice again.`)
    if (plateBounds.max[2] > vol.z + 0.01) errors.push(`The print is ${plateBounds.max[2].toFixed(1)} mm tall; the ${model?.name} reaches ${vol.z} mm.`)
    if (input.plateBed.widthMm !== w || input.plateBed.depthMm !== d) warnings.push(`Sliced for a ${input.plateBed.widthMm} x ${input.plateBed.depthMm} mm bed; this printer has ${w} x ${d} mm.`)
  } else if (!vol) {
    unchecked.push(`${appName()} does not know the bed size of the ${printer.vendor} ${printer.model}, so the plate was not checked against it`)
  }

  // Nozzle.
  // The fitted nozzle when the printer reports it (Bambu Lab does), else the sizes the model is sold with.
  const nozzle = num(config['nozzle_diameter'])
  const fitted = status?.nozzleDiameterMm
  if (nozzle !== null && fitted !== undefined && fitted > 0) {
    if (Math.abs(fitted - nozzle) > 0.001) warnings.push(`Sliced for a ${nozzle} mm nozzle; ${printer.name} has a ${fitted} mm nozzle fitted. Pick the ${fitted} mm nozzle and slice again.`)
  } else if (nozzle !== null && model && !model.nozzles.includes(nozzle)) warnings.push(`Sliced for a ${nozzle} mm nozzle; the ${model.name} is sold with ${model.nozzles.join(', ')} mm. Check the one fitted.`)

  // Firmware flavor.
  const flavor = String(first(config['gcode_flavor']) ?? '').toLowerCase()
  const allowed = FLAVORS[printer.plugin]
  if (flavor && allowed && !allowed.includes(flavor)) errors.push(`The G-code is for ${flavor} firmware; ${printer.name} runs ${allowed[0]}. Pick this printer's profile and slice again.`)

  // Material against what is loaded.
  const material = String(first(config['filament_type']) ?? '')
  const loaded = (status?.slots ?? []).map((s) => s.material).filter((m): m is string => Boolean(m))
  if (material && loaded.length && !loaded.some((m) => m.toLowerCase().startsWith(material.toLowerCase()))) warnings.push(`Sliced for ${material}; ${printer.name} has ${[...new Set(loaded)].join(', ')} loaded.`)

  // Temperatures, for the card and a sanity limit.
  const hot = num(config['nozzle_temperature'])
  const bed = num(config['hot_plate_temp'])
  if (hot !== null && hot > 300) warnings.push(`The nozzle heats to ${degC(hot)}. Most hotends are rated to ${degC(300)}.`)

  // heimdall: the head, gantry or tool changer would meet a printed part.
  const name = (id: string) => input.objectNames?.[id] ?? 'an object'
  for (const c of input.collisions ?? []) {
    if (c.severity === 'hit') errors.push(`${collisionTitle(c, name)}, layer ${c.layer + 1}. ${collisionDetail(c, name)} Fix it in Preview and slice again.`)
    else warnings.push(closeCallNote(c, name))
  }

  const facts = [
    `${file.name}, SHA-256 ${file.sha256.slice(0, 16)}`,
    `${file.layers} layers, ${formatDuration(file.timeS)}${file.grams > 0 ? `, ${file.grams.toFixed(1)} g` : ''}`,
    `${printer.name}: ${printer.vendor} ${printer.model}${nozzle !== null ? `, ${nozzle} mm nozzle` : ''}`,
    [hot !== null ? `nozzle ${degC(hot)}` : '', bed !== null ? `bed ${degC(bed)}` : '', material].filter(Boolean).join(', '),
    ...unchecked,
  ].filter(Boolean)
  return { errors, warnings, facts }
}
