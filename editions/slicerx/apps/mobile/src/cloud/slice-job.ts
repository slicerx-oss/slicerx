// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slice from the phone: one model, one printer and the Easy settings go to the
// cloud slicer (Host['cloud'], a SlicerHost), and the G-code comes back as a
// JobFile ready for PrinterHost.upload. Nothing here touches a printer; sending
// is a separate, approval-gated step (screens/slice.tsx).
import type { EasySettings, GcodeFlavor, JobFile, PrintConfig, PrinterInfo, SliceStage, SlicerHost } from '@slicerx/contracts'
import { applyEasy, defaultConfig } from '@slicerx/settings'

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
  sizeMm: [number, number, number]
  warnings: string[]
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

/** The resolved config for a phone slice: schema defaults, then Easy mode, then the printer and material. */
export function phoneConfig(easy: EasySettings, printer: PrinterInfo, material: Material): PrintConfig {
  const shape = machineFor(printer)
  const temps = MATERIAL_TEMPS[material]
  const cfg = applyEasy(easy, defaultConfig() as PrintConfig)
  const [w, d, h] = shape.bed
  cfg.printable_area = [[0, 0], [w, 0], [w, d], [0, d]]
  cfg.printable_height = h
  cfg.gcode_flavor = shape.flavor === 'bambu' ? 'marlin' : shape.flavor
  cfg.nozzle_temperature = Array.from({ length: Math.max(1, printer.nozzleCount) }, () => temps.nozzle)
  cfg['hot_plate_temp'] = [temps.bed]
  cfg['filament_type'] = [MATERIAL_LABEL[material]]
  cfg['filament_density'] = [temps.density]
  return cfg
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
  const mesh = await cloud.loadModel(data, input.model.name)
  const shape = machineFor(input.printer)
  const [bw, bd, bh] = shape.bed
  const [mx, my, mz] = mesh.bboxMm
  const warnings: string[] = []
  if (mx > bw || my > bd || mz > bh) warnings.push(`${input.model.name} is ${mx} x ${my} x ${mz} mm, larger than the ${bw} x ${bd} x ${bh} mm build volume of ${input.printer.name}`)
  const config = phoneConfig(input.easy, input.printer, input.material)
  // Centered on the bed, Z up, column-major.
  const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (bw - mx) / 2, (bd - my) / 2, 0, 1]
  onPhase({ kind: 'queued' })
  try {
    const result = await cloud.slice(
      {
        plate: { bed: { widthMm: bw, depthMm: bd, heightMm: bh }, objects: [{ id: 'obj-1', name: input.model.name, mesh: mesh.id, transform }] },
        config,
        options: { flavor: shape.flavor, emitGcode: true, emitPreview: false },
      },
      { onProgress: (p) => onPhase({ kind: 'slicing', stage: p.stage, fraction: p.fraction }), ...(signal ? { signal } : {}) },
    )
    onPhase({ kind: 'downloading' })
    const out = await cloud.exportGcode(result.id, { kind: 'blob' })
    if (!out.blob) throw new Error('The cloud slicer returned no G-code')
    const bytes = await out.blob.arrayBuffer()
    cloud.release(result.id)
    for (const w of result.warnings) warnings.push(w.message)
    return {
      file: { name: out.fileName, kind: 'gcode', data: bytes, sha256: out.sha256 },
      layerCount: result.layerCount,
      timeS: result.stats.timeS,
      grams: result.stats.filamentG.reduce((a, b) => a + b, 0),
      layerHeight: config.layer_height,
      sizeMm: mesh.bboxMm,
      warnings,
    }
  } finally {
    cloud.release(mesh.id)
  }
}
