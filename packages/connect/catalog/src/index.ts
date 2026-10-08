// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//
// The printer catalog for first-run setup: brands, models, nozzles, build volumes, how each
// machine moves, how SlicerX connects to it, and where a person reads the address and code.
// Plain data with no dependencies, so the studio, the phone apps and Pilot all read the same file.
import { BRANDS } from './brands.ts'
import { CONNECTION_METHODS, connectionMethod } from './methods.ts'
import { ANYCUBIC } from './models/anycubic.ts'
import { BAMBU } from './models/bambu.ts'
import { CREALITY } from './models/creality.ts'
import { ELEGOO } from './models/elegoo.ts'
import { GENERIC } from './models/generic.ts'
import { KLIPPER } from './models/klipper.ts'
import { PRUSA } from './models/prusa.ts'
import { SNAPMAKER } from './models/snapmaker.ts'
import { ULTIMAKER } from './models/ultimaker.ts'
import type { Brand, ConnectionId, ConnectionMethod, FilamentSystem, Kinematics, PrinterModel } from './types.ts'

export type * from './types.ts'
export { BRANDS, CONNECTION_METHODS, connectionMethod }

/** Every model, grouped by brand in the order of `BRANDS`. */
export const PRINTER_MODELS: readonly PrinterModel[] = [
  ...BAMBU,
  ...PRUSA,
  ...CREALITY,
  ...ELEGOO,
  ...ANYCUBIC,
  ...SNAPMAKER,
  ...ULTIMAKER,
  ...KLIPPER.filter((m) => m.brand === 'qidi'),
  ...KLIPPER.filter((m) => m.brand === 'voron'),
  ...KLIPPER.filter((m) => m.brand === 'sovol'),
  ...KLIPPER.filter((m) => m.brand === 'flsun'),
  ...KLIPPER.filter((m) => m.brand === 'generic'),
  ...GENERIC,
]

export const KINEMATICS_LABELS: Readonly<Record<Kinematics, string>> = {
  'bed-slinger': 'Bed slinger',
  cartesian: 'Cartesian',
  corexy: 'CoreXY',
  corexz: 'CoreXZ',
  delta: 'Delta',
  idex: 'IDEX',
  toolchanger: 'Toolchanger',
}

const MODELS_BY_ID = new Map(PRINTER_MODELS.map((m) => [m.id, m]))

export function brandById(id: string): Brand | undefined {
  return BRANDS.find((b) => b.id === id)
}

export function modelById(id: string): PrinterModel | undefined {
  return MODELS_BY_ID.get(id)
}

const SYSTEM_NAMES: Readonly<Record<FilamentSystem, string>> = { ams: 'AMS', mmu: 'MMU', toolchanger: 'Toolchanger', cfs: 'CFS' }

/** The name of a printer's filament unit: the maker's own name for it ("AMS lite" on the A1), else the system name. Looks the model up by its display name. */
export function filamentUnitName(modelName: string, system: FilamentSystem): string {
  const m = PRINTER_MODELS.find((x) => x.name === modelName && x.filamentSystem === system)
  return m?.filamentUnit ?? SYSTEM_NAMES[system]
}

export function modelsForBrand(brandId: string): PrinterModel[] {
  return PRINTER_MODELS.filter((m) => m.brand === brandId)
}

/** Brands that have at least one model, in display order. */
export function brandsWithModels(): Brand[] {
  return BRANDS.filter((b) => PRINTER_MODELS.some((m) => m.brand === b.id))
}

/** The connection methods of a model, best first, as full records. */
/**
 * The connections that need nothing set up first: a connection that goes through a connected app (BamBuddy)
 * is left out. Use it where Settings, Connected apps is not known, such as the assistant's printer setup.
 */
export function directConnections(ids: readonly ConnectionId[]): ConnectionId[] {
  return ids.filter((id) => connectionMethod(id).requiresApp === undefined)
}

export function connectionsFor(model: PrinterModel): ConnectionMethod[] {
  return model.connections.map(connectionMethod)
}

/** The first way to reach the model that is not "save G-code", or `export` when there is none. */
export function preferredConnection(model: PrinterModel): ConnectionMethod {
  return connectionMethod(model.connections[0] ?? 'export')
}

export function modelsByConnection(id: ConnectionId): PrinterModel[] {
  return PRINTER_MODELS.filter((m) => m.connections.includes(id))
}

/** Case insensitive search over brand and model names, for the setup search box. */
export function searchModels(query: string): PrinterModel[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...PRINTER_MODELS]
  return PRINTER_MODELS.filter((m) => {
    const hay = `${brandById(m.brand)?.name ?? ''} ${m.name}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}
