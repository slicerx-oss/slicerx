// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Resolves a model argument (a local path or an http(s) URL) to a local file
// inside the directories the server is allowed to read.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'

export const MODEL_EXTENSIONS = ['.stl', '.3mf', '.sx3mf', '.obj'] as const
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024

export interface PathPolicy {
  /** Directories model paths must be inside. Undefined means any path the server process can read. */
  allowDirs: string[] | undefined
  /** Where downloads and G-code go. Always writable by the server. */
  outDir: string
  allowUrls: boolean
  /** Folder with shipped sample files, for `sample:x-mark`. */
  samplesDir?: string
  fetch?: typeof fetch
}

/**
 * Stable codes for refused calls. They appear in the error text as `Error: <code>: <message>` and as
 * `structuredContent.error.code`, so an integrating app can branch on them without parsing prose.
 */
export const ERROR_CODES = [
  'invalid_input',
  'file_not_found',
  'path_not_allowed',
  'unsupported_format',
  'invalid_model',
  'no_such_plate',
  'download_failed',
  'urls_disabled',
  'unknown_profile',
  'invalid_settings',
  'engine_unavailable',
  'slice_failed',
  'preflight_blocked',
  'project_gcode_review',
  'sequence_clearance',
  'not_configured',
  'auth_failed',
  'not_invited',
  'quota_exceeded',
  'rate_limited',
  'service_error',
  'internal_error',
] as const
/** Locked-project refusals keep the format's own reason after `sxlock_`, such as `sxlock_wrong_account`. */
export type ErrorCode = (typeof ERROR_CODES)[number] | `sxlock_${string}`

export class ToolInputError extends Error {
  override readonly name = 'ToolInputError'
  readonly code: ErrorCode
  /** Structured facts for the integrating app, sent as `structuredContent.error.details`. */
  readonly details: Record<string, unknown> | undefined
  constructor(message: string, code: ErrorCode = 'invalid_input', details?: Record<string, unknown>) {
    super(message)
    this.code = code
    this.details = details
  }
}

function inside(dir: string, file: string): boolean {
  const rel = relative(dir, file)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function checkReadable(policy: PathPolicy, path: string): string {
  const abs = resolve(policy.allowDirs?.[0] ?? process.cwd(), path)
  if (!existsSync(abs)) throw new ToolInputError(`File not found: ${abs}. Pass an absolute path to an STL, 3MF or OBJ file.`, 'file_not_found')
  const real = realpathSync(abs)
  const allowed = [...(policy.allowDirs ?? []), policy.outDir].map((d) => (existsSync(d) ? realpathSync(d) : resolve(d)))
  if (policy.allowDirs !== undefined && !allowed.some((d) => inside(d, real))) {
    throw new ToolInputError(`${abs} is outside the directories this server may read (${policy.allowDirs.join(', ')}). Start the server with --allow-dir to add one.`, 'path_not_allowed')
  }
  if (!statSync(real).isFile()) throw new ToolInputError(`${abs} is not a file.`, 'file_not_found')
  return real
}

export function checkModelExtension(path: string): void {
  const ext = extname(path).toLowerCase()
  if (!(MODEL_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ToolInputError(`Unsupported model type "${ext || 'none'}". Use ${MODEL_EXTENSIONS.join(', ')}.`, 'unsupported_format')
  }
}

async function download(policy: PathPolicy, url: URL): Promise<string> {
  if (!policy.allowUrls) throw new ToolInputError('This server was started with --no-urls. Pass a local file path instead.', 'urls_disabled')
  const doFetch = policy.fetch ?? fetch
  const res = await doFetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) })
  if (!res.ok || !res.body) throw new ToolInputError(`Download failed: HTTP ${res.status} for ${url.href}`, 'download_failed')
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared > MAX_DOWNLOAD_BYTES) throw new ToolInputError(`The model at ${url.href} is ${declared} bytes; the limit is ${MAX_DOWNLOAD_BYTES}.`, 'download_failed')
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_DOWNLOAD_BYTES) {
      await reader.cancel()
      throw new ToolInputError(`The model at ${url.href} is over the ${MAX_DOWNLOAD_BYTES} byte limit.`, 'download_failed')
    }
    chunks.push(value)
  }
  const bytes = Buffer.concat(chunks)
  const name = basename(decodeURIComponent(url.pathname)) || 'model.stl'
  checkModelExtension(name)
  const dir = join(policy.outDir, 'downloads', createHash('sha256').update(bytes).digest('hex').slice(0, 16))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name.replace(/[^\w.\- ]+/g, '_'))
  writeFileSync(file, bytes)
  return file
}

/** Built-in test models, generated on demand: `sample:<name>`, sizes in mm. */
export const SAMPLE_MODELS: Record<string, [number, number, number]> = {
  'cube-20': [20, 20, 20],
  'tower-20x60': [20, 20, 60],
  'plate-60x40x3': [60, 40, 3],
}

/** A closed box as a binary STL, 12 triangles. */
function boxStl([x, y, z]: [number, number, number]): Buffer {
  const v = (i: number): [number, number, number] => [i & 1 ? x : 0, i & 2 ? y : 0, i & 4 ? z : 0]
  const faces = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]
  const buf = Buffer.alloc(84 + faces.length * 50)
  buf.writeUInt32LE(faces.length, 80)
  faces.forEach((f, t) => f.forEach((vi, k) => v(vi).forEach((c, j) => buf.writeFloatLE(c, 84 + t * 50 + 12 + k * 12 + j * 4))))
  return buf
}

/**
 * Samples that ship as files: `sample:x-mark` is the SlicerX X mark, the exact-faced showcase version
 * (packages/core/bench/models/x-mark-showcase.sx3mf, modeled with the app's CAD tools). The benchmarks keep their own x-mark.stl.
 */
export const SAMPLE_FILES: Record<string, string> = { 'x-mark': 'x-mark-showcase.stl' }

function sampleModel(policy: PathPolicy, name: string): string {
  const shipped = SAMPLE_FILES[name]
  if (shipped) {
    const file = policy.samplesDir ? join(policy.samplesDir, shipped) : undefined
    if (!file || !existsSync(file)) throw new ToolInputError(`The sample "${name}" is not installed with this server (looked for ${shipped} in the data directory).`, 'file_not_found')
    return file
  }
  const size = SAMPLE_MODELS[name]
  if (!size) throw new ToolInputError(`No sample model "${name}". Samples: ${[...Object.keys(SAMPLE_MODELS), ...Object.keys(SAMPLE_FILES)].map((n) => `sample:${n}`).join(', ')}.`)
  const dir = join(policy.outDir, 'samples')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.stl`)
  if (!existsSync(file)) writeFileSync(file, boxStl(size))
  return file
}

/** Returns a readable local path for a model given as a path, an http(s) URL, or `sample:<name>`. */
export async function resolveModel(policy: PathPolicy, model: string): Promise<string> {
  if (model.startsWith('sample:')) return sampleModel(policy, model.slice('sample:'.length))
  let url: URL | undefined
  if (/^https?:\/\//i.test(model)) url = new URL(model)
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(model)) throw new ToolInputError('Only http and https URLs are supported for models.', 'unsupported_format')
  const file = url ? await download(policy, url) : checkReadable(policy, model)
  checkModelExtension(file)
  return file
}
