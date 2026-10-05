// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The real engine: runs the `sx` CLI as a separate process and exchanges files
// with it, so the server works with any build of the core, including one with
// the optional OrcaSlicer-derived packages.
import { spawn } from 'node:child_process'
import { accessSync, constants, mkdirSync, writeFileSync } from 'node:fs'
import { basename, delimiter, extname, join } from 'node:path'
import type { SettingValue } from '@slicerx/contracts'
import { ToolInputError } from './models'
import type { SlicerBackend, SliceSummary } from './slicer'
import { formatDuration } from './slicer'

/** Finds a binary by name: an explicit path, other candidates in order, then PATH. */
export function findBinary(name: string, explicit?: string, extra: (string | undefined)[] = []): string | undefined {
  const exe = process.platform === 'win32' ? `${name}.exe` : name
  const candidates = explicit !== undefined ? [explicit] : [...extra, ...(process.env['PATH'] ?? '').split(delimiter).filter(Boolean).map((d) => join(d, exe))]
  for (const c of candidates) {
    if (!c) continue
    try {
      accessSync(c, constants.X_OK)
      return c
    } catch {
      // Not executable here; try the next candidate.
    }
  }
  return undefined
}

/** Finds the sx binary: an explicit path, SLICERX_SX_BIN, then PATH. */
export function findSx(explicit?: string): string | undefined {
  return findBinary('sx', explicit, [process.env['SLICERX_SX_BIN']])
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

function scalar(v: SettingValue | undefined): number | undefined {
  const x = Array.isArray(v) ? v[0] : v
  if (typeof x === 'number') return x
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x)
  return undefined
}

/**
 * sx reads Orca keys and ignores the ones it does not implement yet. Line
 * widths given as a percent of the nozzle or as 0 (auto) become millimeters or
 * are left to sx's default, since sx wants millimeters.
 */
export function sxConfig(config: Record<string, SettingValue>): Record<string, SettingValue> {
  const nozzle = scalar(config['nozzle_diameter']) ?? 0.4
  const out: Record<string, SettingValue> = {}
  for (const [k, v] of Object.entries(config)) {
    if (k.endsWith('line_width') && typeof v === 'string') {
      const t = v.trim()
      const mm = t.endsWith('%') ? (Number(t.slice(0, -1)) / 100) * nozzle : Number(t)
      if (Number.isFinite(mm) && mm > 0) out[k] = Math.round(mm * 1000) / 1000
      continue
    }
    out[k] = v
  }
  return out
}

/**
 * The bed the printer settings describe, for placing a file on it: `printable_area` with its corner at the origin
 * and `printable_height`. Undefined when the area is missing or starts elsewhere, so the engine's default bed holds.
 */
export function bedOf(config: Record<string, SettingValue>): { widthMm: number; depthMm: number; heightMm: number } | undefined {
  const area = config['printable_area']
  if (!Array.isArray(area)) return undefined
  const pts = (area as unknown[]).flatMap((p) => {
    const xy = Array.isArray(p) ? p : typeof p === 'string' ? p.split('x') : []
    const [x, y] = xy.map(Number)
    return x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y) ? [[x, y] as const] : []
  })
  if (pts.length < 3) return undefined
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  if (Math.min(...xs) !== 0 || Math.min(...ys) !== 0) return undefined
  const height = scalar(config['printable_height'])
  return { widthMm: Math.max(...xs), depthMm: Math.max(...ys), heightMm: height && height > 0 ? height : 250 }
}

interface Parsed {
  layers: number
  timeS: number
  filamentMm: number
}

/** Reads sx's result: a JSON object when the CLI prints one, else its one-line summary. */
export function parseSxOutput(stdout: string): Parsed {
  const text = stdout.trim()
  if (text.startsWith('{')) {
    const o = JSON.parse(text) as Record<string, unknown>
    const stats = (typeof o['stats'] === 'object' && o['stats'] !== null ? o['stats'] : o) as Record<string, unknown>
    const sum = (v: unknown): number => (Array.isArray(v) ? v.reduce<number>((a, b) => a + (typeof b === 'number' ? b : 0), 0) : typeof v === 'number' ? v : 0)
    return {
      layers: sum(o['layer_count'] ?? o['layerCount']),
      timeS: sum(stats['time_s'] ?? stats['timeS']),
      filamentMm: sum(stats['filament_mm'] ?? stats['filamentMm']),
    }
  }
  // "508 layers, 190.2 ms, 123 bytes of G-code, 36600 s estimated, filament [1234.0] mm, 0 tool changes"
  const layers = /(\d+)\s+layers/.exec(text)
  const time = /([\d.]+)\s*s estimated/.exec(text)
  const fil = /filament\s*\[([^\]]*)\]\s*mm/.exec(text)
  if (!layers || !time) throw new Error(`Could not read the sx output: ${text.slice(0, 200)}`)
  const filamentMm = (fil?.[1] ?? '').split(',').map((s) => Number(s.trim())).filter(Number.isFinite).reduce((a, b) => a + b, 0)
  return { layers: Number(layers[1]), timeS: Number(time[1]), filamentMm }
}

/**
 * Slices with `sx slice --request <json> --out-dir <dir>`: one object for a
 * file, or every object of a project plate with its transform. The result
 * JSON carries the time, filament per slot (length and grams) and warnings.
 */
export function createSxSlicer(bin: string, timeoutMs = 10 * 60_000): SlicerBackend {
  return {
    kind: 'sx',
    async slice(job) {
      mkdirSync(job.outDir, { recursive: true })
      const objects = job.plate?.objects ?? [{ path: job.modelPlate ? `${job.modelPath}#${job.modelPlate}` : job.modelPath, name: basename(job.modelPath) }]
      // A file is placed on the printer's own bed, so a project keeps its objects where they fit.
      const bed = job.plate?.bed ?? bedOf(job.config)
      const meshes = Object.fromEntries(objects.map((o, i) => [`m${i}`, o.path]))
      const request = {
        schemaVersion: 1,
        plate: {
          ...(bed ? { bed } : {}),
          objects: objects.map((o, i) => ({ id: `o${i}`, name: o.name, mesh: `m${i}`, ...(o.transform ? { transform: o.transform } : {}) })),
        },
        config: sxConfig(job.explicitConfig),
        options: { emitGcode: job.emitGcode, emitPreview: job.emitPreview ?? false, ...(job.trustedGcode ? { trustedGcode: true } : {}) },
        meshes,
      }
      const requestPath = join(job.outDir, 'request.json')
      writeFileSync(requestPath, JSON.stringify(request))
      const { code, stdout, stderr } = await run(bin, ['slice', '--request', requestPath, '--out-dir', job.outDir], timeoutMs)
      if (code !== 0) {
        const why = stderr.trim().split('\n').slice(-3).join(' ') || 'no error output'
        // Exit codes: 1 slicing failed, 2 usage, 3 invalid input (docs/embedding.md).
        throw new ToolInputError(`sx exited with code ${code}: ${why}`, /no plate \d+/.test(why) ? 'no_such_plate' : /safety preflight/.test(why) ? 'preflight_blocked' : /printing by object is not safe/.test(why) ? 'sequence_clearance' : code === 3 ? 'invalid_model' : 'slice_failed')
      }
      const out = JSON.parse(stdout.trim()) as {
        layerCount?: number
        gcodeSha256?: string
        stats?: { timeS?: number; filamentMm?: number[]; filamentG?: number[]; toolChanges?: number }
        warnings?: { message?: string }[]
        files?: { gcode?: string; preview?: string } & Record<string, unknown>
      }
      const sum = (v: number[] | undefined): number => (v ?? []).reduce((a, b) => a + b, 0)
      const timeS = out.stats?.timeS ?? 0
      const files = out.files ?? {}
      const gcodePath = typeof files.gcode === 'string' ? files.gcode : join(job.outDir, 'slice.gcode')
      const previewPath = typeof files.preview === 'string' ? files.preview : join(job.outDir, 'slice.sxpv')
      const summary: SliceSummary = {
        engine: 'sx',
        model: { name: job.plate ? `${objects.length} object${objects.length === 1 ? '' : 's'}` : basename(job.modelPath) },
        layer_count: out.layerCount ?? 0,
        time_s: Math.round(timeS),
        time_text: formatDuration(timeS),
        filament_g: Math.round(sum(out.stats?.filamentG) * 10) / 10,
        filament_mm: Math.round(sum(out.stats?.filamentMm)),
        filaments: (out.stats?.filamentMm ?? []).map((mm, i) => ({ slot: i + 1, filament_mm: Math.round(mm), filament_g: Math.round((out.stats?.filamentG?.[i] ?? 0) * 10) / 10 })),
        ...(out.stats?.toolChanges !== undefined ? { tool_changes: out.stats.toolChanges } : {}),
        ...(job.modelPlate && !job.plate ? { plate: job.modelPlate } : {}),
        ...(job.emitGcode && out.gcodeSha256 ? { gcode_sha256: out.gcodeSha256 } : {}),
        warnings: (out.warnings ?? []).map((w) => String(w.message ?? '')),
        ...(job.emitGcode ? { gcode_path: gcodePath } : {}),
        ...(job.emitPreview ? { preview_path: previewPath } : {}),
      }
      return summary
    },
  }
}
