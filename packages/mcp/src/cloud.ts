// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Cloud slicing against the SlicerX cloud service API (the edition's
// packages/cloud README): upload the mesh or 3MF project by its SHA-256, queue
// a job (one slice per plate named), read jobs. Off unless an integrator names a cloud API; with none configured both
// tools answer that cloud slicing is not configured and touch no network.
// No job here names a printer, so nothing these tools do can start a print.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { MAX_CLOUD_PLATE_NUMBER } from '@slicerx/contracts'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { reportCollisions } from './collide'
import { resolveSliceConfig } from './config'
import { ignoredArgumentsMessage } from './ignored-arguments'
import type { DataStore } from './data'
import { resolveModel, ToolInputError, type PathPolicy } from './models'
import type { ProfileCatalog } from './profiles'
import { sxConfig } from './sx'

export interface CloudOptions {
  /** Base URL of the cloud API, such as https://cloud.example.com. */
  apiUrl: string
  /** An API token with the cloud_slice scope. Without it, the keychain item `keyRef` is read at call time. */
  token?: string | undefined
  /** Keychain item (account `slicerx`) holding the token; default `slicerx-cloud`. */
  keyRef?: string | undefined
  fetch?: typeof globalThis.fetch
}

export const CLOUD_NOT_CONFIGURED =
  'Cloud slicing is not configured on this server, so nothing was sent. An integrator enables it by running the SlicerX cloud service, turning on features.cloudSlicing with backend.cloudApi in the edition config (docs/integrating.md), and starting this server with --cloud-api <url> (or SLICERX_CLOUD_API_URL, or SLICERX_CONFIG naming the resolved edition config). The server then reads an API token with the cloud_slice scope from the keychain item slicerx-cloud, or from SLICERX_MCP_CLOUD_TOKEN. To slice on this machine, use slicerx_slice_file.'

/** A cloud API URL must be https, or http on this machine only. */
export function checkCloudUrl(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`cloud API: "${url}" is not a URL`)
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('cloud API: use https (http only for localhost)')
  return u.toString().replace(/\/+$/, '')
}

/**
 * Where the cloud API comes from: the flag, then SLICERX_MCP_CLOUD_API or
 * SLICERX_CLOUD_API_URL, then a resolved edition config (SLICERX_CONFIG) whose
 * features.cloudSlicing is on. Undefined means cloud slicing is off.
 */
export function cloudFromEnv(env: NodeJS.ProcessEnv, flagUrl?: string): CloudOptions | undefined {
  let url = flagUrl ?? env['SLICERX_MCP_CLOUD_API'] ?? env['SLICERX_CLOUD_API_URL']
  const configPath = env['SLICERX_CONFIG']
  if (!url && configPath && existsSync(configPath)) {
    const c = JSON.parse(readFileSync(configPath, 'utf8')) as { features?: { cloudSlicing?: unknown }; backend?: { cloudApi?: unknown } }
    if (c.features?.cloudSlicing === true && typeof c.backend?.cloudApi === 'string') url = c.backend.cloudApi
  }
  if (!url) return undefined
  return { apiUrl: checkCloudUrl(url), token: env['SLICERX_MCP_CLOUD_TOKEN'] || undefined, keyRef: env['SLICERX_MCP_CLOUD_KEY_REF'] || undefined }
}

function readCloudKey(ref: string): string {
  if (!/^slicerx-cloud(-[a-z0-9-]+)?$/.test(ref)) throw new ToolInputError(`${ref} is not a cloud credential name`, 'invalid_input')
  let out = ''
  try {
    const opts = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] }
    if (process.platform === 'darwin') out = execFileSync('security', ['find-generic-password', '-s', ref, '-a', 'slicerx', '-w'], opts)
    else if (process.platform === 'linux') out = execFileSync('secret-tool', ['lookup', 'service', ref, 'username', 'slicerx'], opts)
  } catch {
    out = ''
  }
  const key = out.trim()
  if (!key) throw new ToolInputError(`No cloud API token in the keychain under ${ref} (account slicerx). Create a token with the cloud_slice scope in your account and store it there, or set SLICERX_MCP_CLOUD_TOKEN.`, 'auth_failed')
  return key
}

interface CloudJob {
  id: string
  name?: string
  status: string
  progress?: number
  stage?: string | null
  result?: Record<string, unknown> | null
  error?: string | null
  createdAt?: string
  finishedAt?: string | null
  gcodeUrl?: string
  previewUrl?: string
  plateCount?: number | null
  plateIndex?: number | null
  plates?: { plate: number; gcodeUrl: string; previewUrl: string }[]
}

/** One plate's report in the result of a job that named its plates. */
interface PlateReport {
  plate: number
  status: 'succeeded' | 'failed'
  error?: string
  layerCount?: number
  stats?: { timeS?: number; filamentG?: number[] }
}

interface CloudAccess {
  invited: boolean
  jobsPerDay?: number
  jobsToday?: number
  maxUploadBytes?: number
  /** Set for a partner app token: the app's name the person issued it to. */
  partnerApp?: string
}

const AS_WRITTEN = 'This job was sliced before the cloud kept the plate its collisions are on, so they are as the engine wrote them (result.collisions, and engineCollisions for each plate): positions in machine coordinates, not plate mm, and objects by id only. Slice it again for named collisions on the plate.'

const NOT_INVITED = 'This account is not invited to cloud slicing. Ask the cloud operator to add it to the invite list, or slice on this machine with slicerx_slice_file.'
const EXPIRY_NOTE = 'G-code and preview links expire 7 days after the job finishes; download them before then.'
/** A size as people read it: bytes under 1 KB, KB under 0.1 MB, else MB with one decimal (MB of 1024 KB, as the limits count). */
function sizeText(n: number): string {
  if (n < 1024) return `${n} bytes`
  if (n < 104_858) return `${Math.round(n / 1024)} KB`
  return `${Math.round((n / 1_048_576) * 10) / 10} MB`
}
const gzipAsync = promisify(gzip)
const TOO_BIG = 'Simplify it or slice on this machine with slicerx_slice_file.'

export interface CloudToolDeps {
  cloud: CloudOptions | undefined
  store: DataStore
  profiles: ProfileCatalog
  policy: PathPolicy
}

const jobId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'a job id from slicerx_cloud_slice or slicerx_cloud_jobs')

export function cloudTools(deps: CloudToolDeps): PilotTool<never>[] {
  const need = (): CloudOptions => {
    if (!deps.cloud) throw new ToolInputError(CLOUD_NOT_CONFIGURED, 'not_configured')
    return deps.cloud
  }

  const request = async (c: CloudOptions, method: string, path: string, body?: { json?: unknown; bytes?: Buffer; gzip?: boolean; size?: string }): Promise<Response> => {
    const token = c.token ?? readCloudKey(c.keyRef ?? 'slicerx-cloud')
    const headers: Record<string, string> = { authorization: `Bearer ${token}` }
    let payload: string | Blob | undefined
    if (body?.json !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(body.json)
    } else if (body?.bytes) {
      headers['content-type'] = 'application/octet-stream'
      if (body.gzip) headers['content-encoding'] = 'gzip'
      payload = new Blob([new Uint8Array(body.bytes)])
    }
    let res: Response
    try {
      res = await (c.fetch ?? globalThis.fetch)(`${c.apiUrl}${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}), signal: AbortSignal.timeout(120_000) })
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      // A body far over the limit can be cut off before the service answers.
      if (body?.size) throw new ToolInputError(`The upload of the model, ${body.size}, was cut off before the cloud service answered (${why}); it may be over the cloud upload limit. ${TOO_BIG}`, 'service_error')
      throw new ToolInputError(`The cloud service at ${c.apiUrl} could not be reached: ${why}`, 'service_error')
    }
    if (res.ok || (method === 'GET' && res.status === 404 && path.startsWith('/v1/meshes/'))) return res
    const err = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    const code = err?.error?.code
    const why = err?.error?.message ?? `it answered ${res.status}`
    if (res.status === 403 && code === 'not_invited') throw new ToolInputError(NOT_INVITED, 'not_invited')
    if (res.status === 401)
      throw new ToolInputError(
        `The cloud service refused the token (${why}): it is unknown, expired or revoked. Ask the person for a new sxk_ token with the cloud_slice scope (a partner app token from their account settings, under Partner apps, works) and replace the stored one.`,
        'auth_failed',
      )
    if (res.status === 403) throw new ToolInputError(`The cloud service refused the request (${why}). It needs an sxk_ token with the cloud_slice scope.`, 'auth_failed')
    if (res.status === 413) {
      // The service says the size and the limit; a bare 413 says neither, so name the size here.
      const said = err?.error?.message ? why.replace(/[^.!?]$/, '$&.') : `The model is ${body?.size ?? 'too large'}, over the cloud upload limit.`
      throw new ToolInputError(`${said} ${TOO_BIG}`, 'quota_exceeded')
    }
    if (res.status === 429) {
      const after = res.headers.get('retry-after')
      if (method === 'POST' && path === '/v1/jobs' && !after) throw new ToolInputError(`This account has reached its cloud job limit (${why}). Jobs count over a rolling 24 hours; try later or slice on this machine with slicerx_slice_file.`, 'quota_exceeded')
      throw new ToolInputError(`The cloud service is rate limiting this token; try again in ${after ?? '60'} s.`, 'rate_limited')
    }
    throw new ToolInputError(`The cloud service did not accept the request: ${why}`, 'service_error')
  }

  /** Each plate of a job that named its plates: how it went, its time and filament, and its own downloads. */
  const plateList = (c: CloudOptions, j: CloudJob): Record<string, unknown>[] | undefined => {
    const reports = j.result?.['plates'] as PlateReport[] | undefined
    if (!reports) return undefined
    return reports.map((p) => {
      const links = j.plates?.find((l) => l.plate === p.plate)
      if (p.status !== 'succeeded') return { plate: p.plate, status: p.status, error: p.error }
      const collisions = reportCollisions(p)
      const raw = (p as { collisions?: unknown[] }).collisions
      return {
        plate: p.plate,
        status: p.status,
        layerCount: p.layerCount,
        timeS: p.stats?.timeS,
        grams: p.stats?.filamentG?.reduce((a, b) => a + b, 0),
        ...(collisions?.length ? { collisions } : collisions === null ? { engineCollisions: raw } : {}),
        ...(links ? { links: { gcode: absolute(c, links.gcodeUrl), preview: absolute(c, links.previewUrl) } } : {}),
      }
    })
  }

  const describe = (c: CloudOptions, j: CloudJob): Record<string, unknown> => {
    // The collisions go out as the slice tools give them (named, on the plate), so not again as the engine wrote them;
    // a result stored without the plate keeps them as written, in the machine's coordinates.
    const collisions = reportCollisions(j.result)
    const { plates: _plates, collisionPlate: _plate, ...kept } = j.result ?? {}
    const { collisions: _hits, ...placed } = kept
    const result = collisions === null ? kept : placed
    const plates = plateList(c, j)
    const asWritten = collisions === null || plates?.some((p) => 'engineCollisions' in p)
    return {
    id: j.id,
    name: j.name,
    status: j.status,
    progress: j.progress,
    stage: j.stage ?? undefined,
    ...(j.plateCount && j.plateCount > 1 ? { plateCount: j.plateCount } : {}),
    ...(j.plateIndex && j.status === 'running' ? { plateIndex: j.plateIndex } : {}),
    error: j.error ?? undefined,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt ?? undefined,
    result: j.result ? result : undefined,
    ...(collisions?.length ? { collisions } : {}),
    ...(asWritten ? { collisionsNote: AS_WRITTEN } : {}),
    ...(plates ? { plates } : {}),
    ...(j.status === 'succeeded'
      ? j.gcodeUrl || j.previewUrl
        ? { links: { ...(j.gcodeUrl ? { gcode: absolute(c, j.gcodeUrl) } : {}), ...(j.previewUrl ? { preview: absolute(c, j.previewUrl) } : {}) }, linksNote: EXPIRY_NOTE }
        : { linksNote: 'The files of this job have expired (results are kept for 7 days).' }
      : {}),
    }
  }
  const absolute = (c: CloudOptions, u: string): string => (/^https?:\/\//.test(u) ? u : `${c.apiUrl}${u.startsWith('/') ? '' : '/'}${u}`)

  const sliceInput = {
    model: z.string().min(1).describe('Absolute path to an STL or 3MF file, an http(s) URL, or a built-in test model such as sample:cube-20'),
    plates: z
      .array(z.number().int().min(1))
      .min(1)
      .max(32)
      .optional()
      .describe("3MF only: the plates to slice, plate numbers from 1 to 1000, each a slice of its own with its own result; only these are sliced, and each counts as one of the day's cloud slices. Default: the project's first plate"),
    profiles: z.array(z.string()).max(8).default([]).describe('Profiles applied in order, by id or name from slicerx_list_profiles'),
    overrides: z.record(z.string(), z.union([z.number(), z.boolean(), z.string(), z.array(z.unknown())])).optional().describe('Setting keys to values, applied last'),
    name: z.string().min(1).max(120).optional().describe('Job name shown in the job list; default the file name'),
    emit_preview: z.boolean().default(false).describe('Also make the toolpath preview'),
  }

  const slice = defineTool({
    name: 'cloud.slice',
    version: '1.2.0',
    source: 'command',
    permission: 'slice',
    description:
      "Slice a model or a whole 3MF project in the integrator's cloud instead of on this machine: checks the account is invited and within its daily slices and upload limit, uploads the file gzip compressed (only if the cloud does not have it yet; the upload limit counts the compressed size), queues one job with the settings (schema defaults, then each profile, then overrides) and returns the job id. A 3MF slices each plate named in plates as a slice of its own (each counts as one of the day's cloud slices), or its first plate without plates; each build item is an object of its own. Follow it with slicerx_cloud_jobs, which gives each plate's result and downloads. The job names no printer, so it never starts a print. Pick the printer, process and filament with profiles; an argument this tool does not take (printer, process) is ignored and named in an ignored_arguments warning. Answers that cloud slicing is not configured when this server has no cloud API.",
    // Loose for now: an argument the tool does not take is ignored with a warning (ignored_arguments), not refused.
    input: z.object(sliceInput).loose(),
    async run(i) {
      const c = need()
      const path = await resolveModel(deps.policy, i.model)
      const ext = extname(path).toLowerCase()
      if (ext !== '.stl' && ext !== '.3mf') throw new ToolInputError('model: cloud slicing takes STL and 3MF files', 'unsupported_format')
      if (i.plates && ext !== '.3mf') throw new ToolInputError('plates: only a 3MF project has plates', 'invalid_input')
      if (i.plates && new Set(i.plates).size !== i.plates.length) throw new ToolInputError('plates: name each plate once', 'invalid_input')
      if (i.plates?.some((n) => n > MAX_CLOUD_PLATE_NUMBER)) throw new ToolInputError(`plates: plate numbers go from 1 to ${MAX_CLOUD_PLATE_NUMBER}`, 'invalid_input')
      await deps.profiles.prepare(i.profiles)
      const { explicit, applied } = resolveSliceConfig(deps.store, deps.profiles, i.profiles, i.overrides)
      const bytes = readFileSync(path)
      const access = (await (await request(c, 'GET', '/v1/access')).json()) as CloudAccess
      if (!access.invited) throw new ToolInputError(NOT_INVITED, 'not_invited')
      if (access.jobsPerDay !== undefined && access.jobsToday !== undefined && access.jobsToday >= access.jobsPerDay)
        throw new ToolInputError(`This account has used all ${access.jobsPerDay} cloud jobs of the last 24 hours. Try later or slice on this machine with slicerx_slice_file.`, 'quota_exceeded')
      // Every plate counts as one of the day's cloud slices.
      const left = access.jobsPerDay !== undefined && access.jobsToday !== undefined ? access.jobsPerDay - access.jobsToday : undefined
      if (i.plates && left !== undefined && i.plates.length > left)
        throw new ToolInputError(`This job slices ${i.plates.length} plates, and this account can slice ${left} more ${left === 1 ? 'plate' : 'plates'} in the cloud today. Name fewer plates, try later or slice on this machine with slicerx_slice_file.`, 'quota_exceeded')
      // Sent gzip compressed when that is smaller; the limit reads the size as sent.
      const packed = await gzipAsync(bytes)
      const compressed = packed.length < bytes.length
      const body = compressed ? packed : bytes
      const size = compressed ? `${sizeText(bytes.length)} (${sizeText(packed.length)} compressed)` : sizeText(bytes.length)
      if (access.maxUploadBytes !== undefined && body.length > access.maxUploadBytes)
        throw new ToolInputError(`The model is ${size}, over this account's cloud upload limit of ${sizeText(access.maxUploadBytes)}. ${TOO_BIG}`, 'quota_exceeded')
      const sha = createHash('sha256').update(bytes).digest('hex')
      const has = await request(c, 'GET', `/v1/meshes/${sha}`)
      if (has.status === 404) await request(c, 'PUT', `/v1/meshes/${sha}`, { bytes: body, gzip: compressed, size })
      const name = i.name ?? basename(path)
      const job = (await (
        await request(c, 'POST', '/v1/jobs', {
          json: {
            name,
            request: {
              schemaVersion: 1,
              plate: { objects: [{ id: 'o0', name: basename(path), mesh: sha }] },
              config: sxConfig(explicit),
              options: { engine: 'sx', emitGcode: true, emitPreview: i.emit_preview, ...(i.plates ? { plates: i.plates } : {}) },
            },
          },
        })
      ).json()) as CloudJob
      // Arguments this tool does not take are left out of the job and named, as the local slice tools name them.
      const ignored = ignoredArgumentsMessage(i as Record<string, unknown>, Object.keys(sliceInput))
      const notes = ignored ? { warnings: [ignored], notices: [{ code: 'ignored_arguments' as const, message: ignored }] } : {}
      return { summary: `Queued cloud job ${job.id} (${job.status})${applied.length ? ` with ${applied.join(', ')}` : ''}${ignored ? `. ${ignored}` : ''}`, output: { jobId: job.id, ...describe(c, job), meshSha256: sha, uploaded: has.status === 404, ...notes } }
    },
  })

  const jobs = defineTool({
    name: 'cloud.jobs',
    version: '1.2.0',
    source: 'command',
    permission: 'read',
    description:
      'Cloud slicing jobs: with job_id, that job\'s status, progress, stage, result (time, filament) and, once it succeeded, the G-code and preview links (they need the same API token and expire 7 days after the job finishes); without it, the recent jobs, newest first. A job that named plates of a 3MF also gives the plate it is slicing while it runs, and plates: each plate\'s status, error, time, filament and its own links. A result with collisions lists them in collisions (for the job\'s own result) and in each plate\'s, as slicerx_slice_file does: the object printing by its id and name, what it meets, the part struck, layers from 1, and the place and region struck in plate mm. A job sliced before the cloud kept that plate has no collisions list: its collisions stay as the engine wrote them, in result.collisions and each plate\'s engineCollisions, in machine coordinates with objects by id, and collisionsNote says so. Answers that cloud slicing is not configured when this server has no cloud API.',
    input: z.object({ job_id: jobId.optional(), limit: z.number().int().min(1).max(100).default(20) }),
    async run(i) {
      const c = need()
      if (i.job_id) {
        const j = (await (await request(c, 'GET', `/v1/jobs/${i.job_id}`)).json()) as CloudJob
        return { summary: `Job ${j.id}: ${j.status}${j.progress !== undefined && j.status === 'running' ? `, ${Math.round(j.progress * 100)} percent` : ''}`, output: describe(c, j) }
      }
      const list = (await (await request(c, 'GET', `/v1/jobs?limit=${i.limit}`)).json()) as CloudJob[]
      return { summary: `${list.length} cloud job${list.length === 1 ? '' : 's'}`, output: { jobs: list.map((j) => describe(c, j)) } }
    },
  })

  const access = defineTool({
    name: 'cloud.access',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      "Read back what the cloud token this server holds may do, before slicing: whether the account is invited to cloud slicing, its cloud slices per rolling 24 hours, how many it used and has left, the largest upload, and, for a partner app token, the app's name the person issued it to. A partner app token slices on the person's own account and limits, sees only the jobs it queued, and cannot send a job to a printer. Sends nothing but the read. Answers that cloud slicing is not configured when this server has no cloud API.",
    input: z.object({}),
    async run() {
      const c = need()
      const a = (await (await request(c, 'GET', '/v1/access')).json()) as CloudAccess
      const left = a.jobsPerDay !== undefined && a.jobsToday !== undefined ? Math.max(0, a.jobsPerDay - a.jobsToday) : undefined
      const who = a.partnerApp ? `partner app token for ${a.partnerApp}` : 'account token'
      return {
        summary: a.invited ? `Cloud slicing: ${who}, ${left ?? 'unknown'} of ${a.jobsPerDay ?? 'unknown'} slices left today` : `Cloud slicing: ${who}, account not invited`,
        output: {
          invited: a.invited,
          ...(a.jobsPerDay !== undefined ? { slicesPerDay: a.jobsPerDay } : {}),
          ...(a.jobsToday !== undefined ? { slicesToday: a.jobsToday } : {}),
          ...(left !== undefined ? { slicesLeft: left } : {}),
          ...(a.maxUploadBytes !== undefined ? { maxUploadBytes: a.maxUploadBytes, maxUpload: sizeText(a.maxUploadBytes) } : {}),
          ...(a.partnerApp ? { partnerApp: a.partnerApp } : {}),
          jobsVisible: a.partnerApp ? 'own' : 'account',
          canSendToPrinter: false,
          ...(a.invited ? {} : { note: NOT_INVITED }),
        },
      }
    },
  })

  return [slice, jobs, access] as PilotTool<never>[]
}
