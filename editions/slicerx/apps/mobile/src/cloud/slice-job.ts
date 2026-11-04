// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slice from the phone: one model, one printer and the Easy settings go to the
// cloud slicer (Host['cloud'], a SlicerHost), and the G-code comes back as a
// JobFile ready for PrinterHost.upload. Nothing here touches a printer; sending
// is a separate, approval-gated step (screens/slice.tsx).
import type { Collision, CollisionPlate, EasySettings, GcodeFlavor, JobFile, PlateObject, PrimeTowerPlacement, PrintConfig, PrinterInfo, SliceStage, SlicerHost } from '@slicerx/contracts'
import { applyEasy, defaultConfig, printerConfig, profileIdFor } from '@slicerx/settings'
import { meshBounds } from './stl'

export const MATERIALS = ['pla', 'petg', 'abs', 'tpu'] as const
export type Material = (typeof MATERIALS)[number]

export const MATERIAL_LABEL: Record<Material, string> = { pla: 'PLA', petg: 'PETG', abs: 'ABS', tpu: 'TPU' }

/** Nozzle and bed temperatures in C, from the common starting points on each material's data sheet. */
const MATERIAL_TEMPS: Record<Material, { nozzle: number; bed: number; density: number }> = {
  pla: { nozzle: 215, bed: 60, density: 1.24 },
  petg: { nozzle: 240, bed: 75, density: 1.27 },
  abs: { nozzle: 255, bed: 100, density: 1.04 },
  tpu: { nozzle: 225, bed: 45, density: 1.21 },
}

export interface PhoneModel {
  id: string
  name: string
  origin: 'library' | 'file' | 'sample'
  /** Creator studio for library models. */
  by?: string
  /** File size in bytes when known. */
  bytes?: number
  /** Store listing version for library models; the service fetches that file itself. */
  versionId?: string
  load: () => Promise<ArrayBuffer>
}

export interface CloudSliceInput {
  model: PhoneModel
  printer: PrinterInfo
  easy: EasySettings
  material: Material
  /** The plate of a 3MF project to slice (`options.plates`), when the person picked one of several. */
  plate?: number
}

export type SlicePhase =
  | { kind: 'uploading' }
  | { kind: 'queued' }
  | { kind: 'slicing'; stage: SliceStage; fraction: number }
  | { kind: 'downloading' }

export interface CloudSliceOutcome {
  file: JobFile
  layerCount: number
  timeS: number
  grams: number
  layerHeight: number
  /** Only for a file the phone could measure (an STL). */
  sizeMm?: [number, number, number]
  /** How the measured model sits on the printer's bed, for the send screen's card; only with `sizeMm`. */
  fit?: PlateFit
  warnings: string[]
  /** What the cloud's collision check found, and the plate it is on (machine mm); empty and absent when clean. */
  collisions: Collision[]
  collisionPlate?: CollisionPlate
  primeTower?: PrimeTowerPlacement
}

/**
 * A measured model on the printer's bed as the cloud slicer places it: centered and set down. Plate mm from the bed's
 * front left corner; `over` is how far it runs past the bed in x, y and z (0 where it fits).
 */
export interface PlateFit {
  fits: boolean
  bed: [number, number, number]
  size: [number, number, number]
  footprint: { min: [number, number]; max: [number, number] }
  over: [number, number, number]
}

/** Where a model of `size` lands on `bed`, centered as the cloud slicer sets it, and how far it runs past. */
export function plateFit(size: [number, number, number], bed: [number, number, number]): PlateFit {
  const r = (v: number) => Math.round(v * 10) / 10
  const over = [0, 1, 2].map((i) => r(Math.max(0, size[i]! - bed[i]!))) as [number, number, number]
  const lo = (i: number) => r((bed[i]! - size[i]!) / 2)
  const hi = (i: number) => r((bed[i]! + size[i]!) / 2)
  return { fits: over.every((v) => v === 0), bed, size, footprint: { min: [lo(0), lo(1)], max: [hi(0), hi(1)] }, over }
}

interface MachineShape {
  bed: [number, number, number]
  flavor: GcodeFlavor
}

/** Bed size in mm and G-code flavor by printer model. Unknown models get a 220 mm Marlin bed. */
export function machineFor(p: Pick<PrinterInfo, 'vendor' | 'model' | 'plugin'>): MachineShape {
  const m = `${p.vendor} ${p.model}`.toLowerCase()
  if (m.includes('a1 mini')) return { bed: [180, 180, 180], flavor: 'bambu' }
  if (m.includes('bambu')) return { bed: [256, 256, 256], flavor: 'bambu' }
  if (m.includes('mk4')) return { bed: [250, 210, 220], flavor: 'marlin2' }
  if (m.includes('voron')) return { bed: m.includes('350') ? [350, 350, 340] : [300, 300, 280], flavor: 'klipper' }
  if (m.includes('k1 max')) return { bed: [300, 300, 300], flavor: 'klipper' }
  if (p.plugin === 'moonraker') return { bed: [235, 235, 250], flavor: 'klipper' }
  return { bed: [220, 220, 250], flavor: 'marlin2' }
}

/** The zones a printer keeps clear, by their setting: the excluded areas and the nozzle wrap check corner. */
const ZONE_KEYS = ['bed_exclude_area', 'head_wrap_detect_zone'] as const

/**
 * What the printer's own profile says about its bed, when the phone knows the model: the profile id (the cloud checks
 * the plate with that printer), the printable area and height, and the zones the printer keeps clear.
 */
export interface PrinterSetup {
  profileId: string
  bed: [number, number, number]
  area: [number, number][]
  zones: Partial<Record<(typeof ZONE_KEYS)[number], unknown>>
}

export function printerSetup(p: Pick<PrinterInfo, 'vendor' | 'model'>): PrinterSetup | null {
  const id = profileIdFor(p)
  const cfg = id ? printerConfig(id) : undefined
  const area = cfg?.printable_area as [number, number][] | undefined
  if (!id || !cfg || !area?.length) return null
  const xs = area.map((q) => q[0])
  const ys = area.map((q) => q[1])
  const bed: [number, number, number] = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Number(cfg.printable_height) || 0]
  const zones: PrinterSetup['zones'] = {}
  for (const k of ZONE_KEYS) {
    const v = cfg[k]
    if (Array.isArray(v) && v.length) zones[k] = v
  }
  return { profileId: id, bed, area, zones }
}

/** The bed a phone slice uses: the printer's profile when the phone knows the model, else the table above. */
function bedOf(printer: PrinterInfo): [number, number, number] {
  return printerSetup(printer)?.bed ?? machineFor(printer).bed
}

/** The resolved config for a phone slice: schema defaults, then Easy mode, then the printer and material. */
export function phoneConfig(easy: EasySettings, printer: PrinterInfo, material: Material): PrintConfig {
  const shape = machineFor(printer)
  const setup = printerSetup(printer)
  const temps = MATERIAL_TEMPS[material]
  const cfg = applyEasy(easy, defaultConfig() as PrintConfig)
  const [w, d, h] = setup?.bed ?? shape.bed
  cfg.printable_area = setup?.area ?? [[0, 0], [w, 0], [w, d], [0, d]]
  cfg.printable_height = h
  // The printer's own keep-out zones, so the cloud's collision check sees what the printer keeps clear.
  for (const [k, v] of Object.entries(setup?.zones ?? {})) cfg[k] = v as PrintConfig[string]
  cfg.gcode_flavor = shape.flavor === 'bambu' ? 'marlin' : shape.flavor
  cfg.nozzle_temperature = Array.from({ length: Math.max(1, printer.nozzleCount) }, () => temps.nozzle)
  cfg['hot_plate_temp'] = [temps.bed]
  cfg['filament_type'] = [MATERIAL_LABEL[material]]
  cfg['filament_density'] = [temps.density]
  return cfg
}

/**
 * The send screen's time and filament estimate from a local run. The local estimator sizes a model
 * from its bounds, so a file the phone could not measure (3MF, OBJ) gets no estimate until the cloud
 * slices it.
 */
export function estimateOf(o: Pick<CloudSliceOutcome, 'timeS' | 'grams' | 'sizeMm'>): { timeS: number; grams: number; plates: number } | null {
  return o.sizeMm ? { timeS: o.timeS, grams: o.grams, plates: 1 } : null
}

function abortError(): DOMException {
  return new DOMException('Slice canceled', 'AbortError')
}

/** Sends the model to the cloud slicer and brings the G-code back. Rejects with an AbortError on cancel. */
export async function runCloudSlice(
  cloud: SlicerHost,
  input: CloudSliceInput,
  onPhase: (p: SlicePhase) => void,
  signal?: AbortSignal,
): Promise<CloudSliceOutcome> {
  onPhase({ kind: 'uploading' })
  const data = await input.model.load()
  if (signal?.aborted) throw abortError()
  // The phone measures only STL, and only for the build volume warning. No file gets a transform:
  // the cloud slicer centers the real mesh on the bed and sets it down, wherever its coordinates sit.
  const bounds = meshBounds(data)
  const mesh = await cloud.loadModel(data, input.model.name)
  const shape = machineFor(input.printer)
  const setup = printerSetup(input.printer)
  const bed = bedOf(input.printer)
  const [bw, bd, bh] = bed
  const warnings: string[] = []
  if (bounds.measured) {
    const [mx, my, mz] = bounds.sizeMm
    if (mx > bw || my > bd || mz > bh) warnings.push(`${input.model.name} is ${mx} x ${my} x ${mz} mm, larger than the ${bw} x ${bd} x ${bh} mm build volume of ${input.printer.name}`)
  }
  // PlateObject asks for a transform, but the cloud slicer sends a missing one as missing, and the
  // service then centers the mesh on the bed and sets it down (sx-core build_plate).
  const object = { id: 'obj-1', name: input.model.name, mesh: mesh.id } as PlateObject
  const config = phoneConfig(input.easy, input.printer, input.material)
  onPhase({ kind: 'queued' })
  try {
    const result = await cloud.slice(
      {
        plate: { bed: { widthMm: bw, depthMm: bd, heightMm: bh }, objects: [object] },
        config,
        options: {
          flavor: shape.flavor,
          emitGcode: true,
          emitPreview: false,
          ...(setup ? { printerId: setup.profileId } : {}),
          ...(input.plate !== undefined ? { plates: [input.plate] } : {}),
        },
      },
      { onProgress: (p) => onPhase({ kind: 'slicing', stage: p.stage, fraction: p.fraction }), ...(signal ? { signal } : {}) },
    )
    onPhase({ kind: 'downloading' })
    const out = await cloud.exportGcode(result.id, { kind: 'blob' })
    if (!out.blob) throw new Error('The cloud slicer returned no G-code')
    const bytes = await out.blob.arrayBuffer()
    cloud.release(result.id)
    for (const w of result.warnings) warnings.push(w.message)
    // A slice of one plate of a project has its collision check in that plate's report, not the job's.
    const picked = result.plates?.find((r) => r.status === 'succeeded')
    const checked = picked?.status === 'succeeded' ? picked.result : result
    return {
      file: { name: out.fileName, kind: 'gcode', data: bytes, sha256: out.sha256 },
      layerCount: result.layerCount,
      timeS: result.stats.timeS,
      grams: result.stats.filamentG.reduce((a, b) => a + b, 0),
      layerHeight: config.layer_height,
      ...(bounds.measured ? { sizeMm: bounds.sizeMm, fit: plateFit(bounds.sizeMm, bed) } : {}),
      warnings,
      collisions: checked.collisions ?? [],
      ...(checked.collisionPlate ? { collisionPlate: checked.collisionPlate } : {}),
      ...(checked.primeTower ? { primeTower: checked.primeTower } : {}),
    }
  } catch (e) {
    throw phoneCloudError(e, input.model.name)
  } finally {
    cloud.release(mesh.id)
  }
}

/**
 * What the phone says when a 3MF project is over the account's cloud upload limit (`limit`, as the service names it,
 * such as "10 MB"; each account has its own): the phone cannot slice it itself.
 */
export function projectOverCap(limit?: string): string {
  return `This project is over the ${limit ? `${limit} ` : ''}cloud limit. Slice it on your computer instead.`
}

/**
 * A cloud refusal in the phone's words. The cloud slicer's own next step, slicing on this device, does not apply on a
 * phone: a 3MF over the upload cap says to use the computer, and a daily limit keeps the service's count of what is
 * left without that step. Anything else passes through unchanged.
 */
export function phoneCloudError(e: unknown, fileName: string): unknown {
  if (!(e instanceof Error) || e.name === 'AbortError') return e
  const onDevice = / ?Slice on this device instead\.?$/
  if (/\.3mf$/i.test(fileName) && /over (this account's |the )?cloud upload limit/i.test(e.message)) {
    const limit = /cloud upload limit of ([0-9.]+ (?:MB|KB|bytes))/i.exec(e.message)?.[1]
    return new Error(projectOverCap(limit))
  }
  if (/cloud slices for the last 24 hours|more (plate|plates) (in the cloud )?today|this job slices \d+ plates/i.test(e.message) && onDevice.test(e.message)) {
    const text = e.message.replace(onDevice, '')
    return new Error(text.charAt(0).toUpperCase() + text.slice(1))
  }
  return e
}
