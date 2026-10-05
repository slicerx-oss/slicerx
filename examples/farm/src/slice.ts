// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slicing one model with the sx command line tool: build a SliceRequest, run
// `sx slice --request <file> --out-dir <dir>`, read the result JSON it prints.
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

export interface Bed {
  widthMm: number
  depthMm: number
  heightMm: number
}

export interface SliceSettings {
  /** Settings by OrcaSlicer key, for example `{ "layer_height": 0.2, "wall_loops": 3 }`. */
  config: Record<string, unknown>
  bed: Bed
  /** G-code flavor (`marlin2`, `klipper`, `bambu`, `reprapfirmware`), when the printer needs a specific one. */
  flavor?: string
}

/** The part of the result JSON this tool reads. `sx schema result` has the full shape. */
export interface SliceResult {
  layerCount: number
  wallMs: number
  gcodeBytes: number
  previewBytes: number
  gcodeFormat?: string
  stats: { timeS: number; filamentG: number[] }
  warnings: { code: string; message: string; layer?: number }[]
  files?: { gcode: string; preview: string }
}

export const MODEL_EXTENSIONS = ['.stl', '.3mf', '.obj']

export function isModel(file: string): boolean {
  return MODEL_EXTENSIONS.includes(extname(file).toLowerCase())
}

/** A folder name for a model's output: its file name without the extension, in safe characters. */
export function jobName(modelPath: string): string {
  const stem = basename(modelPath, extname(modelPath))
  return stem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'model'
}

/** The SliceRequest JSON for one model on an empty plate. The engine places it on the bed. */
export function buildRequest(modelPath: string, s: SliceSettings): Record<string, unknown> {
  return {
    schemaVersion: 1,
    meshes: { model: resolve(modelPath) },
    plate: { bed: s.bed, objects: [{ id: 'o1', name: basename(modelPath), mesh: 'model' }] },
    config: s.config,
    ...(s.flavor ? { options: { flavor: s.flavor } } : {}),
  }
}

/** Runs a command and resolves with its stdout, or rejects with its stderr and exit code. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    p.stdout.on('data', (b: Buffer) => out.push(b))
    p.stderr.on('data', (b: Buffer) => err.push(b))
    p.on('error', fail)
    p.on('close', (code) => {
      if (code === 0) ok(Buffer.concat(out).toString('utf8'))
      else fail(new Error(`${cmd} exited with ${code}: ${Buffer.concat(err).toString('utf8').trim()}`))
    })
  })
}

/**
 * Slices `modelPath` into `outDir`: request.json, slice.gcode (or slice.bgcode), slice.sxpv (the
 * toolpath preview that @slicerx/viewport draws) and result.json.
 */
export async function sliceModel(sx: string, modelPath: string, outDir: string, s: SliceSettings): Promise<SliceResult> {
  await mkdir(outDir, { recursive: true })
  const requestPath = join(outDir, 'request.json')
  await writeFile(requestPath, JSON.stringify(buildRequest(modelPath, s), null, 2) + '\n')
  const stdout = await run(sx, ['slice', '--request', requestPath, '--out-dir', outDir])
  const result = JSON.parse(stdout) as SliceResult
  await writeFile(join(outDir, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  return result
}

/** One line for the log: layers, print time, filament and output size. */
export function describe(name: string, r: SliceResult): string {
  const t = r.stats.timeS
  const g = r.stats.filamentG.reduce((a, b) => a + b, 0)
  const h = Math.floor(t / 3600)
  const m = Math.round((t % 3600) / 60)
  const kb = Math.round(r.gcodeBytes / 1024)
  return `${name}: ${r.layerCount} layers, ${h} h ${m} min, ${g.toFixed(1)} g, ${kb} KB of G-code, sliced in ${Math.round(r.wallMs)} ms`
}
