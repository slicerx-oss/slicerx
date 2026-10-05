// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds a calibration model with sx-geom onto a new plate of its own, and writes the value a person reads
// off the print back into the filament settings.
import type { MeshHandle, MeshPart, SettingValue } from '@slicerx/contracts'
import { resolveConfig } from '../adapters/settings'
import { sectionOf } from '@slicerx/settings/defaults'
import { fromGeom, geom, type GeomMesh } from '../geom/client'
import { arrange } from '../plate/arrange'
import { resolveSlots } from '../filament/slots'
import { addPlate } from '../plate/plates'
import { compose } from '../plate/transform'
import { get, markStale, set, toast, type PlateEntry } from '../state/store'
import { layerIndexAt } from './gcode'
import { filamentName, nozzleText, tunedPresetName, tuneContext, tuneKey } from './tuned'
import type { CalibPrinter } from './plan'
import { calibTest, checkValues, DEFAULT_CTX, resultSettings, type CalibCtx, type CalibId, type Cfg } from './tests'
import { brandAccent } from '../edition'

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

export interface CalibResponse {
  name: string
  objects: { name: string; mesh: GeomMesh; offsetMm: [number, number]; settings: Record<string, SettingValue> }[]
  ranges: { zFromMm: number; zToMm: number; settings: Record<string, SettingValue> }[]
  instructions: string[]
  /** What the engine lays out beyond the models: tower bands with firmware commands, a tool path's G-code and values. */
  expected?: {
    layerCommands?: ({ zFromMm: number; zToMm: number; gcode?: Record<string, string> } & Record<string, unknown>)[]
    setupGcode?: { gcode?: Record<string, string> }
    gcode?: string
    values?: number[]
  }
}

const FIRMWARE_KEY: Record<CalibCtx['flavor'], string> = { klipper: 'klipper', marlin: 'marlin', repRapFirmware: 'reprapFirmware', repetier: 'repetier', bambu: 'marlin' }

/** The first number in a band's entry that is not its height range: the value the band tests. */
function bandValue(row: Record<string, unknown>): number | null {
  for (const [k, v] of Object.entries(row)) if (k !== 'zFromMm' && k !== 'zToMm' && typeof v === 'number') return v
  return null
}

/** The printer facts the plan needs: the firmware dialect and the model, to know what the printer tunes itself. */
export async function calibPrinter(): Promise<CalibPrinter> {
  const ctx = await calibCtx()
  return { flavor: ctx.flavor, printerId: get().profile?.printerId ?? get().printerId ?? '' }
}

/** The printer and filament values the path tests and the firmware towers need, from the current settings and printer. */
export async function calibCtx(): Promise<CalibCtx> {
  const s = get()
  const cfg = resolveConfig(s.easy, s.overrides) as Record<string, SettingValue | undefined>
  const { printerBase } = await import('../workspaces/prepare/printer-base')
  const base = printerBase(undefined) as Record<string, SettingValue | undefined>
  const flavorText = String(cfg['gcode_flavor'] ?? base['gcode_flavor'] ?? 'marlin').toLowerCase()
  const flavor: CalibCtx['flavor'] = flavorText.includes('klipper') ? 'klipper' : flavorText.startsWith('reprap') ? 'repRapFirmware' : flavorText.includes('repetier') ? 'repetier' : 'marlin'
  return {
    ...DEFAULT_CTX,
    bedWidthMm: s.bed.widthMm,
    bedDepthMm: s.bed.depthMm,
    nozzleMm: num1(cfg['nozzle_diameter'] ?? base['nozzle_diameter'], 0.4),
    layerHeightMm: num1(cfg['layer_height'], 0.2),
    flavor,
    filamentDiameterMm: num1(cfg['filament_diameter'], 1.75),
    flowRatio: num1(cfg['filament_flow_ratio'], 1),
    retractionMm: num1(cfg['retraction_length'] ?? base['retraction_length'], 0.8),
  }
}

export function defaultValues(id: CalibId): Record<string, number> {
  const s = get()
  return calibTest(id).defaults(resolveConfig(s.easy, s.overrides) as Cfg)
}

let seq = 0

/** A fresh id for a calibration plate object. */
export const calibEntryId = (): string => `calib_${Date.now().toString(36)}${(++seq).toString(36)}`

export const num1 = (v: SettingValue | undefined, d: number): number => {
  const x = Array.isArray(v) ? v[0] : v
  return typeof x === 'number' && Number.isFinite(x) ? x : d
}

/** A 2 mm square one layer thick: the model a tool path test slices so the engine writes its start and end sequences. */
function placeholderMesh(): GeomMesh {
  const p = [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0, 0, 0, 0.2, 2, 0, 0.2, 2, 2, 0.2, 0, 2, 0.2]
  const i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  return { positions: p, indices: i }
}

/** Adds the model for a test on a new plate and shows it. Returns the plate id. */
export async function addCalibrationPlate(host: Loader, id: CalibId, values: Record<string, number>, slot = 1): Promise<string> {
  const test = calibTest(id)
  const problem = checkValues(test, values)
  if (problem) throw new Error(problem)
  const ctx = await calibCtx()
  const r = await geom().call<CalibResponse>('calibrate', { request: test.request(values, ctx), meshOutput: 'flat' })
  const fw = FIRMWARE_KEY[ctx.flavor]
  const firstLayer = num1(resolveConfig(get().easy, get().overrides)['initial_layer_print_height'], ctx.layerHeightMm)

  // Towers that change a firmware setting per band: its commands go in as custom G-code at the band's first layer, with the once-only setup at the start.
  let layerGcode: { layer: number; kind: 'custom'; gcode: string }[] | undefined
  const bandGcode: Record<string, string> = {}
  let stepValues: number[] | undefined
  const rows = r.expected?.layerCommands
  if (rows?.length) {
    const byLayer = new Map<number, string[]>()
    const setup = r.expected?.setupGcode?.gcode?.[fw]
    if (setup) byLayer.set(0, [setup])
    stepValues = []
    for (const row of rows) {
      const text = row.gcode?.[fw]
      const value = bandValue(row)
      if (value !== null) stepValues.push(value)
      if (!text) continue
      if (value !== null) bandGcode[String(value)] = text
      const layer = layerIndexAt(row.zFromMm, ctx.layerHeightMm, firstLayer)
      byLayer.set(layer, [...(byLayer.get(layer) ?? []), text])
    }
    layerGcode = [...byLayer].sort((a, b) => a[0] - b[0]).map(([layer, parts]) => ({ layer, kind: 'custom' as const, gcode: parts.join('\n') }))
  }
  // Tool path tests have no model: a one layer placeholder gets sliced, and the test's G-code replaces its body when the file is written.
  const body = typeof r.expected?.gcode === 'string' ? r.expected.gcode : undefined
  if (body && r.expected?.values) stepValues = r.expected.values
  if (body && r.objects.length === 0) r.objects.push({ name: 'Placeholder', mesh: placeholderMesh(), offsetMm: [0, 0], settings: {} })
  const { bed } = get()
  // The engine lays the objects out with their own minimum corner at the origin; center that layout on the bed.
  let maxX = 0
  let maxY = 0
  for (const o of r.objects) {
    let x = 0
    let y = 0
    for (let i = 0; i < o.mesh.positions.length; i += 3) {
      x = Math.max(x, o.mesh.positions[i]!)
      y = Math.max(y, o.mesh.positions[i + 1]!)
    }
    maxX = Math.max(maxX, o.offsetMm[0] + x)
    maxY = Math.max(maxY, o.offsetMm[1] + y)
  }
  const shift: [number, number] = [Math.max(0, (bed.widthMm - maxX) / 2), Math.max(0, (bed.depthMm - maxY) / 2)]
  const entries: PlateEntry[] = []
  const objectSettings: Record<string, Record<string, SettingValue>> = {}
  for (const o of r.objects) {
    const part = fromGeom(o.mesh, o.name, slot)
    const handle = await host.loadParts(o.name, [part])
    const entryId = calibEntryId()
    entries.push({ id: entryId, name: o.name, handle, parts: [part], colors: [brandAccent()], transform: compose({ position: [o.offsetMm[0] + shift[0], o.offsetMm[1] + shift[1], 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })
    if (Object.keys(o.settings).length) objectSettings[entryId] = o.settings
  }
  const plateId = addPlate()
  const placed = entries.map((e) => ({ ...e }))
  // Several objects that would overlap after centering go through arrange; a single layout keeps the engine's positions.
  if (placed.length > 1 && placed.some((p, i) => placed.slice(i + 1).some((q) => p.transform[12] === q.transform[12] && p.transform[13] === q.transform[13]))) {
    const a = arrange(placed, [], bed)
    for (const p of placed) if (a.transforms[p.id]) p.transform = a.transforms[p.id]!
  }
  set((s) => ({
    plate: placed,
    selection: null,
    selectedIds: [],
    objectSettings: { ...s.objectSettings, ...objectSettings },
    plates: s.plates.map((p) => (p.id === plateId ? { ...p, name: `Calibration: ${test.label}` } : p)),
    calibration: { ...s.calibration, [plateId]: { test: id, slot, values: stepValues && stepValues.length ? stepValues : test.candidates(values), params: { ...values }, ranges: r.ranges, instructions: r.instructions, ...(layerGcode ? { layerGcode } : {}), ...(body ? { body } : {}), ...(Object.keys(bandGcode).length ? { bandGcode } : {}) } },
  }))
  markStale()
  return plateId
}

/** Saves run one after another: results of one spool land in the same tuned preset, so they must not race. */
let saving: Promise<unknown> = Promise.resolve()

/** Writes the value read off a printed test into the filament settings the test tunes. */
export function applyCalibrationResult(id: CalibId, value: number, slotIndex?: number): string {
  const test = calibTest(id)
  const patch = resultSettings(test, value)
  const first = test.result.keys[0]
  const section = first ? sectionOf(first) : undefined
  const kind = section === 'printer' ? 'printer' : section === 'process' ? 'process' : 'filament'
  // Printer and process results apply to the whole plate. Filament results belong to one spool: the slice reads
  // them from its tuned preset for that slot, so no other slot sees them.
  if (kind !== 'filament') set((s) => ({ overrides: { ...s.overrides, ...patch } }))
  markStale()
  const shown = `${Number(value.toFixed(test.result.digits))}${test.result.unit ? ` ${test.result.unit}` : ''}`
  // Kept in a saved preset keyed to this spool, this printer and this nozzle, so it is still there next session
  // and a second spool of the same type has its own.
  const s = get()
  const index = slotIndex ?? s.calibration[s.activePlate]?.slot ?? 1
  const slot = resolveSlots(s).find((r) => r.index === index)
  const { printerId, nozzleMm } = tuneContext(s)
  const meta = { key: tuneKey(slot, printerId, nozzleMm), filament: filamentName(slot), printerId, nozzleMm }
  const write = saving.catch(() => undefined).then(() => import('../presets/presets')).then(({ writeTunedPreset }) => writeTunedPreset(kind, meta, tunedPresetName(slot, nozzleMm, kind), patch, { id, label: test.result.label, value: shown, raw: value }))
  saving = write
  void write.then(
    (p) => (markStale(), toast(`${test.result.label}: ${shown}, saved for ${meta.filament} on a ${nozzleText(nozzleMm)} nozzle in "${p.name}".`, 'ok')),
    (e: unknown) => toast(`${test.result.label}: ${shown}, applied. It could not be saved as a preset: ${e instanceof Error ? e.message : String(e)}`, 'warn'),
  )
  return `${test.result.label}: ${shown}`
}
