// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Typed client for the cloud slicing service (editions/slicerx/packages/cloud/service).
import { z } from 'zod'
import { sha256Hex } from './hash'
import { type CloudErrorCode, type CloudResult, fail, ok } from './result'
import {
  type AboutService,
  type CloudAccess,
  type BridgePrinter,
  type CloudDevice,
  type CloudJob,
  type Delivery,
  type DeliveryState,
  type DeviceKind,
  aboutService,
  bridgePrinter,
  cloudAccess,
  cloudDevice,
  cloudJob,
  delivery,
  errorBody,
  meshUpload,
} from './schemas'

export interface CloudClientOptions {
  /** Service origin, such as `http://127.0.0.1:8787`. */
  baseUrl: string
  /**
   * The bearer credential: the signed-in session's access token (app, mobile),
   * which may call everything, or an `sxk_` API token: `cloud_slice` for meshes
   * and jobs (MCP server, CLI), `link` for devices and deliveries (sx-link).
   * Called before every request so a refreshed session is picked up.
   */
  credential: () => string | null | Promise<string | null>
  fetch?: typeof globalThis.fetch
}

/**
 * A SliceRequest as the service takes it: the same shape as `sx slice
 * --request`, with each object's `mesh` set to the SHA-256 of an uploaded mesh.
 */
export interface CloudSliceRequest {
  schemaVersion?: 1
  plate: {
    bed?: { widthMm: number; depthMm: number; heightMm: number }
    objects: {
      id: string
      name?: string
      mesh: string
      transform?: number[]
      slotOverrides?: Record<string, number>
    }[]
  }
  config?: Record<string, unknown>
  options?: { engine?: 'sx'; flavor?: string; shards?: number; emitGcode?: boolean; emitPreview?: boolean }
}

export interface SubmitJobInput {
  name?: string
  request: CloudSliceRequest
  /** A printer from the user's synced printers that a bridge reaches. */
  targetPrinterId?: string
}

/** A plate with mesh bytes instead of hashes; `slicePlate` uploads what is missing. */
export interface PlateInput {
  name?: string
  meshes: Record<string, Uint8Array | ArrayBuffer>
  request: CloudSliceRequest
  targetPrinterId?: string
}

export interface WaitOptions {
  onUpdate?: (job: CloudJob) => void
  signal?: AbortSignal
  /** Poll interval, default 1000 ms. */
  intervalMs?: number
}

export interface LinkPrinterInput {
  localId: string
  name: string
  driver?: string
  model?: string
}

export interface CloudClient {
  /** The service's brand name, version and source link. Needs no credential. */
  about(): Promise<CloudResult<AboutService>>
  /**
   * Whether this account is invited to cloud slicing, its jobs per day, jobs in
   * the last 24 hours and largest upload. Ask before uploading, so the app can
   * explain a refusal; slicing routes answer `not_invited` otherwise.
   */
  access(): Promise<CloudResult<CloudAccess>>
  hasMesh(sha256: string): Promise<CloudResult<boolean>>
  /** Uploads a mesh unless the service already has it; returns its SHA-256. */
  uploadMesh(bytes: Uint8Array | ArrayBuffer): Promise<CloudResult<string>>
  submitJob(input: SubmitJobInput): Promise<CloudResult<CloudJob>>
  /** Uploads the plate's meshes, then submits it. Object `mesh` values are keys of `meshes`. */
  slicePlate(input: PlateInput): Promise<CloudResult<CloudJob>>
  job(id: string): Promise<CloudResult<CloudJob>>
  jobs(limit?: number): Promise<CloudResult<CloudJob[]>>
  cancelJob(id: string): Promise<CloudResult<CloudJob>>
  /** Polls until the job succeeds, fails or is canceled. */
  waitForJob(id: string, opts?: WaitOptions): Promise<CloudResult<CloudJob>>
  /** Downloads the G-code and checks it against the job's reported hash. */
  downloadGcode(job: CloudJob): Promise<CloudResult<Uint8Array>>
  downloadPreview(job: CloudJob): Promise<CloudResult<Uint8Array>>

  registerDevice(name: string, kind: DeviceKind): Promise<CloudResult<CloudDevice>>
  setDevicePrinters(deviceId: string, printers: LinkPrinterInput[]): Promise<CloudResult<BridgePrinter[]>>
  /** Open deliveries for a bridge. With `waitS`, the service holds the call until an offer arrives. */
  deliveries(deviceId: string, waitS?: number, signal?: AbortSignal): Promise<CloudResult<Delivery[]>>
  setDeliveryState(
    deviceId: string,
    deliveryId: string,
    state: Exclude<DeliveryState, 'offered' | 'expired' | 'canceled'>,
    message?: string,
  ): Promise<CloudResult<Delivery>>
  /** Downloads a delivery's G-code (needs the `link` scope) and checks its hash. */
  downloadDelivery(d: Delivery): Promise<CloudResult<Uint8Array>>
}

const KNOWN_CODES: readonly CloudErrorCode[] = [
  'unauthorized',
  'forbidden',
  'not_invited',
  'not_found',
  'bad_request',
  'conflict',
  'limit',
  'unavailable',
]

function codeForStatus(status: number): CloudErrorCode {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'limit'
  if (status === 400 || status === 422 || status === 413) return 'bad_request'
  return 'unavailable'
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })

export function createCloudClient(opts: CloudClientOptions): CloudClient {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis)

  async function send(
    method: string,
    path: string,
    init: { json?: unknown; body?: Uint8Array; signal?: AbortSignal | undefined } = {},
  ): Promise<CloudResult<Response>> {
    const credential = await opts.credential()
    if (!credential) return fail('unauthorized', 'sign in or add an API token with the cloud_slice scope')
    const headers: Record<string, string> = { authorization: `Bearer ${credential}` }
    let body: BodyInit | undefined
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(init.json)
    } else if (init.body) {
      headers['content-type'] = 'application/octet-stream'
      body = init.body as Uint8Array<ArrayBuffer>
    }
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        ...(init.signal ? { signal: init.signal } : {}),
      })
    } catch (e) {
      return fail('offline', e instanceof Error ? e.message : 'the cloud service could not be reached')
    }
    if (res.ok) return ok(res)
    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }
    const err = errorBody.safeParse(parsed)
    if (err.success) {
      const code = KNOWN_CODES.find((c) => c === err.data.error.code) ?? codeForStatus(res.status)
      return fail(code, err.data.error.message)
    }
    return fail(codeForStatus(res.status), `the cloud service answered ${res.status}`)
  }

  async function json<S extends z.ZodType>(
    schema: S,
    method: string,
    path: string,
    init?: Parameters<typeof send>[2],
  ): Promise<CloudResult<z.infer<S>>> {
    const res = await send(method, path, init)
    if (!res.ok) return res
    let raw: unknown
    try {
      raw = await res.value.json()
    } catch {
      return fail('invalid_response', 'the cloud service sent a body that is not JSON')
    }
    const parsed = schema.safeParse(raw)
    return parsed.success ? ok(parsed.data) : fail('invalid_response', parsed.error.message)
  }

  async function bytes(path: string, expectSha: string | null): Promise<CloudResult<Uint8Array>> {
    const res = await send('GET', path)
    if (!res.ok) return res
    let data: Uint8Array
    try {
      data = new Uint8Array(await res.value.arrayBuffer())
    } catch (e) {
      return fail('offline', e instanceof Error ? e.message : 'the download stopped')
    }
    if (expectSha !== null && (await sha256Hex(data)) !== expectSha) {
      return fail('hash_mismatch', 'the downloaded file does not match the hash the service reported')
    }
    return ok(data)
  }

  const client: CloudClient = {
    async about() {
      let res: Response
      try {
        res = await doFetch(`${base}/v1/about`)
      } catch (e) {
        return fail('offline', e instanceof Error ? e.message : 'the cloud service could not be reached')
      }
      if (!res.ok) return fail(codeForStatus(res.status), `the cloud service answered ${res.status}`)
      const parsed = aboutService.safeParse(await res.json().catch(() => null))
      return parsed.success ? ok(parsed.data) : fail('invalid_response', parsed.error.message)
    },

    access: () => json(cloudAccess, 'GET', '/v1/access'),

    async hasMesh(sha) {
      const res = await send('GET', `/v1/meshes/${sha}`)
      if (res.ok) return ok(true)
      return res.code === 'not_found' ? ok(false) : res
    },

    async uploadMesh(data) {
      const buf = data instanceof Uint8Array ? data : new Uint8Array(data)
      const sha = await sha256Hex(buf)
      const has = await client.hasMesh(sha)
      if (!has.ok) return has
      if (has.value) return ok(sha)
      const up = await json(meshUpload, 'PUT', `/v1/meshes/${sha}`, { body: buf })
      return up.ok ? ok(up.value.sha256) : up
    },

    submitJob: (input) => json(cloudJob, 'POST', '/v1/jobs', { json: input }),

    async slicePlate({ meshes, request, ...rest }) {
      const hashes: Record<string, string> = {}
      for (const [key, data] of Object.entries(meshes)) {
        const up = await client.uploadMesh(data)
        if (!up.ok) return up
        hashes[key] = up.value
      }
      const objects = []
      for (const o of request.plate.objects) {
        const sha = hashes[o.mesh]
        if (!sha) return fail('bad_request', `object ${o.id} names mesh ${o.mesh}, which is not in meshes`)
        objects.push({ ...o, mesh: sha })
      }
      return client.submitJob({ ...rest, request: { ...request, plate: { ...request.plate, objects } } })
    },

    job: (id) => json(cloudJob, 'GET', `/v1/jobs/${encodeURIComponent(id)}`),

    jobs: (limit = 20) => json(z.array(cloudJob), 'GET', `/v1/jobs?limit=${limit}`),

    cancelJob: (id) => json(cloudJob, 'POST', `/v1/jobs/${encodeURIComponent(id)}/cancel`),

    async waitForJob(id, w = {}) {
      const interval = w.intervalMs ?? 1000
      for (;;) {
        if (w.signal?.aborted) return fail('offline', 'waiting was canceled')
        const res = await client.job(id)
        if (!res.ok) return res
        w.onUpdate?.(res.value)
        if (!['queued', 'running'].includes(res.value.status)) return res
        await sleep(interval, w.signal)
      }
    },

    downloadGcode(job) {
      if (job.status !== 'succeeded' || !job.result) return Promise.resolve(fail('not_found', 'the job has no G-code yet'))
      return bytes(`/v1/jobs/${job.id}/gcode`, job.result.gcodeSha256 || null)
    },

    downloadPreview(job) {
      if (job.status !== 'succeeded') return Promise.resolve(fail('not_found', 'the job has no preview yet'))
      return bytes(`/v1/jobs/${job.id}/preview`, null)
    },

    registerDevice: (name, kind) => json(cloudDevice, 'POST', '/v1/devices', { json: { name, kind } }),

    setDevicePrinters: (deviceId, printers) =>
      json(z.array(bridgePrinter), 'PUT', `/v1/devices/${encodeURIComponent(deviceId)}/printers`, { json: printers }),

    deliveries: (deviceId, waitS, signal) =>
      json(z.array(delivery), 'GET', `/v1/devices/${encodeURIComponent(deviceId)}/deliveries${waitS ? `?wait=${waitS}` : ''}`, {
        signal,
      }),

    setDeliveryState: (deviceId, deliveryId, state, message) =>
      json(
        delivery,
        'POST',
        `/v1/devices/${encodeURIComponent(deviceId)}/deliveries/${encodeURIComponent(deliveryId)}/state`,
        { json: message === undefined ? { state } : { state, message } },
      ),

    downloadDelivery: (d) => bytes(d.gcodePath, d.sha256 || null),
  }
  return client
}
