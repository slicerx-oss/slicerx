// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The real engine: runs the `sx` CLI as a separate process and exchanges files
// with it, so the server works with any build of the core, including one with
// the optional OrcaSlicer-derived packages.
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, mkdirSync, writeFileSync } from 'node:fs'
import { basename, delimiter, extname, join } from 'node:path'
import type { SettingValue, ScriptReview, ScriptReviewInput, ScriptReplacement, AppliedScriptReplacement } from '@slicerx/contracts'
import { readPlateCheck } from '@slicerx/contracts'
import { areaOrigin } from '@slicerx/threemf/area'
import { collisionError, refusedHits, sliceCollisions, sxCollisions } from './collide'
import { featureFilaments } from './feature-filaments'
import { ToolInputError } from './models'
import type { SlicerBackend, SliceJob, SliceJobObject, SliceSummary } from './slicer'
import { formatDuration } from './slicer'

/** Finds a binary by name: an explicit path, other candidates in order, then PATH. */
/** The engine's line after a custom G-code refusal for a printer it knows whose text matches none of its stock versions. */
const GCODE_REVIEW_NOTE = /\s*This project's G-code for (.+?) matches no known stock version, so a person has to review it\..*$/s

/**
 * The error for a failed `sx` run, from its exit code and the last lines it wrote. Exit codes: 1 slicing failed,
 * 2 usage, 3 invalid input (docs/embedding.md). A plate refused because its toolpaths leave the bed carries the
 * engine's own fix (the object to move, or arranging the plate) and names the tool that arranges a project's plate.
 */
export function sxFailure(code: number | null, why: string): ToolInputError {
  if (/no plate \d+/.test(why)) return new ToolInputError(`sx exited with code ${code}: ${why}`, 'no_such_plate')
  if (/safety preflight/.test(why)) {
    // A toolpath refusal's count names the layers its hits are on, within those the engine checked before it refused.
    const range = /\bin layers? (\d+)(?: to (\d+))?/.exec(why)
    const layers = range ? { layers: [Number(range[1]), Number(range[2] ?? range[1])] } : {}
    if (/outside the printable area/.test(why)) {
      return new ToolInputError(`sx exited with code ${code}: ${why}. In a project, slicerx_arrange places the objects on the bed.`, 'preflight_blocked', { reason: 'outside_bed', fix: 'slicerx_arrange', ...layers })
    }
    if (/excluded bed area/.test(why)) {
      return new ToolInputError(`sx exited with code ${code}: ${why}. In a project, slicerx_arrange places the objects clear of it.`, 'preflight_blocked', { reason: 'in_exclusion_zone', fix: 'slicerx_arrange', ...layers })
    }
    // The engine's note on G-code a person has to review names its command line and request options, which a tool
    // call has neither of: say it in this server's terms.
    const review = GCODE_REVIEW_NOTE.exec(why)
    if (review) {
      const printer = review[1]!
      return new ToolInputError(`sx exited with code ${code}: ${why.slice(0, review.index).trimEnd()} The G-code for ${printer} matches no known stock version, so a person has to review it, and no tool call can approve it. Leave out the G-code settings to slice with the printer profile's own.`, 'preflight_blocked', { reason: 'gcode_review', printer })
    }
    const reason = /outside the reach of extruder/.test(why) ? 'outside_extruder_reach' : /above the printable height/.test(why) ? 'over_height' : undefined
    return new ToolInputError(`sx exited with code ${code}: ${why}`, 'preflight_blocked', reason ? { reason, ...layers } : undefined)
  }
  return new ToolInputError(`sx exited with code ${code}: ${why}`, code === 3 ? 'invalid_model' : 'slice_failed')
}

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

/** How a run of a binary ended: its exit code, or the signal that stopped it and whether that was the time limit. */
export interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  stdout: string
  stderr: string
}

/**
 * Runs a binary with its own time limit. A process stopped by a signal has no exit code, so the result keeps the
 * signal and whether the limit stopped it. Only this timer's kill can do that on Windows: a process ended from outside
 * there exits with a code. A process that ignores the first signal is killed outright a few seconds later.
 */
export function runSx(bin: string, args: string[], timeoutMs: number, input?: string, onSpawn?: (child: ChildProcess) => void): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let timedOut = false
    let force: NodeJS.Timeout | undefined
    const limit = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      force = setTimeout(() => child.kill('SIGKILL'), 5_000)
    }, timeoutMs)
    const stop = () => {
      clearTimeout(limit)
      clearTimeout(force)
    }
    // The limit keeps running after a refused input, so the process still cannot outlive it.
    child.stdin.on('error', reject)
    child.stdin.end(input)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', (e) => {
      stop()
      reject(e)
    })
    child.on('close', (code, signal) => {
      stop()
      resolve({ code, signal, timedOut, stdout, stderr })
    })
    onSpawn?.(child)
  })
}

/** A time limit in words: "10 min", "90 s", "500 ms". */
export function formatLimit(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 6_000) / 10} min`
  if (ms >= 1_000) return `${Math.round(ms / 100) / 10} s`
  return `${Math.round(ms)} ms`
}

/** The error for a run that ended without an exit code: the time limit, or another signal. Undefined for an exit code. */
export function sxStopped(r: Pick<RunResult, 'code' | 'signal' | 'timedOut'>, limitMs: number): ToolInputError | undefined {
  // A run that finished cleanly as the limit fired still counts.
  if (r.timedOut && r.code !== 0) return new ToolInputError(`sx stopped after the ${formatLimit(limitMs)} time limit without finishing`, 'slice_timeout', { limitMs })
  if (r.code === null) return new ToolInputError(`sx was stopped (${r.signal ?? 'by a signal'}) before it finished`, 'slice_failed', r.signal ? { signal: r.signal } : undefined)
  return undefined
}

function scalar(v: SettingValue | undefined): number | undefined {
  const x = Array.isArray(v) ? v[0] : v
  if (typeof x === 'number') return x
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x)
  return undefined
}

/**
 * sx reads Orca keys and ignores the ones it does not implement yet. Line
 * widths given as a percent of the nozzle become millimeters, since sx wants
 * millimeters; a width of 0 stays 0, which sx reads as automatic, as
 * `sx slice <project.3mf>` does. A width that is not a number is left to sx's
 * default. The widths in `asGiven` (an opened project's, as the app sends them)
 * go to sx as they are.
 */
export function sxConfig(config: Record<string, SettingValue>, asGiven: readonly string[] = []): Record<string, SettingValue> {
  const nozzle = scalar(config['nozzle_diameter']) ?? 0.4
  const out: Record<string, SettingValue> = {}
  for (const [k, v] of Object.entries(config)) {
    if (k.endsWith('line_width') && typeof v === 'string' && !asGiven.includes(k)) {
      const t = v.trim()
      const mm = t.endsWith('%') ? (Number(t.slice(0, -1)) / 100) * nozzle : Number(t)
      if (Number.isFinite(mm) && mm >= 0) out[k] = Math.round(mm * 1000) / 1000
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
 * Writes the sx request for `job` into its out dir: the plate's objects by the engine's ids (o0, o1), their meshes, the
 * settings in the engine's shapes and the options. The slice and the plate check read the same request.
 */
function writeRequest(job: SliceJob): { requestPath: string; objects: (SliceJobObject | { path: string; name: string })[] } {
  mkdirSync(job.outDir, { recursive: true })
  const objects = job.plate?.objects ?? [{ path: job.modelPlate ? `${job.modelPath}#${job.modelPlate}` : job.modelPath, name: basename(job.modelPath) }]
  // A file is placed on the printer's own bed, so a project keeps its objects where they fit.
  const bed = job.plate?.bed ?? bedOf(job.config)
  // Paint goes with the one object it was given for; part indices are those of that object's mesh.
  if (job.paint && objects.length !== 1) throw new ToolInputError(`Paint applies to one object, and this plate has ${objects.length}. Slice the painted object on its own, or give it a plate of its own.`, 'invalid_input')
  const meshes: Record<string, string | { file: string; paint: NonNullable<typeof job.paint> }> = Object.fromEntries(objects.map((o, i) => [`m${i}`, job.paint ? { file: o.path, paint: job.paint } : o.path]))
  // An object's or a volume's own settings, in the engine's shapes (a line width in % of the plate's nozzle).
  const local = (s: Record<string, SettingValue>): Record<string, SettingValue> => {
    const out = sxConfig({ nozzle_diameter: job.config['nozzle_diameter'] ?? 0.4, ...s })
    if (!('nozzle_diameter' in s)) delete out['nozzle_diameter']
    return out
  }
  const requestObjects = objects.map((o, i) => {
    const volumes = (('volumes' in o ? o.volumes : undefined) ?? []).map((v, j) => {
      meshes[`m${i}v${j}`] = v.path
      return { role: v.role, mesh: `m${i}v${j}`, ...(v.name ? { name: v.name } : {}), ...(v.transform ? { transform: v.transform } : {}), ...(v.settings ? { settings: local(v.settings) } : {}) }
    })
    const settings = 'settings' in o ? o.settings : undefined
    return { id: `o${i}`, name: o.name, mesh: `m${i}`, ...(o.transform ? { transform: o.transform } : {}), ...(settings ? { settings: local(settings) } : {}), ...(volumes.length ? { volumes } : {}) }
  })
  // Height ranges name plate objects by their own ids; the request names them o0, o1 and so on.
  const requestId = new Map(objects.flatMap((o, i) => ('id' in o && o.id ? [[o.id, `o${i}`] as const] : [])))
  const heightRanges = (job.heightRanges ?? []).map((r) => ({
    zFromMm: r.zFromMm,
    zToMm: r.zToMm,
    settings: local(r.settings),
    ...(r.objects ? { objects: r.objects.map((id) => requestId.get(id) ?? id) } : {}),
  }))
  const request = {
    schemaVersion: 1,
    ...(job.scriptReplacements ? { script_replacements: job.scriptReplacements } : {}),
    plate: {
      ...(bed ? { bed } : {}),
      objects: requestObjects,
    },
    config: sxConfig(job.explicitConfig, job.widthsAsGiven),
    // The config is a whole resolved profile, so the engine's list of keys it never reads would be long and say
    // nothing about the person's file (import_report does that); a refused value names its key instead.
    options: { emitGcode: job.emitGcode, emitPreview: job.emitPreview ?? false, configReport: false, ...(job.trustedGcode ? { trustedGcode: true } : {}), ...(heightRanges.length ? { heightRanges } : {}) },
    meshes,
  }
  const requestPath = join(job.outDir, 'request.json')
  writeFileSync(requestPath, JSON.stringify(request))
  return { requestPath, objects }
}

/**
 * Slices with `sx slice --request <json> --out-dir <dir>`: one object for a
 * file, or every object of a project plate with its transform. The result
 * JSON carries the time, filament per slot (length and grams) and warnings.
 */
export function createSxSlicer(bin: string, timeoutMs = 10 * 60_000): SlicerBackend {
  async function reviewScripts(inputs: ScriptReviewInput[]): Promise<ScriptReview[]> {
    if (inputs.length === 0) return []
    const result = await runSx(bin, ['review-script', '-', '--batch'], Math.min(timeoutMs, 30_000), JSON.stringify(inputs))
    if (result.code !== 0) throw new ToolInputError('The engine could not review the printer scripts', 'engine_unavailable')
    let reviews: unknown
    try { reviews = JSON.parse(result.stdout) } catch { throw new ToolInputError('The engine returned an unreadable script review', 'engine_unavailable') }
    if (!Array.isArray(reviews) || reviews.length !== inputs.length || reviews.some((r) => !r || r.schemaVersion !== 1 || !['exact', 'cosmetic', 'review'].includes(r.decision) || typeof r.reason !== 'string')) throw new ToolInputError('The engine returned an unsupported script review', 'engine_unavailable')
    return reviews as ScriptReview[]
  }
  return {
    reviewScripts,
    async reviewScript(input) {
      return (await reviewScripts([input]))[0]!
    },
    async prepareScriptReplacement(input) {
      const result = await runSx(bin, ['prepare-script-replacement', '-'], Math.min(timeoutMs, 30_000), JSON.stringify(input))
      if (result.code !== 0) throw new ToolInputError('The engine could not prepare the stock-script replacement', 'engine_unavailable')
      let record: ScriptReplacement
      try { record = JSON.parse(result.stdout) } catch { throw new ToolInputError('The engine returned an unreadable replacement record', 'engine_unavailable') }
      if (!record || record.schemaVersion !== 1 || !['prepared', 'review'].includes(record.decision) || typeof record.reason !== 'string' || record.key !== input.key || record.original !== input.original || record.replacement !== input.replacement || !Array.isArray(record.diff)) throw new ToolInputError('The engine returned an unsupported replacement record', 'engine_unavailable')
      return record
    },
    kind: 'sx',
    async check(job) {
      const { requestPath } = writeRequest(job)
      const limit = Math.min(timeoutMs, 120_000)
      const ran = await runSx(bin, ['check', '--request', requestPath], limit)
      const stopped = sxStopped(ran, limit)
      if (stopped) throw stopped
      // 0: nothing the slice is sure to refuse; 3: a strike it is. Both print the check.
      if (ran.code !== 0 && !(ran.code === 3 && ran.stdout.trim().startsWith('{'))) throw sxFailure(ran.code, ran.stderr.trim().split('\n').slice(-3).join(' ') || 'no error output')
      try {
        return readPlateCheck(JSON.parse(ran.stdout.trim()))
      } catch (e) {
        throw new ToolInputError(`The engine returned an unreadable plate check: ${e instanceof Error ? e.message : String(e)}`, 'engine_unavailable')
      }
    },
    async slice(job) {
      const { requestPath, objects } = writeRequest(job)
      const ran = await runSx(bin, ['slice', '--request', requestPath, '--out-dir', job.outDir, ...(job.scriptPrinter ? ['--script-printer', job.scriptPrinter.model, '--script-firmware', job.scriptPrinter.firmware] : []), ...(job.allowCollisions ? ['--allow-collisions'] : [])], timeoutMs)
      const stopped = sxStopped(ran, timeoutMs)
      if (stopped) throw stopped
      const { code, stdout, stderr } = ran
      // The plate's objects by the engine's ids (o0, o1), and where the plate's 0, 0 sits on the machine sx works in.
      const named = objects.map((o) => ({ ...('id' in o && o.id ? { id: o.id } : {}), name: o.name }))
      const origin = areaOrigin(job.config['printable_area'])
      if (code !== 0) {
        const why = stderr.trim().split('\n').slice(-3).join(' ') || 'no error output'
        // Collisions come back as their own code, in words for a person and with the objects and layers as details.
        const hits = code === 3 ? refusedHits(stdout) : undefined
        const list = hits ? sliceCollisions(sxCollisions(JSON.parse(stdout.trim())), named, origin) : []
        const collided = code === 3 ? collisionError(why, objects.map((o) => o.name), hits ? { hits, objects: objects.map((o) => ('id' in o && o.id ? { id: o.id } : {})), list } : undefined) : undefined
        if (collided) throw collided
        throw sxFailure(code, why)
      }
      const out = JSON.parse(stdout.trim()) as {
        script_replacements?: AppliedScriptReplacement[]
        layerCount?: number
        gcodeSha256?: string
        stats?: { timeS?: number; filamentMm?: number[]; filamentG?: number[]; toolChanges?: number }
        warnings?: { code?: string; message?: string; layer?: number; objectId?: string }[]
        files?: { gcode?: string; preview?: string } & Record<string, unknown>
        featureFilaments?: { object?: string; name?: string; features?: Record<string, number[]> }[]
        chamberCooling?: { mode?: number; source?: string; filaments?: string[]; text?: string }
        projectPlates?: { plates?: number; sliced?: number }[]
      }
      const sum = (v: number[] | undefined): number => (v ?? []).reduce((a, b) => a + b, 0)
      if (job.scriptReplacements && (!Array.isArray(out.script_replacements) || out.script_replacements.length !== job.scriptReplacements.length || job.scriptReplacements.some((choice, i) => {
        const record = out.script_replacements?.[i]
        return !record || record.decision !== 'applied' || record.reason !== 'stock_replacement_applied' || record.key !== choice.key || record.slot !== (choice.slot ?? null) || record.original !== choice.original || record.replacement !== choice.replacement
      }))) throw new ToolInputError('The engine did not acknowledge every requested script replacement', 'engine_unavailable')
      const timeS = out.stats?.timeS ?? 0
      const plates = out.projectPlates?.[0]
      const files = out.files ?? {}
      const gcodePath = typeof files.gcode === 'string' ? files.gcode : join(job.outDir, 'slice.gcode')
      const previewPath = typeof files.preview === 'string' ? files.preview : join(job.outDir, 'slice.sxpv')
      const summary: SliceSummary = {
        ...(out.script_replacements ? { script_replacements: out.script_replacements } : {}),
        engine: 'sx',
        model: { name: job.plate ? `${objects.length} object${objects.length === 1 ? '' : 's'}` : basename(job.modelPath) },
        layer_count: out.layerCount ?? 0,
        time_s: Math.round(timeS),
        time_text: formatDuration(timeS),
        filament_g: Math.round(sum(out.stats?.filamentG) * 10) / 10,
        filament_mm: Math.round(sum(out.stats?.filamentMm)),
        filaments: (out.stats?.filamentMm ?? []).map((mm, i) => ({ slot: i + 1, filament_mm: Math.round(mm), filament_g: Math.round((out.stats?.filamentG?.[i] ?? 0) * 10) / 10 })),
        ...(out.stats?.toolChanges !== undefined ? { tool_changes: out.stats.toolChanges } : {}),
        ...(out.featureFilaments?.length ? { feature_filaments: featureFilaments(out.featureFilaments, objects) } : {}),
        ...(out.chamberCooling && typeof out.chamberCooling.mode === 'number' ? {
          chamber_cooling: {
            mode: out.chamberCooling.mode,
            source: out.chamberCooling.source === 'derived' ? 'derived' as const : 'config' as const,
            ...(out.chamberCooling.filaments?.length ? { filaments: out.chamberCooling.filaments.map(String) } : {}),
            text: String(out.chamberCooling.text ?? ''),
          },
        } : {}),
        ...(job.modelPlate && !job.plate ? { plate: job.modelPlate } : {}),
        // A project given without a plate: the engine sliced its first, and says when it has more.
        ...(!job.modelPlate && !job.plate && typeof plates?.sliced === 'number' && typeof plates.plates === 'number' ? { plate: plates.sliced, plate_count: plates.plates } : {}),
        ...(job.emitGcode && out.gcodeSha256 ? { gcode_sha256: out.gcodeSha256 } : {}),
        warnings: (out.warnings ?? []).map((w) => String(w.message ?? '')),
        // The code goes through as the engine wrote it, so a code this server does not know reaches the app.
        ...((out.warnings ?? []).some((w) => typeof w.code === 'string') ? { warning_details: (out.warnings ?? []).map((w) => ({ code: typeof w.code === 'string' ? w.code : 'unsupported_setting', message: String(w.message ?? ''), ...(typeof w.layer === 'number' ? { layer: w.layer } : {}), ...(typeof w.objectId === 'string' ? { object_id: w.objectId } : {}) })) } : {}),
        ...(job.emitGcode ? { gcode_path: gcodePath } : {}),
        ...(job.emitPreview ? { preview_path: previewPath } : {}),
      }
      // A slice with allow_collisions, or one with only close calls, lists them as a refusal does.
      const found = sxCollisions(out)
      if (found.length) summary.collisions = sliceCollisions(found, named, origin)
      return summary
    },
  }
}
