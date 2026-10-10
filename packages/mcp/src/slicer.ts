// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slicing backends. The real one runs the `sx` CLI as a separate process; the
// stub gives a rough estimate from the mesh so clients can be built and tested
// before the core ships.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { SettingValue } from '@slicerx/contracts'
import { readStl } from './mesh'
import { ToolInputError } from './models'

export interface SliceJob {
  modelPath: string
  /** For a 3MF or .sx3mf project: the plate to slice, 1-based. Unset slices the first plate. */
  modelPlate?: number
  /** Resolved settings: schema defaults, then profiles, then overrides, in schema shapes. */
  config: Record<string, SettingValue>
  /** Only the keys the profiles and overrides set, for engines with their own defaults. */
  explicitConfig: Record<string, SettingValue>
  /** Profile names as given, for engines that resolve profiles themselves. */
  profileNames: string[]
  overrides: Record<string, SettingValue>
  outDir: string
  emitGcode: boolean
  /** The custom G-code is SlicerX's shipped text, so the engine's normal G-code checks apply rather than the strict ones. */
  trustedGcode?: boolean
  /** Also write the SXPV preview buffer (sx engine only). */
  emitPreview?: boolean
  /** Slice even when paths cross or meet the toolhead (sx engine only); refused by default. */
  allowCollisions?: boolean
  /** A whole plate: every object's mesh file and transform (sx engine). `modelPath` is then a combined STL for engines that take one file. */
  plate?: { bed?: { widthMm: number; depthMm: number; heightMm: number }; objects: { path: string; name: string; transform?: number[] }[] }
}

export interface SliceSummary {
  engine: 'sx' | 'stub'
  model: { name: string; triangles?: number; bbox_mm?: [number, number, number] }
  layer_count: number
  time_s: number
  time_text: string
  filament_g: number
  filament_mm: number
  /** Use per filament slot (slot 1 is the first filament), for multi-material plates and spool tracking. */
  filaments: { slot: number; filament_mm: number; filament_g: number }[]
  tool_changes?: number
  /** The plate that was sliced, for a 3MF or .sx3mf project. */
  plate?: number
  gcode_path?: string
  gcode_sha256?: string
  /** A Bambu Lab style .gcode.3mf holding the plate's G-code, when one was asked for. */
  gcode_3mf_path?: string
  preview_path?: string
  warnings: string[]
  note?: string
}

export interface SlicerBackend {
  readonly kind: 'sx' | 'stub'
  slice(job: SliceJob): Promise<SliceSummary>
}

export function formatDuration(s: number): string {
  const total = Math.max(0, Math.round(s / 60))
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function firstNum(v: SettingValue | undefined, fallback: number): number {
  const x = Array.isArray(v) ? v[0] : v
  if (typeof x === 'number' && Number.isFinite(x)) return x
  if (typeof x === 'string' && Number.isFinite(Number(x.replace('%', '')))) return Number(x.replace('%', ''))
  return fallback
}

/** Marker the printer tools look for so stub output is never sent to a printer. */
export const STUB_MARKER = '; SLICERX_STUB_OUTPUT not printable'

/**
 * Estimates from mesh volume and surface area. Reads STL only. Walls and
 * shells are approximated as surface area times wall thickness, infill as the
 * remaining volume times the infill density, and print time from half the
 * filament's maximum volumetric speed plus a per-layer overhead.
 */
export function createStubSlicer(): SlicerBackend {
  return {
    kind: 'stub',
    async slice(job) {
      if (extname(job.modelPath).toLowerCase() !== '.stl') {
        throw new ToolInputError('The stub engine reads STL files only. Convert the model to STL, or use the sx engine (docs/install.md).', 'unsupported_format')
      }
      const mesh = readStl(readFileSync(job.modelPath))
      const c = job.config
      const nozzle = firstNum(c['nozzle_diameter'], 0.4)
      const layerH = firstNum(c['layer_height'], 0.2)
      const firstH = firstNum(c['initial_layer_print_height'], layerH)
      const walls = firstNum(c['wall_loops'], 2)
      const lineW = firstNum(c['line_width'], 0) || nozzle * 1.05
      const infill = firstNum(c['sparse_infill_density'], 15) / 100
      const density = firstNum(c['filament_density'], 0) || 1.24
      const maxFlow = firstNum(c['filament_max_volumetric_speed'], 0) || 12
      const diameter = firstNum(c['filament_diameter'], 1.75)

      const height = mesh.bboxMm[2]
      const layers = height <= firstH ? 1 : 1 + Math.ceil((height - firstH) / layerH - 1e-9)
      const shell = Math.min(mesh.volumeMm3, (mesh.areaMm2 * walls * lineW) / 2)
      const extruded = shell + (mesh.volumeMm3 - shell) * infill
      const timeS = extruded / (maxFlow * 0.5) + layers * 1.5
      const grams = (extruded / 1000) * density
      const mm = extruded / (Math.PI * (diameter / 2) ** 2)

      const warnings: string[] = []
      const area = c['printable_area']
      if (Array.isArray(area) && area.length >= 3) {
        const xs = (area as unknown[]).flatMap((p) => (Array.isArray(p) && typeof p[0] === 'number' ? [p[0]] : []))
        const ys = (area as unknown[]).flatMap((p) => (Array.isArray(p) && typeof p[1] === 'number' ? [p[1]] : []))
        if (xs.length && ys.length && (mesh.bboxMm[0] > Math.max(...xs) - Math.min(...xs) || mesh.bboxMm[1] > Math.max(...ys) - Math.min(...ys))) {
          warnings.push(`The model (${mesh.bboxMm[0]} x ${mesh.bboxMm[1]} mm) is larger than the bed.`)
        }
      }
      const printableH = firstNum(c['printable_height'], 0)
      if (printableH > 0 && height > printableH) warnings.push(`The model is ${height} mm tall; the printer allows ${printableH} mm.`)

      const summary: SliceSummary = {
        engine: 'stub',
        model: { name: basename(job.modelPath), triangles: mesh.triangles, bbox_mm: mesh.bboxMm },
        layer_count: layers,
        time_s: Math.round(timeS),
        time_text: formatDuration(timeS),
        filament_g: Math.round(grams * 10) / 10,
        filament_mm: Math.round(mm),
        filaments: [{ slot: 1, filament_mm: Math.round(mm), filament_g: Math.round(grams * 10) / 10 }],
        warnings,
        note: 'Rough estimate from mesh volume by the stub engine, not a real slice. Install the sx CLI for real G-code.',
      }
      if (job.emitGcode) {
        mkdirSync(job.outDir, { recursive: true })
        const path = join(job.outDir, `${basename(job.modelPath, extname(job.modelPath))}.stub.gcode`)
        writeFileSync(path, [STUB_MARKER, `; model ${summary.model.name}`, `; layers ${layers}`, `; estimated time ${summary.time_text}`, `; estimated filament ${summary.filament_g} g`, ''].join('\n'))
        summary.gcode_path = path
      }
      return summary
    },
  }
}
