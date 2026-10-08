// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The host side, run by the desktop app and the browser app. It shows pairing offers, answers
// paired phones over the LAN and the relay, and turns their print requests into approval
// requests. Nothing a phone sends reaches a printer until a person approves it, on the host's
// own approval card or on an approver phone, and the approval broker mints the token.
import type { ApprovalAction, ApprovalDecision, ApprovalHost, ApprovalRequest, JobFile, PermissionClass, PrinterHost, RemoteFile, StartOptions } from '@slicerx/contracts'
import { grantApproval, hashParams } from '@slicerx/contracts/pilot'
import { fromB64url, toArrayBuffer, toB64, toB64url, toHex } from './bytes'
import { createCameraRelay, type CameraRelay, type PairCameraSource } from './camera-relay'
import { defaultEnv, sha256, sha256Stream, type PairEnv } from './crypto'
import { verifyDecision } from './approval'
import { watchAccountJoins, type JoinRequest } from './account'
import { checkGrant, grantHash, introducedDeviceKey, introducedPairingId } from './grant'
import { offererOnHello, offerOverPipe, createOffererState, type HandshakeKeys, type OfferResult } from './handshake'
import { ALL_RIGHTS, type DeviceIdentity, type PairingRecord, type PairingStore } from './identity'
import { createShortCode, introRoute, offerFromShortCode, offerLink, offerRoutes, OFFER_TTL_MS, pairingRoutes } from './offer'
import { createRpcPeer, MAX_FRAME_B64, PairError, type ApprovalView, type PushPrefs, type JobState, type DecideParams, type JobTarget, type LibraryEntry, type Method, type RpcPeer, type SliceOptions, type SliceSource, type SliceSummary } from './rpc'
import { parseFrame, type DevicePlatform, type Endpoints, type FrameOf, type JoinerConfirm, type PublicIdentity, type Rights } from './schema'
import { acceptSession, initCurrent, verifyInit, type HostChannel } from './session'
import { relayPipe, type Pipe, type RelayConnection } from './transport'

/** A finished slice the host can send to a printer. */
export interface SlicedFile {
  name: string
  kind: JobFile['kind']
  data: ArrayBuffer
  timeS?: number
  grams?: number
  layers?: number
}

/** Slicing on the host or in the cloud, supplied by the app. */
export interface PairSlicer {
  slice(
    req: { source: SliceSource; printerId?: string; blob?: { name: string; kind: string; data: ArrayBuffer }; options?: SliceOptions },
    onProgress: (stage: string, fraction: number) => void,
    signal: AbortSignal,
  ): Promise<SlicedFile>
}

/**
 * Approvals raised elsewhere in the app, such as by mimir, that approver phones may decide.
 * `decide` must do exactly what a click on the host's own approval card does.
 */
export interface ApprovalFeed {
  pending(): ApprovalRequest[]
  onRequest(cb: (r: ApprovalRequest) => void): () => void
  onResolved(cb: (requestId: string, decision: 'approve' | 'deny' | 'expired') => void): () => void
  decide(requestId: string, decision: ApprovalDecision, by: { deviceId: string; name: string }): Promise<void>
}

export interface HostServices {
  printers?: PrinterHost
  /** The approval broker. `grant` is called only after a person approved. */
  approvals?: ApprovalHost
  slicer?: PairSlicer
  cloudSlicer?: PairSlicer
  library?: { list(): Promise<LibraryEntry[]> }
  approvalFeed?: ApprovalFeed
  /** Live camera and single stills for phones. `LinkHost.camera` from @slicerx/link-client fits. */
  camera?: PairCameraSource
  /** The hub's push registrations (sx-link `push.*`). `LinkHost.push` from @slicerx/link-client fits. */
  push?: PairPushHub
}

/** Where phones' push tokens go: the hub that sends alerts while the app is closed. */
export interface PairPushHub {
  /** `tag` is the pairing id, so revoking the pairing removes the phone's token. */
  register(reg: { token: string; platform: 'ios' | 'android'; prefs: PushPrefs; tag?: string }): Promise<void>
  unregister(by: { token?: string; tag?: string }): Promise<unknown>
}

export interface HostLimits {
  maxUploadBytes: number
  chunkBytes: number
  maxSessions: number
  sessionsPerPairing: number
  watchesPerSession: number
  cameraStreamsPerSession: number
  slicesPerPairing: number
  pendingJobsPerPairing: number
  printersPerJob: number
  approvalTtlMs: number
}

export const DEFAULT_LIMITS: HostLimits = {
  maxUploadBytes: 256 * 1024 * 1024,
  chunkBytes: 384 * 1024,
  maxSessions: 64,
  sessionsPerPairing: 4,
  watchesPerSession: 16,
  cameraStreamsPerSession: 2,
  slicesPerPairing: 8,
  pendingJobsPerPairing: 4,
  printersPerJob: 32,
  approvalTtlMs: 5 * 60 * 1000,
}

export interface PairHostOptions {
  env?: PairEnv
  identity: DeviceIdentity
  store: PairingStore
  kind: 'desktop' | 'web' | 'link'
  services: HostServices
  /** The signed-in account, when there is one. */
  accountId?: string | null
  /** LAN URLs and the relay, advertised in QR codes and pairings. */
  endpoints?: Endpoints
  /** Prefix of QR links. Default `slicerx://pair`. */
  linkBase?: string
  /** Whether trusted devices may introduce new devices of the same account. Default allow. */
  introductions?: 'allow' | 'off'
  limits?: Partial<HostLimits>
}

export interface PairedDevice {
  pairingId: string
  deviceId: string
  name: string
  platform: DevicePlatform
  rights: Rights
  createdAt: number
  lastSeenAt?: number
  accountLinked: boolean
  introducedBy?: string
  online: boolean
}

export type HostPairingResult = { ok: true; device: PairedDevice } | { ok: false; reason: string }

export interface HostPairingAttempt {
  deviceName: string
  platform?: DevicePlatform
  sas: Promise<string>
  /** The person saw matching digits. Rights default to request and approve, plus introduce when the account is linked. */
  confirm(rights?: Rights): void
  reject(): void
  result: Promise<HostPairingResult>
}

export interface HostOffer {
  /** Encode as a QR code. */
  link: string
  /** For typing, shown as XXXX-XXXX-XXXX. Works through the relay. */
  code: string
  expiresAt: number
  onAttempt(cb: (a: HostPairingAttempt) => void): () => void
  cancel(): void
}

export interface ApprovalAudit {
  requestId: string
  deviceId: string
  deviceName: string
  decision: 'approve' | 'deny'
  at: number
  requestHash: string
  sig: string
}

export interface PairHost {
  readonly identity: PublicIdentity
  createOffer(opts?: { ttlMs?: number }): HostOffer
  /** A LAN connection (from sx-link or the desktop app's listener). */
  handlePipe(pipe: Pipe): void
  /** Serves offers, pairings and introductions through the relay. Returns a detach function. */
  attachRelay(relay: RelayConnection): () => void
  /** Account join requests this host may approve itself. Needs an account relay connection. */
  watchJoinRequests(relay: RelayConnection, onRequest: (r: HostJoinRequest) => void): () => void
  devices(): Promise<PairedDevice[]>
  revoke(pairingId: string): Promise<void>
  setRights(pairingId: string, rights: Rights): Promise<void>
  setAccount(accountId: string | null): void
  /** Where phones reach this host, used by new offers and pairings. Set it once the LAN listener has a port. */
  setEndpoints(endpoints: Endpoints): void
  /** Revocations from the account's device list. Revoking is always safe to honor. */
  revokeAccountDevices(deviceIds: string[]): Promise<void>
  onDevicesChanged(cb: () => void): () => void
  /** Approvals raised by phone jobs, for the host's own approval card. */
  readonly jobApprovals: {
    pending(): ApprovalView[]
    decide(requestId: string, decision: ApprovalDecision): Promise<void>
    onRequest(cb: (v: ApprovalView) => void): () => void
    onResolved(cb: (requestId: string, decision: 'approve' | 'deny' | 'expired') => void): () => void
  }
  audit(): ApprovalAudit[]
  close(): void
}

export interface HostJoinRequest {
  requestId: string
  name: string
  platform: DevicePlatform
  review(): HostPairingAttempt | null
}

interface Session {
  pairingId: string
  channel: HostChannel
  rpc: RpcPeer
  pipe: Pipe
  watches: Map<string, () => void>
  /** Live camera streams, opened on first use. */
  camera?: CameraRelay
  openedAt: number
  confirmed: boolean
}

interface SliceEntry {
  pairingId: string
  file: SlicedFile
  sha256: string
  summary: SliceSummary
}

interface Upload {
  pairingId: string
  name: string
  kind: string
  size: number
  sha256: string
  buf: Uint8Array
  received: number
  hasher: ReturnType<typeof sha256Stream>
  stats?: { timeS?: number; grams?: number; layers?: number }
  printerId?: string
}

type JobWork =
  | { kind: 'print'; printerIds: string[]; slice: SliceEntry; start: boolean; opts: StartOptions }
  | { kind: 'start'; fileRef: string; remote: RemoteFile; opts: StartOptions }
  | { kind: 'control'; printerId: string; action: 'pause' | 'resume' | 'cancel' }

interface Job {
  jobId: string
  pairingId: string
  request: ApprovalRequest
  work: JobWork
  state: 'pending' | 'running' | 'done'
  timer: ReturnType<typeof setTimeout>
}

const MODEL_KINDS = new Set(['3mf', 'stl'])

export async function createPairHost(o: PairHostOptions): Promise<PairHost> {
  const env = o.env ?? defaultEnv
  const limits: HostLimits = { ...DEFAULT_LIMITS, ...o.limits }
  const me = o.identity
  const svc = o.services
  let accountId = o.accountId ?? null
  let endpoints: Endpoints = o.endpoints ?? { lan: [] }

  const records = new Map<string, PairingRecord>()
  const byRoute = new Map<string, string>()
  const keys = new Map<string, Uint8Array>()
  const revokedGrants = new Set(await o.store.revokedGrants())
  for (const r of await o.store.list()) index(r)

  const sessions = new Map<string, Session>()
  const relays = new Set<{ relay: RelayConnection; routes: Map<string, () => void> }>()
  const offers = new Map<string, { st: ReturnType<typeof createOffererState>; group: OfferGroup }>()
  const slices = new Map<string, SliceEntry>()
  const blobs = new Map<string, { pairingId: string; name: string; kind: string; data: ArrayBuffer }>()
  const uploads = new Map<string, Upload>()
  const jobs = new Map<string, Job>()
  /** Files this host put on printers for a phone, so the phone can start them later. */
  const remoteFiles = new Map<string, { pairingId: string; remote: RemoteFile }>()
  const running = new Map<string, { pairingId: string; ctrl: AbortController }>()
  const auditLog: ApprovalAudit[] = []
  const changed = new Set<() => void>()
  const jobRequestCbs = new Set<(v: ApprovalView) => void>()
  const jobResolvedCbs = new Set<(id: string, d: 'approve' | 'deny' | 'expired') => void>()
  const feedOffs: (() => void)[] = []

  interface OfferGroup {
    consumed: boolean
    canceled: boolean
    attemptCbs: Set<(a: HostPairingAttempt) => void>
    relayPipes: Pipe[]
  }

  function index(r: PairingRecord): void {
    const k = fromB64url(r.deviceKey)
    if (!k) return
    records.set(r.pairingId, r)
    keys.set(r.pairingId, k)
    byRoute.set(pairingRoutes(k).host, r.pairingId)
  }

  function unindex(pairingId: string): void {
    const k = keys.get(pairingId)
    if (k) byRoute.delete(pairingRoutes(k).host)
    records.delete(pairingId)
    keys.delete(pairingId)
  }

  const notifyChanged = () => {
    for (const cb of [...changed]) cb()
  }

  const view = (r: PairingRecord): PairedDevice => ({
    pairingId: r.pairingId,
    deviceId: r.peer.deviceId,
    name: r.peer.name,
    platform: r.peer.platform,
    rights: r.rights,
    createdAt: r.createdAt,
    ...(r.lastSeenAt !== undefined ? { lastSeenAt: r.lastSeenAt } : {}),
    accountLinked: accountId !== null && r.accountId === accountId,
    ...(r.introducedBy ? { introducedBy: [...records.values()].find((x) => x.peer.deviceId === r.introducedBy)?.peer.name ?? 'another device' } : {}),
    online: [...sessions.values()].some((s) => s.pairingId === r.pairingId && s.confirmed),
  })

  function sessionsOf(pairingId: string): Session[] {
    return [...sessions.values()].filter((s) => s.pairingId === pairingId && s.confirmed)
  }

  function approverSessions(): Session[] {
    return [...sessions.values()].filter((s) => s.confirmed && records.get(s.pairingId)?.rights.approve)
  }

  function closeSession(sid: string): void {
    const s = sessions.get(sid)
    if (!s) return
    sessions.delete(sid)
    for (const off of s.watches.values()) off()
    s.camera?.closeAll()
    s.channel.close()
  }

  async function savePairing(r: PairingRecord): Promise<void> {
    await o.store.put(r)
    index(r)
    for (const rel of relays) subscribePairing(rel, r.pairingId)
    notifyChanged()
  }

  // -------------------------------------------------------------------------
  // Offers

  function defaultRights(): Rights {
    return { request: true, approve: true, introduce: accountId !== null }
  }

  async function completePairing(res: OfferResult, rights: Rights): Promise<HostPairingResult> {
    if (!res.ok) return { ok: false, reason: res.reason }
    const r: PairingRecord = {
      pairingId: res.keys.pairingId,
      peer: res.joiner.identity,
      deviceKey: toB64url(res.keys.deviceKey),
      rights,
      createdAt: env.now(),
      ...(accountId && res.joiner.accountId === accountId ? { accountId } : {}),
    }
    await savePairing(r)
    return { ok: true, device: view(r) }
  }

  function hostAttempt(pipe: Pipe, hello: FrameOf<'hello'>, st: ReturnType<typeof createOffererState>): HostPairingAttempt | null {
    const r = offererOnHello(env, st, hello)
    if (!r.ok) {
      pipe.send(JSON.stringify({ k: 'abort', o: hello.o, reason: r.reason }))
      return null
    }
    let rights = defaultRights()
    const attempt = offerOverPipe(pipe, r.ctx, r.challenge, {
      identity: me,
      buildConfirm: async (_j: JoinerConfirm, _k: HandshakeKeys) => ({
        rights,
        endpoints,
        ...(accountId ? { accountId } : {}),
      }),
    })
    return {
      deviceName: attempt.joinerName ?? 'Phone',
      ...(attempt.joinerPlatform ? { platform: attempt.joinerPlatform } : {}),
      sas: attempt.sas,
      confirm(chosen) {
        if (chosen) rights = chosen
        attempt.confirm()
      },
      reject: () => attempt.reject('mismatch'),
      result: attempt.result.then((res) => completePairing(res, rights)),
    }
  }

  function onHello(pipe: Pipe, hello: FrameOf<'hello'>): void {
    const entry = offers.get(hello.o)
    if (!entry || entry.group.canceled) {
      pipe.send(JSON.stringify({ k: 'abort', o: hello.o, reason: 'expired' }))
      return
    }
    const { st, group } = entry
    if (group.consumed) st.consumed = true
    const attempt = hostAttempt(pipe, hello, st)
    if (!attempt) {
      if (st.failures >= 5) cancelGroup(group)
      return
    }
    group.consumed = true
    for (const other of offers.values()) if (other.group === group) other.st.consumed = true
    for (const cb of [...group.attemptCbs]) cb(attempt)
    void attempt.result.finally(() => cancelGroup(group))
  }

  function cancelGroup(group: OfferGroup): void {
    group.canceled = true
    for (const [id, e] of offers) if (e.group === group) offers.delete(id)
    for (const p of group.relayPipes) p.close()
  }

  function listenOffer(rel: { relay: RelayConnection }, offerId: Uint8Array, group: OfferGroup): void {
    const routes = offerRoutes(offerId)
    const pipe = relayPipe(rel.relay, routes.offerer, routes.joiner)
    group.relayPipes.push(pipe)
    pipe.onFrame((text) => {
      const f = parseFrame(text)
      if (f?.k === 'hello') onHello(pipe, f)
    })
  }

  // -------------------------------------------------------------------------
  // Frames from LAN pipes and relay routes

  function onFrame(pipe: Pipe, text: string, introRelay?: RelayConnection): void {
    const f = parseFrame(text)
    if (!f) return
    if (f.k === 'hello') return onHello(pipe, f)
    if (f.k === 'init') return void onInit(pipe, f, introRelay)
    if (f.k === 'data') {
      const s = sessions.get(f.s)
      if (!s || s.pipe !== pipe) return
      s.channel.deliver(f)
    }
  }

  async function onInit(pipe: Pipe, init: FrameOf<'init'>, introRelay?: RelayConnection): Promise<void> {
    if (sessions.has(init.s)) return
    let pairingId = byRoute.get(init.r)
    let deviceKey = pairingId ? keys.get(pairingId) : undefined
    let reply = (f: string) => pipe.send(f)

    if (!pairingId && init.g && init.r === introRoute(fromB64url(me.public.signPub) ?? new Uint8Array()) && o.introductions !== 'off') {
      const g = init.g
      const check = checkGrant(env, g, { identity: me.public, accountId, pairings: [...records.values()], revokedGrants })
      const k = check.ok ? introducedDeviceKey(me.dhSecret, g.subject.dhPub, g) : null
      if (!check.ok || !k || !verifyInit(init, k)) return
      pairingId = introducedPairingId(g)
      deviceKey = k
      if (!records.has(pairingId)) {
        await savePairing({
          pairingId,
          peer: g.subject,
          deviceKey: toB64url(k),
          rights: check.rights,
          createdAt: env.now(),
          accountId: g.accountId,
          introducedBy: g.issuer.deviceId,
          grantId: g.grantId,
        })
      }
      if (introRelay) {
        const route = pairingRoutes(k).device
        reply = (f) => introRelay.send(route, f)
      }
    }
    const refuse = (reason: 'unknown' | 'busy' | 'update') => {
      if (!introRelay) pipe.send(JSON.stringify({ k: 'refuse', s: init.s, reason }))
    }
    if (!pairingId || !deviceKey) return refuse('unknown')
    if (!verifyInit(init, deviceKey)) return
    // An older phone: tell it to update rather than run the old key schedule.
    if (!initCurrent(init)) return refuse('update')
    if (sessions.size >= limits.maxSessions) return refuse('busy')
    const pid = pairingId
    const channel = acceptSession(env, init, deviceKey, me.dhSecret, reply, () => closeSession(init.s))
    if (!channel) return
    const session: Session = { pairingId: pid, channel, pipe, watches: new Map(), openedAt: env.now(), confirmed: false, rpc: undefined as unknown as RpcPeer }
    session.rpc = createRpcPeer(channel, (m, p) => handle(session, m, p))
    // The first message that decrypts proves the device holds the session keys.
    const off = channel.onMessage(() => {
      off()
      session.confirmed = true
      const rec = records.get(pid)
      if (rec) {
        const seen = { ...rec, lastSeenAt: env.now() }
        records.set(pid, seen)
        void o.store.put(seen)
      }
      const older = [...sessions.values()].filter((s) => s.pairingId === pid && s !== session).sort((a, b) => a.openedAt - b.openedAt)
      while (older.length >= limits.sessionsPerPairing) {
        const oldest = older.shift()
        if (oldest) closeSession(oldest.channel.sid)
      }
      notifyChanged()
    })
    sessions.set(init.s, session)
  }

  function subscribePairing(rel: { relay: RelayConnection; routes: Map<string, () => void> }, pairingId: string): void {
    const k = keys.get(pairingId)
    if (!k || rel.routes.has(pairingId)) return
    const routes = pairingRoutes(k)
    const pipe = relayPipe(rel.relay, routes.host, routes.device)
    pipe.onFrame((t) => onFrame(pipe, t))
    rel.routes.set(pairingId, () => pipe.close())
  }

  // -------------------------------------------------------------------------
  // Requests from phones

  function need(s: Session, right: keyof Rights): PairingRecord {
    const rec = records.get(s.pairingId)
    if (!rec) throw new PairError('forbidden', 'This device is no longer paired')
    if (!rec.rights[right]) throw new PairError('forbidden', `This device may not ${right === 'request' ? 'send jobs' : right === 'approve' ? 'approve' : 'introduce devices'}`)
    return rec
  }

  function printers(): PrinterHost {
    if (!svc.printers) throw new PairError('not_supported', 'This host has no printers')
    return svc.printers
  }

  /** One still for a phone: the camera source's grab, else the printer's snapshot. */
  async function grabStill(printerId: string): Promise<{ contentType: string; dataB64: string; capturedAt: number; source: 'snapshot' | 'stream' } | null> {
    if (svc.camera?.grab) {
      let still: Awaited<ReturnType<NonNullable<PairCameraSource['grab']>>>
      try {
        still = await svc.camera.grab(printerId)
      } catch (e) {
        const code = (e as { code?: string }).code
        throw new PairError(code === 'not_found' ? 'not_found' : code === 'not_supported' ? 'not_supported' : 'unavailable', code === 'not_supported' ? 'This camera gives no still pictures' : 'The camera did not answer')
      }
      if (!still) return null
      const dataB64 = toB64(still.data)
      if (dataB64.length > MAX_FRAME_B64) throw new PairError('too_large', 'The picture is too large to send')
      const at = typeof still.capturedAt === 'number' ? still.capturedAt : Date.parse(still.capturedAt)
      return { contentType: still.contentType, dataB64, capturedAt: Number.isFinite(at) ? at : env.now(), source: still.source }
    }
    const blob = await printers().snapshot(printerId)
    if (!blob) return null
    const dataB64 = toB64(new Uint8Array(await blob.arrayBuffer()))
    if (dataB64.length > MAX_FRAME_B64) throw new PairError('too_large', 'The picture is too large to send')
    return { contentType: blob.type || 'image/jpeg', dataB64, capturedAt: env.now(), source: 'snapshot' }
  }

  async function handle(s: Session, method: Method, params: unknown): Promise<unknown> {
    const rec = records.get(s.pairingId)
    if (!rec) throw new PairError('forbidden', 'This device is no longer paired')
    const p = params as Record<string, unknown>
    switch (method) {
      case 'host.info':
        return {
          identity: me.public,
          kind: o.kind,
          slicing: [...(svc.slicer ? ['host' as const] : []), ...(svc.cloudSlicer ? ['cloud' as const] : []), 'phone' as const],
          printers: svc.printers !== undefined,
          camera: svc.camera !== undefined,
          push: svc.push !== undefined,
          rights: rec.rights,
        }
      case 'printers.list':
        return printers().list()
      case 'fleets.list':
        return printers().fleets()
      case 'printers.status':
        return printers().status(String(p['printerId']))
      case 'printers.watch': {
        if (s.watches.size >= limits.watchesPerSession) throw new PairError('busy', 'Too many printers watched at once')
        const printerId = String(p['printerId'])
        const watchId = toB64url(env.random(9))
        const off = printers().subscribe(printerId, (event) => s.rpc.emit('printer', { watchId, printerId, event }))
        s.watches.set(watchId, off)
        return { watchId }
      }
      case 'printers.unwatch': {
        const id = String(p['watchId'])
        s.watches.get(id)?.()
        s.watches.delete(id)
        return {}
      }
      case 'printers.snapshot': {
        const blob = await printers().snapshot(String(p['printerId']))
        if (!blob || blob.size > 512 * 1024) return null
        return { contentType: blob.type || 'image/jpeg', dataB64: toB64url(new Uint8Array(await blob.arrayBuffer())) }
      }
      case 'camera.open': {
        if (!svc.camera) throw new PairError('not_supported', 'This host has no live camera')
        s.camera ??= createCameraRelay(svc.camera, s.rpc, { maxStreams: limits.cameraStreamsPerSession, now: env.now })
        return s.camera.open(String(p['printerId']), p['quality'] as 'low' | 'medium' | 'high' | 'auto' | undefined)
      }
      case 'camera.quality':
        if (!s.camera) throw new PairError('not_found', 'No such camera stream')
        return s.camera.setQuality(Number(p['stream']), p['quality'] as 'low' | 'medium' | 'high')
      case 'camera.close':
        await s.camera?.close(Number(p['stream']))
        return {}
      case 'camera.grab':
        return grabStill(String(p['printerId']))
      case 'camera.rtc':
        // Direct video comes from the hub (sx-link) with remote access; this host relays frames.
        throw new PairError('not_supported', 'Direct video is not available from this computer; use camera.open')
      case 'push.register':
        if (!svc.push) throw new PairError('not_supported', 'This host cannot send alerts')
        await svc.push.register({ token: String(p['token']), platform: p['platform'] as 'ios' | 'android', prefs: p['prefs'] as PushPrefs, tag: s.pairingId })
        return {}
      case 'push.unregister':
        await svc.push?.unregister({ token: String(p['token']) })
        return {}
      case 'library.list':
        if (!svc.library) return []
        return (await svc.library.list()).slice(0, 2000)
      case 'slice.start':
        need(s, 'request')
        return startSlice(s, p as { source: SliceSource; where: 'host' | 'cloud'; printerId?: string; options?: SliceOptions })
      case 'slice.cancel': {
        const run = running.get(String(p['sliceId']))
        if (run?.pairingId === s.pairingId) run.ctrl.abort()
        return {}
      }
      case 'upload.begin':
        need(s, 'request')
        return beginUpload(s, p as Parameters<typeof beginUpload>[1])
      case 'upload.chunk':
        need(s, 'request')
        return uploadChunk(s, p as { uploadId: string; offset: number; data: string })
      case 'upload.finish':
        need(s, 'request')
        return finishUpload(s, String(p['uploadId']))
      case 'jobs.send':
        need(s, 'request')
        return sendJob(s, rec, p as { sliceId: string; target: JobTarget; start: boolean; opts?: StartOptions })
      case 'jobs.start':
        need(s, 'request')
        return startFile(s, rec, p as { fileRef: string; opts?: StartOptions })
      case 'jobs.control':
        need(s, 'request')
        return control(s, rec, p as { printerId: string; action: 'pause' | 'resume' | 'cancel' })
      case 'approvals.list':
        return approvalsFor(rec)
      case 'approvals.decide':
        return decideFromPhone(need(s, 'approve'), p as DecideParams)
      case 'pairing.revoke':
        // Reply first; revoking closes the session the reply travels on.
        setTimeout(() => void revoke(s.pairingId, false), 0)
        return {}
      case 'remote.quota':
        // This host is not on the relay itself; the hub's relay quota comes from sx-link.
        return null
    }
  }

  // -------------------------------------------------------------------------
  // Slicing and uploads

  function ownSlices(pairingId: string): SliceEntry[] {
    return [...slices.values()].filter((x) => x.pairingId === pairingId)
  }

  function keepSlice(entry: SliceEntry): void {
    const own = ownSlices(entry.pairingId)
    while (own.length >= limits.slicesPerPairing) {
      const oldest = own.shift()
      if (oldest) slices.delete(oldest.summary.sliceId)
    }
    slices.set(entry.summary.sliceId, entry)
  }

  function sliceEntry(pairingId: string, file: SlicedFile, where: SliceSummary['where'], printerId?: string, digest?: string): SliceEntry {
    const hash = digest ?? toHex(sha256(new Uint8Array(file.data)))
    const summary: SliceSummary = {
      sliceId: toB64url(env.random(16)),
      name: file.name.slice(0, 200) || 'plate.gcode',
      kind: file.kind,
      sizeBytes: file.data.byteLength,
      sha256: hash,
      where,
      ...(printerId ? { printerId } : {}),
      ...(file.timeS !== undefined ? { timeS: file.timeS } : {}),
      ...(file.grams !== undefined ? { grams: file.grams } : {}),
      ...(file.layers !== undefined ? { layers: file.layers } : {}),
    }
    return { pairingId, file, sha256: hash, summary }
  }

  function startSlice(s: Session, p: { source: SliceSource; where: 'host' | 'cloud'; printerId?: string; options?: SliceOptions }): { sliceId: string } {
    const slicer = p.where === 'cloud' ? svc.cloudSlicer : svc.slicer
    if (!slicer) throw new PairError('not_supported', p.where === 'cloud' ? 'Cloud slicing is not available here' : 'This host cannot slice')
    let blob: { name: string; kind: string; data: ArrayBuffer } | undefined
    if (p.source.kind === 'blob') {
      const b = blobs.get(p.source.blobId)
      if (!b || b.pairingId !== s.pairingId) throw new PairError('not_found', 'Upload the model first')
      blob = b
    }
    const sliceId = toB64url(env.random(16))
    const ctrl = new AbortController()
    running.set(sliceId, { pairingId: s.pairingId, ctrl })
    const pid = s.pairingId
    const emitAll = (fn: (x: Session) => void) => sessionsOf(pid).forEach(fn)
    slicer
      .slice({ source: p.source, ...(p.printerId ? { printerId: p.printerId } : {}), ...(blob ? { blob } : {}), ...(p.options ? { options: p.options } : {}) }, (stage, fraction) =>
        emitAll((x) => x.rpc.emit('slice.progress', { sliceId, stage: stage.slice(0, 40), fraction: Math.min(1, Math.max(0, fraction)) })),
      ctrl.signal)
      .then((file) => {
        const entry = sliceEntry(pid, file, p.where, p.printerId)
        entry.summary.sliceId = sliceId
        keepSlice(entry)
        emitAll((x) => x.rpc.emit('slice.done', { slice: entry.summary }))
      })
      .catch(() => emitAll((x) => x.rpc.emit('slice.failed', { sliceId, message: ctrl.signal.aborted ? 'Canceled' : 'Slicing failed' })))
      .finally(() => running.delete(sliceId))
    return { sliceId }
  }

  function beginUpload(s: Session, p: { name: string; kind: string; size: number; sha256: string; stats?: Upload['stats']; printerId?: string }) {
    if (p.size > limits.maxUploadBytes) throw new PairError('too_large', 'The file is too large to send')
    for (const [id, u] of uploads) if (u.pairingId === s.pairingId) uploads.delete(id)
    const uploadId = toB64url(env.random(16))
    uploads.set(uploadId, {
      pairingId: s.pairingId,
      name: p.name,
      kind: p.kind,
      size: p.size,
      sha256: p.sha256,
      buf: new Uint8Array(p.size),
      received: 0,
      hasher: sha256Stream(),
      ...(p.stats ? { stats: p.stats } : {}),
      ...(p.printerId ? { printerId: p.printerId } : {}),
    })
    return { uploadId, chunkBytes: limits.chunkBytes }
  }

  function uploadChunk(s: Session, p: { uploadId: string; offset: number; data: string }) {
    const u = uploads.get(p.uploadId)
    if (!u || u.pairingId !== s.pairingId) throw new PairError('not_found', 'Unknown upload')
    const data = fromB64url(p.data)
    if (!data || p.offset !== u.received || data.length > limits.chunkBytes || u.received + data.length > u.size) {
      uploads.delete(p.uploadId)
      throw new PairError('bad_request', 'Upload chunk out of order or too large')
    }
    u.buf.set(data, u.received)
    u.hasher.update(data)
    u.received += data.length
    return { received: u.received }
  }

  function finishUpload(s: Session, uploadId: string) {
    const u = uploads.get(uploadId)
    if (!u || u.pairingId !== s.pairingId) throw new PairError('not_found', 'Unknown upload')
    uploads.delete(uploadId)
    const digest = toHex(u.hasher.digest())
    if (u.received !== u.size || digest !== u.sha256) throw new PairError('bad_request', 'The file did not arrive intact')
    const blobId = toB64url(env.random(16))
    const data = toArrayBuffer(u.buf)
    if (MODEL_KINDS.has(u.kind)) {
      for (const [id, b] of blobs) if (b.pairingId === s.pairingId) blobs.delete(id)
      blobs.set(blobId, { pairingId: s.pairingId, name: u.name, kind: u.kind, data })
      return { blobId }
    }
    const entry = sliceEntry(s.pairingId, { name: u.name, kind: u.kind as JobFile['kind'], data, ...u.stats }, 'phone', u.printerId, digest)
    keepSlice(entry)
    return { blobId, slice: entry.summary }
  }

  // -------------------------------------------------------------------------
  // Jobs and approvals

  async function resolveTargets(target: JobTarget): Promise<{ id: string; name: string }[]> {
    const all = await printers().list()
    let ids: string[]
    if ('fleetId' in target) {
      const fleet = (await printers().fleets()).find((f) => f.id === target.fleetId)
      if (!fleet) throw new PairError('not_found', 'Unknown fleet')
      ids = fleet.printerIds
    } else {
      ids = target.printerIds
    }
    const unique = [...new Set(ids)]
    if (unique.length === 0) throw new PairError('bad_request', 'No printers in the target')
    if (unique.length > limits.printersPerJob) throw new PairError('too_large', 'Too many printers for one job')
    return unique.map((id) => {
      const p = all.find((x) => x.id === id)
      if (!p) throw new PairError('not_found', 'Unknown printer')
      return { id, name: p.name }
    })
  }

  /** The bytes this printer will be sent. BamBuddy may stamp a non-Bambu profile; the approval then covers that hash. */
  async function fileForPrinter(printerId: string, slice: SliceEntry): Promise<JobFile> {
    const file: JobFile = { name: slice.summary.name, kind: slice.file.kind, data: slice.file.data, sha256: slice.sha256 }
    const prepare = printers().prepareUpload
    return prepare ? prepare(printerId, file) : file
  }

  async function sendJob(s: Session, rec: PairingRecord, p: { sliceId: string; target: JobTarget; start: boolean; opts?: StartOptions }) {
    const slice = slices.get(p.sliceId)
    if (!slice || slice.pairingId !== s.pairingId) throw new PairError('not_found', 'Unknown slice')
    if (!svc.approvals) throw new PairError('not_supported', 'This host cannot approve print jobs')
    const targets = await resolveTargets(p.target)
    const opts: StartOptions = p.opts ?? {}
    const name = slice.summary.name
    const prepared = []
    for (const t of targets) prepared.push({ t, file: await fileForPrinter(t.id, slice) })
    const actions = []
    for (const { t, file } of prepared) {
      actions.push({ action: 'printer.upload' as const, target: t.id, paramsHash: await hashParams({ printerId: t.id, name: file.name, sha256: file.sha256 }) })
      if (p.start) actions.push({ action: 'printer.start' as const, target: t.id, paramsHash: await hashParams({ printerId: t.id, name: file.name, opts, sha256: file.sha256 }) })
    }
    const hashes = [...new Set(prepared.map((row) => row.file.sha256))]
    const names = targets.map((t) => t.name)
    const where = names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
    return raiseApproval(s, rec, {
      permission: p.start ? 'start' : 'queue',
      title: p.start ? `Print ${name} on ${where}` : `Send ${name} to ${where}`,
      lines: [
        `${name}, ${(slice.summary.sizeBytes / 1_048_576).toFixed(1)} MB, sliced ${slice.summary.where === 'phone' ? 'on the phone' : slice.summary.where === 'cloud' ? 'in the cloud' : 'on this computer'}`,
        ...(slice.summary.timeS !== undefined ? [`Print time ${Math.floor(slice.summary.timeS / 3600)} h ${Math.round((slice.summary.timeS % 3600) / 60)} m`] : []),
        ...(slice.summary.grams !== undefined ? [`Filament ${slice.summary.grams.toFixed(0)} g`] : []),
        p.start ? 'Heats and starts each printer' : 'Uploads only, nothing starts',
        hashes.length === 1 && hashes[0] ? `SHA-256 ${hashes[0].slice(0, 16)}` : 'Each printer is sent the file labeled for its own model',
      ],
      ...(targets.length === 1 && targets[0] ? { printerId: targets[0].id } : {}),
      input: { sliceId: p.sliceId, target: p.target, start: p.start, opts },
      actions,
      work: { kind: 'print', printerIds: targets.map((t) => t.id), slice, start: p.start, opts },
    })
  }

  async function startFile(s: Session, rec: PairingRecord, p: { fileRef: string; opts?: StartOptions }) {
    const f = remoteFiles.get(p.fileRef)
    if (!f || f.pairingId !== s.pairingId) throw new PairError('not_found', 'Unknown file')
    const opts: StartOptions = p.opts ?? {}
    const { remote } = f
    const printer = (await printers().list()).find((x) => x.id === remote.printerId)
    return raiseApproval(s, rec, {
      permission: 'start',
      title: `Start ${remote.name} on ${printer?.name ?? remote.printerId}`,
      lines: ['Heats and starts the printer'],
      printerId: remote.printerId,
      input: { fileRef: p.fileRef, opts },
      actions: [{ action: 'printer.start', target: remote.printerId, paramsHash: await hashParams(remote.sha256 ? { printerId: remote.printerId, name: remote.name, opts, sha256: remote.sha256 } : { printerId: remote.printerId, name: remote.name, opts }) }],
      work: { kind: 'start', fileRef: p.fileRef, remote, opts },
    })
  }

  async function control(s: Session, rec: PairingRecord, p: { printerId: string; action: 'pause' | 'resume' | 'cancel' }) {
    const printer = (await printers().list()).find((x) => x.id === p.printerId)
    if (!printer) throw new PairError('not_found', 'Unknown printer')
    const verb = { pause: 'Pause', resume: 'Resume', cancel: 'Cancel' }[p.action]
    return raiseApproval(s, rec, {
      permission: p.action === 'resume' ? 'start' : 'queue',
      title: `${verb} the print on ${printer.name}`,
      lines: [p.action === 'resume' ? 'Heats and moves the printer again' : p.action === 'cancel' ? 'Stops the current print for good' : 'Stops the print where it is'],
      printerId: p.printerId,
      input: { printerId: p.printerId, action: p.action },
      actions: [{ action: `printer.${p.action}`, target: p.printerId, paramsHash: await hashParams({ printerId: p.printerId }) }],
      work: { kind: 'control', printerId: p.printerId, action: p.action },
    })
  }

  async function raiseApproval(
    s: Session,
    rec: PairingRecord,
    a: { permission: PermissionClass; title: string; lines: string[]; printerId?: string; input: unknown; actions: ApprovalAction[]; work: JobWork },
  ): Promise<{ jobId: string; requestId: string }> {
    const approvals = svc.approvals
    if (!approvals) throw new PairError('not_supported', 'This host cannot approve print jobs')
    const pendingCount = [...jobs.values()].filter((j) => j.pairingId === s.pairingId && j.state === 'pending').length
    if (pendingCount >= limits.pendingJobsPerPairing) throw new PairError('busy', 'Too many jobs waiting for approval')
    const jobId = toB64url(env.random(16))
    const request: ApprovalRequest = {
      id: `pair-${jobId}`,
      sessionId: `pair:${s.pairingId}`,
      tool: `pair.${a.work.kind}`,
      permission: a.permission,
      title: a.title,
      lines: [`Requested from ${rec.peer.name}`, ...a.lines],
      ...(a.printerId ? { printerId: a.printerId } : {}),
      paramsHash: await hashParams(a.input),
      actions: a.actions,
      expiresAt: new Date(env.now() + limits.approvalTtlMs).toISOString(),
      // Every job a paired phone raises is remote: the card names the phone and always asks about the bed.
      origin: 'phone',
    }
    await approvals.register(request)
    const job: Job = {
      jobId,
      pairingId: s.pairingId,
      request,
      work: a.work,
      state: 'pending',
      timer: setTimeout(() => void resolveJob(job, 'expired', 'expiry'), limits.approvalTtlMs),
    }
    jobs.set(jobId, job)
    const v: ApprovalView = { request, source: 'pair', requestedBy: rec.peer.name }
    for (const x of approverSessions()) x.rpc.emit('approval.request', v)
    for (const cb of [...jobRequestCbs]) cb(v)
    for (const x of sessionsOf(s.pairingId)) x.rpc.emit('job', { jobId, state: 'awaiting_approval' })
    return { jobId, requestId: request.id }
  }

  function jobByRequest(requestId: string): Job | undefined {
    return [...jobs.values()].find((j) => j.request.id === requestId)
  }

  function emitJob(job: Job, state: JobState, printerId?: string, message?: string, file?: { fileRef: string; remoteName: string }): void {
    for (const x of sessionsOf(job.pairingId)) {
      x.rpc.emit('job', { jobId: job.jobId, state, ...(printerId ? { printerId } : {}), ...(message ? { message } : {}), ...(file ?? {}) })
    }
  }

  function keepRemote(pairingId: string, remote: RemoteFile): { fileRef: string; remoteName: string } {
    const own = [...remoteFiles].filter(([, f]) => f.pairingId === pairingId)
    while (own.length >= 32) {
      const oldest = own.shift()
      if (oldest) remoteFiles.delete(oldest[0])
    }
    const fileRef = toB64url(env.random(16))
    remoteFiles.set(fileRef, { pairingId, remote })
    return { fileRef, remoteName: remote.name.slice(0, 200) }
  }

  const refusal = (e: unknown) => {
    const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : 'failed'
    return `The printer refused the job (${code.slice(0, 40)})`
  }

  async function resolveJob(job: Job, decision: 'approve' | 'deny' | 'expired', by: string, bedClear = false): Promise<void> {
    if (job.state !== 'pending') return
    clearTimeout(job.timer)
    const approvals = svc.approvals
    if (decision === 'approve' && env.now() > Date.parse(job.request.expiresAt)) decision = 'expired'
    job.state = decision === 'approve' ? 'running' : 'done'
    for (const x of approverSessions()) x.rpc.emit('approval.resolved', { requestId: job.request.id, decision, by })
    for (const cb of [...jobResolvedCbs]) cb(job.request.id, decision)
    if (decision !== 'approve' || !approvals) {
      await approvals?.deny(job.request.id, decision === 'expired' ? 'expired' : 'denied')
      emitJob(job, decision === 'expired' ? 'expired' : 'denied')
      jobs.delete(job.jobId)
      return
    }
    let token
    try {
      token = await grantApproval(approvals, job.request, bedClear)
    } catch {
      emitJob(job, 'failed', undefined, 'The approval could not be granted')
      job.state = 'done'
      jobs.delete(job.jobId)
      return
    }
    const host = printers()
    const w = job.work
    if (w.kind === 'print') {
      for (const printerId of w.printerIds) {
        const file = await fileForPrinter(printerId, w.slice)
        try {
          emitJob(job, 'uploading', printerId)
          const remote = await host.upload(printerId, file, token)
          const ref = keepRemote(job.pairingId, remote)
          if (w.start) {
            emitJob(job, 'starting', printerId)
            await host.start(remote, w.opts, token)
            emitJob(job, 'started', printerId, undefined, ref)
          } else {
            emitJob(job, 'queued', printerId, undefined, ref)
          }
        } catch (e) {
          emitJob(job, 'failed', printerId, refusal(e))
        }
      }
    } else if (w.kind === 'start') {
      try {
        emitJob(job, 'starting', w.remote.printerId)
        await host.start(w.remote, w.opts, token)
        emitJob(job, 'started', w.remote.printerId, undefined, { fileRef: w.fileRef, remoteName: w.remote.name.slice(0, 200) })
      } catch (e) {
        emitJob(job, 'failed', w.remote.printerId, refusal(e))
      }
    } else {
      try {
        await host[w.action](w.printerId, token)
        emitJob(job, 'done', w.printerId)
      } catch (e) {
        emitJob(job, 'failed', w.printerId, refusal(e))
      }
    }
    job.state = 'done'
    jobs.delete(job.jobId)
  }

  function approvalsFor(rec: PairingRecord): ApprovalView[] {
    const own = [...jobs.values()].filter((j) => j.state === 'pending' && (rec.rights.approve || j.pairingId === rec.pairingId))
    const out: ApprovalView[] = own.map((j) => ({ request: j.request, source: 'pair', requestedBy: records.get(j.pairingId)?.peer.name ?? 'Phone' }))
    if (rec.rights.approve && svc.approvalFeed) out.push(...svc.approvalFeed.pending().map((request) => ({ request, source: 'pilot' as const })))
    return out
  }

  async function decideFromPhone(rec: PairingRecord, p: DecideParams): Promise<Record<string, never>> {
    const job = jobByRequest(p.requestId)
    const request = job?.state === 'pending' ? job.request : svc.approvalFeed?.pending().find((r) => r.id === p.requestId)
    if (!request) throw new PairError('not_found', 'This request was already decided or has expired')
    if (!verifyDecision(rec.peer.signPub, request, p)) throw new PairError('forbidden', 'The decision does not match the request')
    auditLog.push({ requestId: p.requestId, deviceId: rec.peer.deviceId, deviceName: rec.peer.name, decision: p.decision, at: env.now(), requestHash: p.requestHash, sig: p.sig })
    if (job) {
      void resolveJob(job, p.decision, rec.peer.name, p.bedClear === true)
    } else if (svc.approvalFeed) {
      await svc.approvalFeed.decide(p.requestId, p.decision === 'approve' ? (p.bedClear === true ? { kind: 'approve', bedClear: true } : { kind: 'approve' }) : { kind: 'deny', reason: `Denied on ${rec.peer.name}` }, {
        deviceId: rec.peer.deviceId,
        name: rec.peer.name,
      })
    }
    return {}
  }

  if (svc.approvalFeed) {
    const feed = svc.approvalFeed
    feedOffs.push(
      feed.onRequest((request) => {
        for (const x of approverSessions()) x.rpc.emit('approval.request', { request, source: 'pilot' })
      }),
      feed.onResolved((requestId, decision) => {
        for (const x of approverSessions()) x.rpc.emit('approval.resolved', { requestId, decision, by: 'host' })
      }),
    )
  }

  // -------------------------------------------------------------------------
  // Revocation

  async function revoke(pairingId: string, tell = true): Promise<void> {
    const rec = records.get(pairingId)
    if (!rec) return
    for (const s of [...sessions.values()].filter((x) => x.pairingId === pairingId)) {
      if (tell) s.rpc.emit('pairing.revoked', {})
      closeSession(s.channel.sid)
    }
    for (const rel of relays) {
      rel.routes.get(pairingId)?.()
      rel.routes.delete(pairingId)
    }
    for (const j of [...jobs.values()]) if (j.pairingId === pairingId) void resolveJob(j, 'deny', 'revoked')
    // The phone is no longer trusted: the hub stops sending it alerts.
    void svc.push?.unregister({ tag: pairingId }).catch(() => undefined)
    if (rec.grantId) {
      revokedGrants.add(rec.grantId)
      await o.store.addRevokedGrant(rec.grantId)
    }
    unindex(pairingId)
    await o.store.delete(pairingId)
    notifyChanged()
  }

  const host: PairHost = {
    identity: me.public,
    createOffer(opts = {}) {
      const ttl = opts.ttlMs ?? OFFER_TTL_MS
      const group: OfferGroup = { consumed: false, canceled: false, attemptCbs: new Set(), relayPipes: [] }
      const qrId = env.random(16)
      const secret = env.random(32)
      const qr = createOffererState(env, secret, qrId, ttl)
      const code = createShortCode(env.random)
      const codeOffer = offerFromShortCode(code, endpoints.relay)
      if (!codeOffer?.secret) throw new Error('Short code generation failed')
      const byCode = createOffererState(env, codeOffer.secret, codeOffer.offerId, ttl)
      offers.set(toB64url(qrId), { st: qr, group })
      offers.set(toB64url(codeOffer.offerId), { st: byCode, group })
      for (const rel of relays) {
        listenOffer(rel, qrId, group)
        listenOffer(rel, codeOffer.offerId, group)
      }
      const expiry = setTimeout(() => {
        if (!group.consumed) cancelGroup(group)
      }, ttl)
      return {
        link: offerLink(o.linkBase ?? 'slicerx://pair', { offerId: qrId, secret, offererKey: qr.eph.publicKey, expiresAt: qr.expiresAt, hostName: me.public.name, endpoints }),
        code,
        expiresAt: qr.expiresAt,
        onAttempt(cb) {
          group.attemptCbs.add(cb)
          return () => group.attemptCbs.delete(cb)
        },
        cancel() {
          clearTimeout(expiry)
          cancelGroup(group)
        },
      }
    },
    handlePipe(pipe) {
      const off = pipe.onFrame((t) => onFrame(pipe, t))
      pipe.onClose(() => {
        off()
        for (const s of [...sessions.values()]) if (s.pipe === pipe) closeSession(s.channel.sid)
      })
    },
    attachRelay(relay) {
      const rel = { relay, routes: new Map<string, () => void>() }
      relays.add(rel)
      for (const id of records.keys()) subscribePairing(rel, id)
      const signPub = fromB64url(me.public.signPub)
      const introPipe = signPub ? relayPipe(relay, introRoute(signPub), introRoute(signPub)) : null
      // Only first contact from introduced devices arrives here; the host never replies on this route.
      introPipe?.onFrame((t) => {
        const f = parseFrame(t)
        if (f?.k === 'init' && f.g) void onInit(introPipe, f, relay)
        else if (f?.k === 'data') onFrame(introPipe, t)
      })
      for (const [id, e] of offers) {
        const bytes = fromB64url(id)
        if (bytes && !e.group.canceled) listenOffer(rel, bytes, e.group)
      }
      return () => {
        relays.delete(rel)
        introPipe?.close()
        for (const off of rel.routes.values()) off()
      }
    },
    watchJoinRequests(relay, onRequest) {
      if (!accountId) return () => {}
      return watchAccountJoins(env, relay, accountId, (req: JoinRequest) => {
        onRequest({
          requestId: req.requestId,
          name: req.name,
          platform: req.platform,
          review() {
            let rights = defaultRights()
            const attempt = req.review({
              identity: me,
              buildConfirm: async () => ({ rights, endpoints, ...(accountId ? { accountId } : {}) }),
            })
            if (!attempt) return null
            return {
              deviceName: req.name,
              platform: req.platform,
              sas: attempt.sas,
              confirm(chosen) {
                if (chosen) rights = chosen
                attempt.confirm()
              },
              reject: () => attempt.reject('mismatch'),
              result: attempt.result.then((res) => completePairing(res, rights)),
            }
          },
        })
      })
    },
    devices: async () => [...records.values()].map(view),
    revoke: (id) => revoke(id),
    async setRights(pairingId, rights) {
      const rec = records.get(pairingId)
      if (!rec) return
      const next = { ...rec, rights }
      await o.store.put(next)
      records.set(pairingId, next)
      for (const s of sessionsOf(pairingId)) s.rpc.emit('pairing.rights', { rights })
      notifyChanged()
    },
    setEndpoints(next) {
      endpoints = next
    },
    setAccount(id) {
      accountId = id
      notifyChanged()
    },
    async revokeAccountDevices(deviceIds) {
      const set = new Set(deviceIds)
      for (const r of [...records.values()]) if (r.accountId && r.accountId === accountId && set.has(r.peer.deviceId)) await revoke(r.pairingId)
    },
    onDevicesChanged(cb) {
      changed.add(cb)
      return () => changed.delete(cb)
    },
    jobApprovals: {
      pending: () => [...jobs.values()].filter((j) => j.state === 'pending').map((j) => ({ request: j.request, source: 'pair' as const, requestedBy: records.get(j.pairingId)?.peer.name ?? 'Phone' })),
      async decide(requestId, decision) {
        const job = jobByRequest(requestId)
        if (job) await resolveJob(job, decision.kind, 'this computer', decision.kind === 'approve' && decision.bedClear === true)
      },
      onRequest(cb) {
        jobRequestCbs.add(cb)
        return () => jobRequestCbs.delete(cb)
      },
      onResolved(cb) {
        jobResolvedCbs.add(cb)
        return () => jobResolvedCbs.delete(cb)
      },
    },
    audit: () => auditLog.map((a) => ({ ...a })),
    close() {
      for (const sid of [...sessions.keys()]) closeSession(sid)
      for (const rel of relays) for (const off of rel.routes.values()) off()
      relays.clear()
      for (const j of jobs.values()) clearTimeout(j.timer)
      for (const off of feedOffs) off()
      for (const r of running.values()) r.ctrl.abort()
    },
  }
  return host
}

export { ALL_RIGHTS }
