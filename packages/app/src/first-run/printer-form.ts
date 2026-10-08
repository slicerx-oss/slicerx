// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printer setup form state and validation. Pure data: secrets never enter this state; the form
// only records whether a secret field holds something and how long it is.
import type { Bed, PrinterHardware } from '@slicerx/contracts'
import { brandById, CONNECTION_METHODS, connectionMethod, modelById, modelsForBrand, type ConnectionId, type ConnectionMethod, type FieldKey, type Kinematics, type PrinterModel } from '@slicerx/printer-catalog'
import { appHostPort, offeredConnections } from '../connected-apps/registry'

// ---------------------------------------------------------------------------
// Brands

export type Firmware = 'marlin' | 'klipper' | 'reprapfirmware' | 'bambu'

export interface BrandTile {
  id: string
  name: string
  /** Brand id in the printer catalog, when it has models there. */
  catalog?: string
  /** Set up by hand: bed, height, origin and firmware fields instead of a model list. */
  handMade?: boolean
  /** Firmware to preselect for a printer set up by hand. */
  firmware?: Firmware
}

/** The brand grid, in the order of docs/first-run.md 3a. */
export const BRAND_TILES: readonly BrandTile[] = [
  { id: 'bambu-lab', name: 'Bambu Lab', catalog: 'bambu-lab', firmware: 'bambu' },
  { id: 'prusa', name: 'Prusa Research', catalog: 'prusa', firmware: 'marlin' },
  { id: 'creality', name: 'Creality', catalog: 'creality', firmware: 'klipper' },
  { id: 'elegoo', name: 'Elegoo', catalog: 'elegoo', firmware: 'klipper' },
  { id: 'anycubic', name: 'Anycubic', firmware: 'marlin' },
  { id: 'snapmaker', name: 'Snapmaker', catalog: 'snapmaker', firmware: 'marlin' },
  { id: 'voron', name: 'Voron', catalog: 'voron', firmware: 'klipper' },
  { id: 'ratrig', name: 'Ratrig', firmware: 'klipper' },
  { id: 'qidi', name: 'Qidi', catalog: 'qidi', firmware: 'klipper' },
  { id: 'sovol', name: 'Sovol', catalog: 'sovol', firmware: 'klipper' },
  { id: 'flashforge', name: 'Flashforge', firmware: 'marlin' },
  { id: 'flsun', name: 'FLSUN', catalog: 'flsun', firmware: 'klipper' },
  { id: 'artillery', name: 'Artillery', firmware: 'marlin' },
  { id: 'anker', name: 'Anker', firmware: 'marlin' },
  { id: 'custom-klipper', name: 'Custom Klipper', handMade: true, firmware: 'klipper' },
  { id: 'custom-marlin', name: 'Custom Marlin', handMade: true, firmware: 'marlin' },
  { id: 'other', name: 'Other', handMade: true, firmware: 'marlin' },
]

export function brandTile(id: string | null): BrandTile | undefined {
  return BRAND_TILES.find((b) => b.id === id)
}

/** Catalog models offered for a brand tile. Empty means "set it up by hand". */
export function modelsForTile(tile: BrandTile): PrinterModel[] {
  return tile.catalog && !tile.handMade ? modelsForBrand(tile.catalog) : []
}

/** Brand tiles and models matching the search box. */
export function searchSetup(query: string): { brands: BrandTile[]; models: PrinterModel[] } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { brands: [...BRAND_TILES], models: [] }
  const hit = (text: string) => words.every((w) => text.toLowerCase().includes(w))
  const brands = BRAND_TILES.filter((b) => hit(b.name))
  const models = BRAND_TILES.flatMap((b) => modelsForTile(b).map((m) => ({ b, m })))
    .filter(({ b, m }) => hit(`${b.name} ${m.name}`))
    .map(({ m }) => m)
  return { brands, models: [...new Map(models.map((m) => [m.id, m])).values()].slice(0, 12) }
}

/** The brand tile a catalog model belongs to. */
export function tileForModel(model: PrinterModel): BrandTile | undefined {
  return BRAND_TILES.find((b) => b.catalog === model.brand)
}

// ---------------------------------------------------------------------------
// Form

export const NOZZLE_SIZES = [0.15, 0.2, 0.25, 0.4, 0.5, 0.6, 0.8, 1.0] as const
export const NOZZLE_TYPES = ['brass', 'hardened-steel', 'stainless-steel', 'tungsten-carbide', 'ruby', 'high-flow', 'copper-alloy'] as const
export type NozzleType = (typeof NOZZLE_TYPES)[number]
export const NOZZLE_TYPE_LABELS: Readonly<Record<NozzleType, string>> = {
  brass: 'Brass',
  'hardened-steel': 'Hardened steel',
  'stainless-steel': 'Stainless steel',
  'tungsten-carbide': 'Tungsten carbide',
  ruby: 'Ruby tip',
  'high-flow': 'High flow',
  'copper-alloy': 'Copper alloy',
}

export type FilamentKind = 'none' | 'single' | 'ams' | 'mmu' | 'other'
export const FILAMENT_LABELS: Readonly<Record<FilamentKind, string>> = {
  none: 'None',
  single: 'Single spool',
  ams: 'AMS',
  mmu: 'MMU',
  other: 'Other multi-material unit',
}

export interface NozzleSpec {
  /** A standard size, or null when Other is chosen and `other` holds the typed value. */
  size: number | null
  other: string
  type: NozzleType
  /** A high flow nozzle, as the printer reported it. */
  highFlow?: boolean
}

export interface CustomSpec {
  shape: 'rectangular' | 'circular'
  width: string
  depth: string
  diameter: string
  height: string
  origin: 'front-left' | 'center'
  firmware: Firmware
}

/** Non-secret connection fields. Secret fields (access code, API key, password) are held outside the form. */
export interface PlainFields {
  host: string
  port: string
  serial: string
  username: string
}

export type SecretKey = Extract<FieldKey, 'accessCode' | 'apiKey' | 'password' | 'pairing'>

export interface PrinterForm {
  brand: string | null
  /** A catalog model id, or `custom` for a printer set up by hand. */
  modelId: string | null
  custom: CustomSpec
  nozzles: NozzleSpec[]
  /** "Not sure": assumes 0.4 mm brass and flags it in Printers for confirmation. */
  nozzleUnsure: boolean
  toolhead: 'direct' | 'bowden'
  filament: { kind: FilamentKind; units: number; slots: number }
  connection: ConnectionId | null
  fields: PlainFields
  /** Length of each secret the person typed, 0 when empty. The values are never stored here. */
  secretLengths: Partial<Record<SecretKey, number>>
  /** The name the printer announced ("Workshop H2D"), saved as the printer's name. */
  name?: string
}

export const EMPTY_FORM: PrinterForm = {
  brand: null,
  modelId: null,
  custom: { shape: 'rectangular', width: '', depth: '', diameter: '', height: '', origin: 'front-left', firmware: 'marlin' },
  nozzles: [{ size: 0.4, other: '', type: 'brass' }],
  nozzleUnsure: false,
  toolhead: 'direct',
  filament: { kind: 'single', units: 1, slots: 1 },
  connection: null,
  fields: { host: '', port: '', serial: '', username: '' },
  secretLengths: {},
}

export function currentModel(form: PrinterForm): PrinterModel | undefined {
  return form.modelId && form.modelId !== 'custom' ? modelById(form.modelId) : undefined
}

export function pickBrand(form: PrinterForm, brandId: string): PrinterForm {
  if (form.brand === brandId) return form
  const tile = brandTile(brandId)
  const custom = { ...form.custom, firmware: tile?.firmware ?? form.custom.firmware }
  // A brand with no catalog models goes straight to the fields for a printer set up by hand.
  const handMade = tile ? modelsForTile(tile).length === 0 : true
  return { ...EMPTY_FORM, brand: brandId, custom, modelId: handMade ? 'custom' : null, connection: handMade ? (HAND_CONNECTIONS[custom.firmware][0] ?? 'export') : null }
}

function filamentFrom(model: PrinterModel): PrinterForm['filament'] {
  switch (model.filamentSystem) {
    case 'ams':
      return { kind: 'ams', units: 1, slots: 4 }
    case 'mmu':
      return { kind: 'mmu', units: 1, slots: 5 }
    case 'cfs':
      return { kind: 'other', units: 1, slots: 4 }
    case 'toolchanger':
      return { kind: 'single', units: 1, slots: model.nozzleCount }
    default:
      return { kind: 'single', units: 1, slots: 1 }
  }
}

/** Selecting a model fills nozzles, toolhead, filament system and the most likely connection. */
export function pickModel(form: PrinterForm, modelId: string): PrinterForm {
  if (modelId === 'custom') return { ...form, modelId, connection: form.connection ?? 'export' }
  const model = modelById(modelId)
  if (!model) return form
  const size = (NOZZLE_SIZES as readonly number[]).includes(model.defaultNozzle) ? model.defaultNozzle : null
  const nozzle: NozzleSpec = { size, other: size === null ? String(model.defaultNozzle) : '', type: 'brass' }
  const connection = model.connections[0] ?? 'export'
  return {
    ...form,
    modelId,
    nozzles: Array.from({ length: Math.max(1, model.nozzleCount) }, () => ({ ...nozzle })),
    nozzleUnsure: false,
    toolhead: model.kinematics === 'delta' ? 'bowden' : 'direct',
    filament: filamentFrom(model),
    connection,
    fields: { ...EMPTY_FORM.fields, port: '' },
    secretLengths: {},
  }
}

/** Connections offered for a printer set up by hand, by firmware, most likely first. */
export const HAND_CONNECTIONS: Readonly<Record<Firmware, readonly ConnectionId[]>> = {
  klipper: ['moonraker', 'export'],
  marlin: ['octoprint', 'export'],
  reprapfirmware: ['duet', 'export'],
  bambu: ['bambu-lan', 'export'],
}

export const FIRMWARE_LABELS: Readonly<Record<Firmware, string>> = { marlin: 'Marlin', klipper: 'Klipper', reprapfirmware: 'RepRapFirmware', bambu: 'Bambu' }

const NO_APPS: ReadonlySet<string> = new Set()

/**
 * Connection types for the current model or firmware, most likely first. One that goes through a connected
 * app (BamBuddy) is offered only once that app is added (`apps`, the ids in Settings, Connected apps).
 */
export function connectionChoices(form: PrinterForm, apps: ReadonlySet<string> = NO_APPS): ConnectionId[] {
  const model = currentModel(form)
  if (model) return offeredConnections(model.connections, apps)
  return form.modelId === 'custom' ? offeredConnections(HAND_CONNECTIONS[form.custom.firmware], apps) : []
}

export function setFirmware(form: PrinterForm, firmware: Firmware): PrinterForm {
  const choices = HAND_CONNECTIONS[firmware]
  const connection = form.connection && choices.includes(form.connection) ? form.connection : (choices[0] ?? 'export')
  return { ...form, custom: { ...form.custom, firmware }, connection, secretLengths: connection === form.connection ? form.secretLengths : {} }
}

/**
 * Chooses a connection. One that goes through a connected app takes the app's address (`appBaseUrl`) as the
 * printer's: the form does not ask for it, and the hub fills in the app's address and key when it connects.
 */
export function pickConnection(form: PrinterForm, id: ConnectionId, appBaseUrl?: string): PrinterForm {
  if (form.connection === id) return form
  const viaApp = connectionMethod(id).requiresApp !== undefined
  return { ...form, connection: id, fields: { ...form.fields, port: '', ...(viaApp ? { host: appBaseUrl ? appHostPort(appBaseUrl) : '' } : {}) }, secretLengths: {} }
}

export function nozzleMm(n: NozzleSpec): number | null {
  if (n.size !== null) return n.size
  const v = Number(n.other.trim().replace(',', '.'))
  return Number.isFinite(v) && n.other.trim() !== '' ? v : null
}

export function nozzleError(n: NozzleSpec): string | null {
  if (n.size !== null) return null
  const v = nozzleMm(n)
  if (v === null) return 'Enter the nozzle diameter in mm.'
  if (v < 0.1 || v > 2) return 'The nozzle must be 0.1 to 2.0 mm.'
  return null
}

function positive(text: string, max: number): boolean {
  const v = Number(text.trim().replace(',', '.'))
  return text.trim() !== '' && Number.isFinite(v) && v > 0 && v <= max
}

/** Errors for a printer set up by hand, by field. */
export function customErrors(c: CustomSpec): Partial<Record<'width' | 'depth' | 'diameter' | 'height', string>> {
  const out: Partial<Record<'width' | 'depth' | 'diameter' | 'height', string>> = {}
  const msg = 'Enter a size from 1 to 2000 mm.'
  if (c.shape === 'rectangular') {
    if (!positive(c.width, 2000)) out.width = msg
    if (!positive(c.depth, 2000)) out.depth = msg
  } else if (!positive(c.diameter, 2000)) out.diameter = msg
  if (!positive(c.height, 2000)) out.height = msg
  return out
}

// ---------------------------------------------------------------------------
// Connection validation

/** Parses `192.168.1.5`, `printer.local:7125` or `http://host:7125/`. Null when malformed. */
export function parseAddress(text: string): { host: string; port?: number; scheme?: string } | null {
  const raw = text.trim()
  if (!raw) return null
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\[[0-9a-f:.%a-z]+\]|[^\s/:?#[\]@]+)(?::(\d{1,5}))?\/?$/i.exec(raw)
  if (!m) return null
  const host = (m[2] ?? '').replace(/^\[|\]$/g, '')
  if (!host) return null
  if (!/^[0-9a-f:.%a-z-]+$/i.test(host)) return null
  if (/^\d+(\.\d+)*$/.test(host) && !isIPv4(host)) return null
  if (!host.includes(':') && !/^\d+(\.\d+){3}$/.test(host) && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(host)) return null
  const port = m[3] === undefined ? undefined : Number(m[3])
  return { host, ...(port === undefined ? {} : { port }), ...(m[1] ? { scheme: m[1].toLowerCase() } : {}) }
}

export function isIPv4(host: string): boolean {
  const parts = host.split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** True for an IPv4 address outside private, loopback, link-local, shared and documentation ranges. */
export function looksPublic(host: string): boolean {
  if (!isIPv4(host)) return false
  const [a = 0, b = 0, c = 0] = host.split('.').map(Number)
  if (a === 10 || a === 127 || a === 0) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 169 && b === 254) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false
  return true
}

export function validPort(text: string): boolean {
  if (!/^\d{1,5}$/.test(text.trim())) return false
  const n = Number(text)
  return n >= 1 && n <= 65535
}

export interface ConnectionCheck {
  errors: Partial<Record<FieldKey, string>>
  warnings: string[]
  /** True when Test may run. */
  ready: boolean
}

export const PUBLIC_WARNING = 'This looks like a public address. Printers are normally on your home network.'

export function checkConnection(form: PrinterForm, method: ConnectionMethod): ConnectionCheck {
  const errors: Partial<Record<FieldKey, string>> = {}
  const warnings: string[] = []
  for (const f of method.fields) {
    if (f.key === 'host') {
      const a = parseAddress(form.fields.host)
      if (!form.fields.host.trim()) errors.host = `Enter the ${f.label.toLowerCase()}.`
      else if (!a) errors.host = 'Enter an IP address such as 192.168.1.50, or a host name such as printer.local.'
      else {
        if (a.port !== undefined && (a.port < 1 || a.port > 65535)) errors.host = 'The port must be 1 to 65535.'
        if (looksPublic(a.host)) warnings.push(PUBLIC_WARNING)
      }
    } else if (f.key === 'port') {
      if (form.fields.port.trim() && !validPort(form.fields.port)) errors.port = 'The port must be 1 to 65535.'
    } else if (f.key === 'serial') {
      const v = form.fields.serial.trim()
      // BamBuddy's printer id rides in the serial field: it is the number BamBuddy uses, not a serial number.
      if (method.id === 'bambuddy') {
        if (!v) errors.serial = 'Enter the BamBuddy printer id.'
        else if (!/^[1-9]\d{0,9}$/.test(v)) errors.serial = 'The BamBuddy printer id is the number BamBuddy uses for this printer, like 12.'
      } else if (!v && f.required) errors.serial = 'Enter the serial number.'
      else if (v && !/^[A-Z0-9]{8,24}$/i.test(v)) errors.serial = 'The serial number is 8 to 24 letters and digits.'
    } else if (f.key === 'username') {
      if (f.required && !form.fields.username.trim()) errors.username = 'Enter the user name.'
    } else if (f.key === 'pairing') {
      // Confirmed on the printer's own screen, nothing to type.
    } else {
      const len = form.secretLengths[f.key] ?? 0
      if (f.required && len === 0) errors[f.key] = `Enter the ${f.label.toLowerCase()}.`
      else if (f.key === 'accessCode' && len > 0 && len !== 8) errors.accessCode = 'The access code has 8 characters.'
    }
  }
  return { errors, warnings, ready: Object.keys(errors).length === 0 }
}

/** One thing that keeps Test connection off, in plain words, with the field to fix. */
export interface Blocker {
  field: FieldKey
  text: string
}

/**
 * Why Test connection cannot run yet: every missing or invalid field, in form order, including the
 * ones nobody has typed in yet. Empty when the test can run.
 */
export function testBlockers(form: PrinterForm, method: ConnectionMethod): Blocker[] {
  const { errors } = checkConnection(form, method)
  const out: Blocker[] = []
  for (const f of method.fields) {
    const e = errors[f.key]
    if (!e) continue
    if (f.key === 'host') {
      out.push({ field: 'host', text: form.fields.host.trim() ? `The IP address "${form.fields.host.trim()}" is not valid. Use four numbers such as 192.168.1.50.` : 'The IP address is empty.' })
    } else if (f.key === 'serial') {
      // BamBuddy's printer id rides in the serial field (see checkConnection).
      if (method.id === 'bambuddy') out.push({ field: 'serial', text: form.fields.serial.trim() ? 'The BamBuddy printer id is the number BamBuddy uses for this printer, like 12.' : 'The BamBuddy printer id is empty.' })
      else out.push({ field: 'serial', text: form.fields.serial.trim() ? 'The serial number must be 8 to 24 letters and digits (Bambu Lab serials have 15).' : 'The serial number is empty.' })
    } else if (f.key === 'accessCode') {
      const len = form.secretLengths.accessCode ?? 0
      out.push({ field: 'accessCode', text: len ? `The access code has 8 characters; ${len} ${len === 1 ? 'is' : 'are'} entered.` : 'The access code is empty. It has 8 characters.' })
    } else {
      out.push({ field: f.key, text: e })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Values the printer reported

/** A reported nozzle diameter as the form holds it: a standard size, or Other with the number. */
function nozzleSpec(mm: number | undefined, type: NozzleType | undefined, prev: NozzleSpec, highFlow?: boolean): NozzleSpec {
  const size = mm === undefined ? prev.size : (NOZZLE_SIZES as readonly number[]).includes(mm) ? mm : null
  return { size, other: mm !== undefined && size === null ? String(mm) : mm === undefined ? prev.other : '', type: type ?? prev.type, ...(highFlow ? { highFlow } : {}) }
}

/**
 * The form with what the printer reported: a nozzle per extruder (size and material), the filament
 * system and its units. Anything the printer did not report keeps the catalog's value.
 */
export function withHardware(form: PrinterForm, hw: PrinterHardware): PrinterForm {
  let next = form
  const ex = hw.extruders ?? []
  if (ex.some((e) => e.nozzleDiameterMm !== undefined || e.nozzleType)) {
    const count = Math.max(ex.length, form.nozzles.length)
    const nozzles = Array.from({ length: count }, (_, i) => {
      const prev = form.nozzles[i] ?? form.nozzles[0] ?? EMPTY_FORM.nozzles[0]!
      const e = ex[i]
      return e ? nozzleSpec(e.nozzleDiameterMm, e.nozzleType, prev, e.highFlow) : prev
    })
    next = { ...next, nozzleUnsure: false, nozzles }
  }
  const units = (hw.filamentUnits ?? []).filter((u) => u.kind !== 'external')
  if (units.some((u) => u.kind === 'mmu')) {
    next = { ...next, filament: { kind: 'mmu', units: 1, slots: units.find((u) => u.kind === 'mmu')!.slots.length || 5 } }
  } else if (units.length) {
    next = { ...next, filament: { kind: 'ams', units: units.length, slots: units.reduce((n, u) => n + u.slots.length, 0) } }
  }
  return next
}

// ---------------------------------------------------------------------------
// Derived values

export const KINEMATICS_ICON: Readonly<Record<Kinematics, 'printer-bed-slinger' | 'printer-corexy-open' | 'printer-corexy-enclosed' | 'printer-delta' | 'printer-idex' | 'printer-toolchanger'>> = {
  'bed-slinger': 'printer-bed-slinger',
  cartesian: 'printer-corexy-open',
  corexy: 'printer-corexy-open',
  corexz: 'printer-corexy-open',
  delta: 'printer-delta',
  idex: 'printer-idex',
  toolchanger: 'printer-toolchanger',
}

/**
 * What the footer Skip keeps. Skipping is for the connection test, not for the pick: a printer that was
 * chosen is saved untested. A printer the scan found keeps its connection and address, so it is still the
 * printer the host knows, and only the credentials that are not complete are left out. A printer picked by
 * hand whose connection fields are not complete is saved with no connection (G-code export) and can be
 * connected later in Printers. Null when nothing was picked.
 */
export function skipForm(form: PrinterForm, scanned = false): PrinterForm | null {
  if (!form.modelId || !bedOf(form)) return null
  const m = form.connection ? connectionMethod(form.connection) : null
  if (!m || m.id === 'export') return form
  const { errors, ready } = checkConnection(form, m)
  if (ready) return form
  if (!scanned || errors.host || errors.port) return { ...form, connection: 'export' }
  const secretLengths = Object.fromEntries(Object.entries(form.secretLengths).filter(([k]) => !errors[k as SecretKey])) as PrinterForm['secretLengths']
  return { ...form, fields: { ...form.fields, serial: errors.serial ? '' : form.fields.serial, username: errors.username ? '' : form.fields.username }, secretLengths }
}

export function typeIcon(model: PrinterModel) {
  if ((model.kinematics === 'corexy' || model.kinematics === 'cartesian') && model.enclosed) return 'printer-corexy-enclosed' as const
  return KINEMATICS_ICON[model.kinematics]
}

export function buildVolumeText(model: PrinterModel): string {
  const v = model.buildVolume
  return v.shape === 'rectangular' ? `${v.x} x ${v.y} x ${v.z} mm` : `${v.diameter} mm round x ${v.z} mm`
}

/** The bed for the plate: the model's, or the one typed by hand. Null when unknown. */
export function bedOf(form: PrinterForm): Bed | null {
  const model = currentModel(form)
  if (model) {
    const v = model.buildVolume
    return v.shape === 'rectangular' ? { widthMm: v.x, depthMm: v.y, heightMm: v.z } : { widthMm: v.diameter, depthMm: v.diameter, heightMm: v.z }
  }
  if (form.modelId !== 'custom' || Object.keys(customErrors(form.custom)).length) return null
  const n = (t: string) => Number(t.replace(',', '.'))
  const c = form.custom
  return c.shape === 'rectangular' ? { widthMm: n(c.width), depthMm: n(c.depth), heightMm: n(c.height) } : { widthMm: n(c.diameter), depthMm: n(c.diameter), heightMm: n(c.height) }
}

export function nozzleText(form: PrinterForm): string {
  const parts = form.nozzles.map((n) => `${nozzleMm(n) ?? '?'} mm ${NOZZLE_TYPE_LABELS[n.type].toLowerCase()}`)
  const text = parts.length > 1 ? parts.map((p, i) => `T${i}: ${p}`).join(', ') : (parts[0] ?? '')
  return form.nozzleUnsure ? `${text}, to confirm` : text
}

export function filamentText(form: PrinterForm): string {
  const f = form.filament
  if (f.kind === 'none' || f.kind === 'single') return FILAMENT_LABELS[f.kind]
  if (f.kind === 'ams') return `AMS, ${f.units} ${f.units === 1 ? 'unit' : 'units'}, ${f.slots || f.units * 4} slots`
  return `${FILAMENT_LABELS[f.kind]}, ${f.slots} slots`
}

export function modelLabel(form: PrinterForm): { brand: string; model: string } {
  const tile = brandTile(form.brand)
  const model = currentModel(form)
  if (model) return { brand: tile?.name ?? brandById(model.brand)?.name ?? '', model: model.name }
  return { brand: tile?.name ?? 'Other', model: 'Set up by hand' }
}

/** What mimir may read: everything except secrets, which appear only as "entered" or not. */
export function formView(form: PrinterForm): Record<string, string> {
  const { brand, model } = modelLabel(form)
  const method = form.connection ? connectionMethod(form.connection) : null
  const out: Record<string, string> = {}
  if (form.brand) out['brand'] = brand
  if (form.modelId) out['model'] = model
  out['nozzle'] = nozzleText(form)
  out['toolhead'] = form.toolhead === 'direct' ? 'Direct drive' : 'Bowden'
  out['filament system'] = filamentText(form)
  if (method) out['connection'] = method.name
  if (form.fields.host) out['address'] = form.fields.host
  if (form.fields.port) out['port'] = form.fields.port
  if (form.fields.serial) out['serial number'] = form.fields.serial
  for (const f of method?.fields ?? []) if (f.secret && f.key !== 'pairing') out[f.label.toLowerCase()] = (form.secretLengths[f.key as SecretKey] ?? 0) > 0 ? 'entered' : 'empty'
  return out
}

/** Address with the port the person typed, for the connection. */
export function addressOf(form: PrinterForm): string {
  const a = parseAddress(form.fields.host)
  if (!a) return form.fields.host.trim()
  const host = a.host.includes(':') ? `[${a.host}]` : a.host
  const port = form.fields.port.trim() ? Number(form.fields.port) : a.port
  return port === undefined ? host : `${host}:${port}`
}

/** The catalog profile id a printer is added with. */
export function profileIdOf(form: PrinterForm): string {
  if (form.modelId && form.modelId !== 'custom') return form.modelId
  // A printer set up by hand is added with the generic catalog entry for its connection.
  const generic: Record<Firmware, string> = { klipper: 'generic-klipper', marlin: form.connection === 'octoprint' ? 'generic-octoprint' : 'generic-export', reprapfirmware: 'generic-duet', bambu: 'generic-export' }
  return generic[form.custom.firmware]
}

/** Substeps unlock in order; each stays editable once reached. */
export function unlocked(form: PrinterForm): { model: boolean; nozzle: boolean; connection: boolean; test: boolean } {
  const model = form.brand !== null
  const hasModel = model && form.modelId !== null && (form.modelId !== 'custom' || Object.keys(customErrors(form.custom)).length === 0)
  const nozzle = hasModel
  const connection = nozzle && form.nozzles.every((n) => nozzleError(n) === null)
  const test = connection && form.connection !== null && form.connection !== 'export'
  return { model, nozzle, connection, test }
}

// ---------------------------------------------------------------------------
// Values mimir asked for, after the person approved the card

/** The form with a connection the pilot tested: family, address, serial and user name. Unknown families keep the form's. */
export function withConnection(form: PrinterForm, c: { family: string; address: string; serial?: string; username?: string }): PrinterForm {
  const known = CONNECTION_METHODS.some((m) => m.id === c.family) ? (c.family as ConnectionId) : null
  const next = known && known !== form.connection ? pickConnection(form, known) : form
  return { ...next, fields: { ...next.fields, host: c.address, port: '', serial: c.serial ?? next.fields.serial, username: c.username ?? next.fields.username } }
}

/** The form for a printer the pilot adds: the catalog model, the nozzle and the connection. */
export function withAddInput(form: PrinterForm, input: { profileId: string; nozzleMm: number; connection?: { family: string; address: string; serial?: string; username?: string } }): PrinterForm {
  const model = modelById(input.profileId)
  let next = form
  if (model && form.modelId !== model.id) next = pickModel(pickBrand(form, tileForModel(model)?.id ?? 'other'), model.id)
  const size = (NOZZLE_SIZES as readonly number[]).includes(input.nozzleMm) ? input.nozzleMm : null
  next = { ...next, nozzles: next.nozzles.map((n) => ({ ...n, size, other: size === null ? String(input.nozzleMm) : '' })) }
  return input.connection ? withConnection(next, input.connection) : pickConnection(next, 'export')
}

/** Each extruder's nozzle as the printer record keeps it, for printers with more than one. Null for one nozzle. */
export function extruderNozzles(form: PrinterForm): { mm: number; type?: string; highFlow?: boolean }[] | null {
  if (form.nozzles.length < 2) return null
  return form.nozzles.map((n) => ({ mm: nozzleMm(n) ?? 0.4, type: n.type, ...(n.highFlow ? { highFlow: true } : {}) }))
}

/**
 * An access code is read off a screen: spaces and grouping go. Its case is kept exactly, since the printer
 * compares it as the MQTT password. Other secrets stay as typed.
 */
export function normalizeSecret(key: SecretKey, raw: string): string {
  return key === 'accessCode' ? raw.replace(/\s+/g, '') : raw
}
