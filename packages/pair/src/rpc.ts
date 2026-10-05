// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Requests, replies and events inside an encrypted session, and the schemas for each method.
import type { ApprovalRequest, Fleet, PrinterEvent, PrinterInfo, PrinterStatus, StartOptions } from '@slicerx/contracts'
import { z } from 'zod'
import { Id16, PublicIdentity, Rights, Sig64 } from './schema'
import type { SecureChannel } from './session'

const Name = z.string().min(1).max(200)
const PrinterId = z.string().min(1).max(128)
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/)

export const SLICE_WHERE = ['host', 'cloud', 'phone'] as const
export type SliceWhere = (typeof SLICE_WHERE)[number]
export const JOB_FILE_KINDS = ['gcode', 'gcode.3mf', 'bgcode'] as const
export const MODEL_KINDS = ['3mf', 'stl'] as const

export const SliceSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('library'), id: z.string().min(1).max(128), plate: z.number().int().min(0).max(999).optional() }),
  z.object({ kind: z.literal('blob'), blobId: Id16, plate: z.number().int().min(0).max(999).optional() }),
])
export type SliceSource = z.infer<typeof SliceSource>

/**
 * What the phone chose on its send screen: a material id and the Easy settings. The host checks
 * the values again against its own settings schema before slicing.
 */
export const SliceOptions = z.object({
  material: z.string().min(1).max(16).optional(),
  easy: z
    .object({
      detail: z.number().min(0).max(100),
      strength: z.number().min(0).max(100),
      speed: z.string().max(20),
      supports: z.string().max(20),
      brim: z.boolean(),
      smartLayer: z.string().max(20).optional(),
    })
    .optional(),
})
export type SliceOptions = z.infer<typeof SliceOptions>

export const StartOptionsSchema = z.object({
  plate: z.number().int().min(0).max(999).optional(),
  bedLeveling: z.boolean().optional(),
  flowCalibration: z.boolean().optional(),
  slotMap: z.record(z.string().regex(/^\d{1,3}$/), z.string().max(16)).optional(),
})

export const JobTarget = z.union([
  z.object({ printerIds: z.array(PrinterId).min(1).max(32) }),
  z.object({ fleetId: z.string().min(1).max(128) }),
])
export type JobTarget = z.infer<typeof JobTarget>

export const LibraryEntry = z.object({
  id: z.string().min(1).max(128),
  name: Name,
  kind: z.enum(['model', 'plate', 'project']),
  plates: z.array(z.object({ index: z.number().int().min(0), name: Name })).max(64).optional(),
  updatedAt: z.number().int().nonnegative().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
})
export type LibraryEntry = z.infer<typeof LibraryEntry>

export const SliceSummary = z.object({
  sliceId: Id16,
  name: Name,
  kind: z.enum(JOB_FILE_KINDS),
  sizeBytes: z.number().int().nonnegative(),
  sha256: Hex64,
  where: z.enum(SLICE_WHERE),
  printerId: PrinterId.optional(),
  timeS: z.number().nonnegative().optional(),
  grams: z.number().nonnegative().optional(),
  layers: z.number().int().nonnegative().optional(),
})
export type SliceSummary = z.infer<typeof SliceSummary>

/** `queued` and `started` carry `fileRef` for a later `jobs.start`; `done` ends a pause, resume or cancel. */
export const JOB_STATES = ['awaiting_approval', 'uploading', 'starting', 'queued', 'started', 'done', 'denied', 'expired', 'failed'] as const
export type JobState = (typeof JOB_STATES)[number]
export const JobUpdate = z.object({
  jobId: Id16,
  state: z.enum(JOB_STATES),
  printerId: PrinterId.optional(),
  message: z.string().max(500).optional(),
  /** The file as it now sits on the printer, for `jobs.start`. */
  fileRef: Id16.optional(),
  remoteName: Name.optional(),
})
export type JobUpdate = z.infer<typeof JobUpdate>

const ApprovalActionSchema = z.object({ action: z.string().max(40), target: z.string().max(128), paramsHash: Hex64 })
export const ApprovalRequestSchema = z.looseObject({
  id: z.string().min(1).max(128),
  sessionId: z.string().max(128),
  tool: z.string().max(128),
  permission: z.string().max(40),
  title: z.string().max(300),
  lines: z.array(z.string().max(300)).max(40),
  printerId: z.string().max(128).optional(),
  paramsHash: Hex64,
  actions: z.array(ApprovalActionSchema).max(64),
  expiresAt: z.string().max(40),
})

/**
 * The hub's own summary of agent work, sent next to the request (never inside it, so the hash the
 * phone signs covers the request unchanged). Its facts hash to the request's action parameter
 * hashes: print to `printer.upload` `{printerId, name, sha256}` and `printer.start`
 * `{printerId, name, opts, sha256}` (`opts` `{}` when absent); resume, pause and cancel to
 * `{printerId}`; gcode to `{printerId, line}`; adjust to `{printerId, change}`. A phone shows the
 * summary only when every hash matches, and offers no Approve when one does not. `sizeBytes` is the
 * hub's count of the bytes it holds; the hash binds the name and content hash.
 */
export const WorkSummary = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('print'),
    printerId: z.string().max(128),
    file: z.object({ name: z.string().max(255), sizeBytes: z.number().int().nonnegative(), sha256: Hex64 }),
    opts: z.looseObject({}).optional(),
  }),
  z.object({ kind: z.enum(['resume', 'pause', 'cancel']), printerId: z.string().max(128) }),
  // One command a card shows whole, the hub's own rule (`MAX_GCODE_LINE` in sx-connect).
  z.object({ kind: z.literal('gcode'), printerId: z.string().max(128), line: z.string().max(96).regex(/^[\x20-\x7e]+$/) }),
  z.object({ kind: z.literal('adjust'), printerId: z.string().max(128), change: z.unknown() }),
])
export type WorkSummary = z.infer<typeof WorkSummary>

/** An approval the phone may decide: Pilot's, the host's own, or one this phone's job raised. */
export const ApprovalView = z.object({
  request: ApprovalRequestSchema,
  source: z.enum(['pilot', 'pair', 'host']),
  /** Device name of the phone that asked, for requests from a paired phone. */
  requestedBy: z.string().max(64).optional(),
  /** The hub's checked work, for cards an agent raised (`WorkSummary`). */
  work: WorkSummary.optional(),
})
export interface ApprovalView {
  request: ApprovalRequest
  source: 'pilot' | 'pair' | 'host'
  requestedBy?: string
  work?: WorkSummary
}

/** The relay's numbers for the hub the phone reaches (sx-link `remote.status.quota`). */
export const RemoteQuota = z.looseObject({
  tier: z.enum(['account', 'anonymous']),
  /** Bytes this UTC month, sent plus received. */
  used: z.number().nonnegative(),
  cap: z.number().nonnegative(),
  /** Unix milliseconds. */
  resetsAt: z.number().nonnegative(),
  connections: z.number().int().nonnegative(),
  maxConnections: z.number().int().nonnegative(),
})
export type RemoteQuota = z.infer<typeof RemoteQuota>

export const HostInfo = z.object({
  identity: PublicIdentity,
  kind: z.enum(['desktop', 'web', 'link']),
  slicing: z.array(z.enum(SLICE_WHERE)),
  printers: z.boolean(),
  /** Live camera and stills through `camera.*`. Absent on hosts from before it existed. */
  camera: z.boolean().optional(),
  /** Push alerts through `push.register`. */
  push: z.boolean().optional(),
  rights: Rights,
  /** The STUN server (`host:port`) for direct video, run next to the relay. Use it, not a third party's. */
  stun: z.string().max(200).nullable().optional(),
})
export type HostInfo = z.infer<typeof HostInfo>

/** The decision a phone signs with its identity key. The hash covers the request exactly as shown. */
export const DecideParams = z.object({
  requestId: z.string().min(1).max(128),
  decision: z.enum(['approve', 'deny']),
  requestHash: Hex64,
  at: z.number().int().nonnegative(),
  /** The person said the build plate is clear, on a card that asked. Signed with the decision; absent means no. */
  bedClear: z.boolean().optional(),
  sig: Sig64,
})
export type DecideParams = z.infer<typeof DecideParams>

const CameraQuality = z.enum(['low', 'medium', 'high'])
export type CameraQuality = z.infer<typeof CameraQuality>
const StreamId = z.number().int().min(1).max(1_000_000)
/** Standard base64 (not base64url), so the phone can put it straight into a `data:` URI. */
const B64Std = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/)
/** Largest camera picture on the wire, as base64: about 512 KB of JPEG. */
export const MAX_FRAME_B64 = 700_000

/** Which alerts the phone wants pushed while the app is closed. */
export const PushPrefs = z.object({ printDone: z.boolean(), printFailed: z.boolean(), attention: z.boolean(), approvals: z.boolean() })
export type PushPrefs = z.infer<typeof PushPrefs>
/** An Expo push token, `ExponentPushToken[...]` or `ExpoPushToken[...]`. */
export const ExpoToken = z.string().regex(/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$/)

const Loose = z.looseObject({})
const Printer = z.looseObject({ id: PrinterId, name: z.string().max(200) })

/** Params and results per method. Params are parsed on the host, results on the phone. */
export const METHODS = {
  'host.info': { params: z.object({}), result: HostInfo },
  'printers.list': { params: z.object({}), result: z.array(Printer).max(500) },
  'fleets.list': { params: z.object({}), result: z.array(z.looseObject({ id: z.string().max(128), name: z.string().max(200), printerIds: z.array(z.string().max(128)).max(500) })).max(200) },
  'printers.status': { params: z.object({ printerId: PrinterId }), result: z.looseObject({ printerId: PrinterId, state: z.string().max(20) }) },
  'printers.watch': { params: z.object({ printerId: PrinterId }), result: z.object({ watchId: z.string().max(40) }) },
  'printers.unwatch': { params: z.object({ watchId: z.string().max(40) }), result: z.object({}) },
  'printers.snapshot': {
    params: z.object({ printerId: PrinterId }),
    result: z.object({ contentType: z.string().max(60), dataB64: z.string().max(700_000) }).nullable(),
  },
  /** Live camera: JPEG frames arrive as `camera.frame` events, `camera.stats` once a second, `camera.ended` at the end. */
  'camera.open': {
    params: z.object({ printerId: PrinterId, quality: z.enum(['low', 'medium', 'high', 'auto']).optional() }),
    result: z.object({ stream: StreamId, quality: CameraQuality }),
  },
  /**
   * Direct video over WebRTC, from a hub with remote access (sx-link). The phone sends a complete
   * offer (gathering finished, no trickle) with a receive-only video line and a data channel; the
   * answer carries the hub's candidates. H.264 cameras send RTP video, JPEG cameras send pictures on
   * the data channel. `camera.close` ends it; `camera.ended` arrives when it stops by itself.
   * Hosts without it answer `not_supported`; fall back to `camera.open`.
   */
  'camera.rtc': {
    params: z.object({ printerId: PrinterId, sdp: z.string().min(1).max(20_000) }),
    result: z.object({ stream: StreamId, sdp: z.string().min(1).max(20_000) }),
  },
  'camera.quality': { params: z.object({ stream: StreamId, quality: CameraQuality }), result: z.object({ quality: CameraQuality }) },
  'camera.close': { params: z.object({ stream: StreamId }), result: z.object({}) },
  /** One still: the printer's snapshot, else the first JPEG frame of its live video. Null without a camera. */
  'camera.grab': {
    params: z.object({ printerId: PrinterId }),
    result: z.object({ contentType: z.string().max(60), dataB64: B64Std.max(MAX_FRAME_B64), capturedAt: z.number().int().nonnegative(), source: z.enum(['snapshot', 'stream']) }).nullable(),
  },
  /** Registers this phone's Expo push token with the computer's hub, which sends alerts while the app is closed. */
  'push.register': { params: z.object({ token: ExpoToken, platform: z.enum(['ios', 'android']), prefs: PushPrefs }), result: z.object({}) },
  'push.unregister': { params: z.object({ token: ExpoToken }), result: z.object({}) },
  'library.list': { params: z.object({}), result: z.array(LibraryEntry).max(2000) },
  'slice.start': {
    params: z.object({ source: SliceSource, where: z.enum(['host', 'cloud']), printerId: PrinterId.optional(), options: SliceOptions.optional() }),
    result: z.object({ sliceId: Id16 }),
  },
  'slice.cancel': { params: z.object({ sliceId: Id16 }), result: z.object({}) },
  'upload.begin': {
    params: z.object({
      name: Name,
      kind: z.enum([...JOB_FILE_KINDS, ...MODEL_KINDS]),
      size: z.number().int().positive(),
      sha256: Hex64,
      stats: z.object({ timeS: z.number().nonnegative().optional(), grams: z.number().nonnegative().optional(), layers: z.number().int().nonnegative().optional() }).optional(),
      printerId: PrinterId.optional(),
    }),
    result: z.object({ uploadId: Id16, chunkBytes: z.number().int().positive() }),
  },
  'upload.chunk': {
    params: z.object({ uploadId: Id16, offset: z.number().int().nonnegative(), data: z.string().max(700_000) }),
    result: z.object({ received: z.number().int().nonnegative() }),
  },
  'upload.finish': {
    params: z.object({ uploadId: Id16 }),
    result: z.object({ blobId: Id16, slice: SliceSummary.optional() }),
  },
  'jobs.send': {
    params: z.object({ sliceId: Id16, target: JobTarget, start: z.boolean(), opts: StartOptionsSchema.optional() }),
    result: z.object({ jobId: Id16, requestId: z.string().max(128) }),
  },
  'jobs.start': {
    params: z.object({ fileRef: Id16, opts: StartOptionsSchema.optional() }),
    result: z.object({ jobId: Id16, requestId: z.string().max(128) }),
  },
  'jobs.control': {
    params: z.object({ printerId: PrinterId, action: z.enum(['pause', 'resume', 'cancel']) }),
    result: z.object({ jobId: Id16, requestId: z.string().max(128) }),
  },
  'approvals.list': { params: z.object({}), result: z.array(ApprovalView).max(200) },
  'approvals.decide': { params: DecideParams, result: z.object({}) },
  'pairing.revoke': { params: z.object({}), result: z.object({}) },
  /** The relay quota of the hub (sx-link over the relay); null from a host that is not on the relay. */
  'remote.quota': { params: z.object({}), result: RemoteQuota.nullable() },
} as const

export type Method = keyof typeof METHODS
export type ParamsOf<M extends Method> = z.input<(typeof METHODS)[M]['params']>

/** Results with the contract types where the schema only checks the outline. */
export interface ResultMap {
  'host.info': HostInfo
  'printers.list': PrinterInfo[]
  'fleets.list': Fleet[]
  'printers.status': PrinterStatus
  'printers.watch': { watchId: string }
  'printers.unwatch': Record<string, never>
  'printers.snapshot': { contentType: string; dataB64: string } | null
  'camera.open': { stream: number; quality: CameraQuality }
  'camera.rtc': { stream: number; sdp: string }
  'camera.quality': { quality: CameraQuality }
  'camera.close': Record<string, never>
  'camera.grab': { contentType: string; dataB64: string; capturedAt: number; source: 'snapshot' | 'stream' } | null
  'push.register': Record<string, never>
  'push.unregister': Record<string, never>
  'library.list': LibraryEntry[]
  'slice.start': { sliceId: string }
  'slice.cancel': Record<string, never>
  'upload.begin': { uploadId: string; chunkBytes: number }
  'upload.chunk': { received: number }
  'upload.finish': { blobId: string; slice?: SliceSummary }
  'jobs.send': { jobId: string; requestId: string }
  'jobs.start': { jobId: string; requestId: string }
  'jobs.control': { jobId: string; requestId: string }
  'approvals.list': ApprovalView[]
  'approvals.decide': Record<string, never>
  'pairing.revoke': Record<string, never>
  'remote.quota': RemoteQuota | null
}

export const EVENTS = {
  printer: z.object({ watchId: z.string().max(40), printerId: PrinterId, event: z.looseObject({ type: z.string().max(40) }) }),
  'slice.progress': z.object({ sliceId: Id16, stage: z.string().max(40), fraction: z.number().min(0).max(1) }),
  'slice.done': z.object({ slice: SliceSummary }),
  'slice.failed': z.object({ sliceId: Id16, message: z.string().max(500) }),
  job: JobUpdate,
  'approval.request': ApprovalView,
  'approval.resolved': z.object({ requestId: z.string().max(128), decision: z.enum(['approve', 'deny', 'expired']), by: z.string().max(64) }),
  'pairing.revoked': z.object({}),
  'pairing.rights': z.object({ rights: Rights }),
  /** The hub's relay quota changed (on connect and every five minutes). */
  'remote.quota': RemoteQuota,
  'camera.frame': z.object({ stream: StreamId, capturedAt: z.number().int().nonnegative(), key: z.boolean(), kind: z.literal('jpeg'), dataB64: B64Std.max(MAX_FRAME_B64) }),
  'camera.stats': z.object({ stream: StreamId, fps: z.number().nonnegative(), kbps: z.number().nonnegative(), dropped: z.number().int().nonnegative(), quality: CameraQuality }),
  /** `reason` `codec`: the camera sends H.264, which the phone cannot draw; use stills. */
  'camera.ended': z.object({ stream: StreamId, reason: z.enum(['ended', 'codec', 'closed']).optional() }),
} as const

export type EventName = keyof typeof EVENTS
export interface EventMap {
  printer: { watchId: string; printerId: string; event: PrinterEvent }
  'slice.progress': { sliceId: string; stage: string; fraction: number }
  'slice.done': { slice: SliceSummary }
  'slice.failed': { sliceId: string; message: string }
  job: JobUpdate
  'approval.request': ApprovalView
  'approval.resolved': { requestId: string; decision: 'approve' | 'deny' | 'expired'; by: string }
  'pairing.revoked': Record<string, never>
  'pairing.rights': { rights: Rights }
  'remote.quota': RemoteQuota
  'camera.frame': { stream: number; capturedAt: number; key: boolean; kind: 'jpeg'; dataB64: string }
  'camera.stats': { stream: number; fps: number; kbps: number; dropped: number; quality: CameraQuality }
  'camera.ended': { stream: number; reason?: 'ended' | 'codec' | 'closed' }
}

export const RPC_ERROR_CODES = ['bad_request', 'forbidden', 'not_found', 'not_supported', 'unavailable', 'busy', 'too_large', 'failed', 'timeout', 'closed'] as const
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number]

export class PairError extends Error {
  constructor(
    readonly code: RpcErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PairError'
  }
}

const Envelope = z.union([
  z.object({ t: z.literal('req'), id: z.number().int().nonnegative(), m: z.string().max(40), p: z.unknown() }),
  z.object({ t: z.literal('res'), id: z.number().int().nonnegative(), ok: z.literal(true), r: z.unknown() }),
  z.object({ t: z.literal('res'), id: z.number().int().nonnegative(), ok: z.literal(false), e: z.object({ code: z.enum(RPC_ERROR_CODES), message: z.string().max(500) }) }),
  z.object({ t: z.literal('ev'), ev: z.string().max(40), d: z.unknown() }),
])

export type Handler = (method: Method, params: unknown) => Promise<unknown>

export interface RpcPeer {
  call<M extends Method>(method: M, params: ParamsOf<M>, timeoutMs?: number): Promise<ResultMap[M]>
  emit<E extends EventName>(event: E, data: EventMap[E]): void
  onEvent(cb: <E extends EventName>(event: E, data: EventMap[E]) => void): () => void
  close(): void
}

/**
 * One side of the RPC. The host passes a handler; the phone passes none and only calls.
 * Incoming params and results are parsed against METHODS, events against EVENTS.
 */
export function createRpcPeer(channel: SecureChannel, handler?: Handler): RpcPeer {
  let nextId = 1
  const pending = new Map<number, { method: Method; resolve(v: unknown): void; reject(e: PairError): void; timer: ReturnType<typeof setTimeout> }>()
  const eventCbs = new Set<(event: EventName, data: unknown) => void>()

  channel.onMessage((raw) => {
    const env = Envelope.safeParse(raw)
    if (!env.success) return
    const msg = env.data
    if (msg.t === 'req') {
      if (!handler) return
      const spec = Object.hasOwn(METHODS, msg.m) ? METHODS[msg.m as Method] : undefined
      if (!spec) return channel.send({ t: 'res', id: msg.id, ok: false, e: { code: 'not_supported', message: `Unknown method ${msg.m.slice(0, 40)}` } })
      const parsed = spec.params.safeParse(msg.p)
      if (!parsed.success) return channel.send({ t: 'res', id: msg.id, ok: false, e: { code: 'bad_request', message: `Invalid parameters for ${msg.m}` } })
      handler(msg.m as Method, parsed.data).then(
        (r) => channel.send({ t: 'res', id: msg.id, ok: true, r: r === undefined ? {} : r }),
        (e: unknown) => {
          const err = e instanceof PairError ? e : new PairError('failed', 'The host could not complete the request')
          channel.send({ t: 'res', id: msg.id, ok: false, e: { code: err.code, message: err.message.slice(0, 500) } })
        },
      )
      return
    }
    if (msg.t === 'res') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (!msg.ok) return p.reject(new PairError(msg.e.code, msg.e.message))
      const r = METHODS[p.method].result.safeParse(msg.r)
      if (!r.success) return p.reject(new PairError('bad_request', `The host sent an invalid reply to ${p.method}`))
      return p.resolve(r.data)
    }
    const schema = Object.hasOwn(EVENTS, msg.ev) ? EVENTS[msg.ev as EventName] : undefined
    const d = schema?.safeParse(msg.d)
    if (!d?.success) return
    for (const cb of [...eventCbs]) cb(msg.ev as EventName, d.data)
  })

  channel.onClose(() => {
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new PairError('closed', 'The connection closed'))
    }
    pending.clear()
  })

  return {
    call(method, params, timeoutMs = 30_000) {
      if (channel.closed) return Promise.reject(new PairError('closed', 'The connection closed'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new PairError('timeout', `${method} timed out`))
        }, timeoutMs)
        pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer })
        channel.send({ t: 'req', id, m: method, p: params })
      })
    },
    emit(event, data) {
      channel.send({ t: 'ev', ev: event, d: data })
    },
    onEvent(cb) {
      const f = cb as (event: EventName, data: unknown) => void
      eventCbs.add(f)
      return () => eventCbs.delete(f)
    },
    close: () => channel.close(),
  }
}

export type { StartOptions }
