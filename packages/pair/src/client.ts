// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The phone side. Pairs by QR link, short code or account approval, keeps the list of paired
// hosts, and opens encrypted connections to them: straight over the LAN when the host is
// reachable there, through the relay otherwise.
import type { Fleet, PrinterEvent, PrinterInfo, PrinterStatus, StartOptions } from '@slicerx/contracts'
import { fromB64url, toB64url, toHex } from './bytes'
import { defaultEnv, sha256, type PairEnv } from './crypto'
import { accountJoinPipe, watchAccountJoins } from './account'
import { signDecision } from './approval'
import { grantSignatureValid, introducedDeviceKey, introducedPairingId, issueGrant } from './grant'
import { joinOverPipe, type JoinResult } from './handshake'
import { NO_RIGHTS, type DeviceIdentity, type PairingRecord, type PairingStore } from './identity'
import { introRoute, isLocalUrl, OFFER_TTL_MS, offerRoutes, pairingRoutes, parsePairingInput, type OfferInfo } from './offer'
import { createRpcPeer, PairError, type ApprovalView, type CameraQuality, type EventMap, type EventName, type HostInfo, type JobTarget, type JobUpdate, type LibraryEntry, type PushPrefs, type RemoteQuota, type RpcPeer, type SliceOptions, type SliceSource, type SliceSummary } from './rpc'
import type { DevicePlatform, Endpoints, PublicIdentity, Rights } from './schema'
import { openSession, SessionError } from './session'
import { openSocket, pipeFromSocket, relayPipe, type Pipe, type RelayConnection, type SocketFactory } from './transport'

export interface PairClientOptions {
  env?: PairEnv
  identity: DeviceIdentity
  store: PairingStore
  /** Relays this app trusts. A pairing link or host naming another relay is ignored. */
  relays: readonly string[]
  defaultRelay?: string
  /** QR link prefixes the app accepts. */
  linkBases?: readonly string[]
  /** Opens LAN WebSockets (ws:// to private addresses only). */
  socket: SocketFactory
  /** Opens a relay connection, carrying the account session when signed in. */
  openRelay?: (url: string) => Promise<RelayConnection>
  accountId?: string | null
  lanTimeoutMs?: number
  sessionTimeoutMs?: number
  /** How long a QR or code pairing waits for the host to answer. Default 20 s. */
  pairAnswerTimeoutMs?: number
}

export interface PairedHost {
  pairingId: string
  hostId: string
  name: string
  platform: DevicePlatform
  rights: Rights
  endpoints: Endpoints
  createdAt: number
  lastSeenAt?: number
  accountLinked: boolean
  /** Introduced by another device and not yet confirmed by the host. */
  pendingIntroduction: boolean
  /** Unpaired on this phone, but the host has not confirmed yet: it may still answer this phone's key. */
  pendingRemoval?: boolean
}

export type PairingOutcome = { ok: true; hosts: PairedHost[] } | { ok: false; reason: string }

export interface PairingFlow {
  hostName?: string
  /** Resolves with the six digits once the other screen can show them too. */
  sas: Promise<string>
  confirm(): void
  reject(): void
  result: Promise<PairingOutcome>
}

export interface DeviceJoinRequest {
  requestId: string
  name: string
  platform: DevicePlatform
  /** Null when this device has no hosts it may introduce the new device to. */
  review(): Promise<PairingFlow | null>
}

export interface HostConnection {
  readonly info: HostInfo
  readonly via: 'lan' | 'relay'
  printers(): Promise<PrinterInfo[]>
  fleets(): Promise<Fleet[]>
  status(printerId: string): Promise<PrinterStatus>
  watch(printerId: string, cb: (e: PrinterEvent) => void): Promise<() => void>
  snapshot(printerId: string): Promise<{ contentType: string; data: Uint8Array } | null>
  /** Live camera through the computer: JPEG frames as standard base64, ready for a `data:` URI. */
  readonly camera: PairedCamera
  /** One still: the printer's snapshot, else a frame of its live video. Null without a camera. */
  grab(printerId: string): Promise<{ contentType: string; dataB64: string; capturedAt: number; source: 'snapshot' | 'stream' } | null>
  /** This phone's Expo push token, held by the computer's hub, which sends alerts while the app is closed. */
  readonly push: PairedPush
  library(): Promise<LibraryEntry[]>
  /** Slices on the host or in the cloud and resolves when the file is ready to send. */
  slice(req: { source: SliceSource; where: 'host' | 'cloud'; printerId?: string; options?: SliceOptions }, onProgress?: (stage: string, fraction: number) => void): Promise<SliceSummary>
  /** Sends G-code sliced on the phone. The host checks the SHA-256 before it keeps the file. */
  uploadSlice(file: UploadFile & { kind: 'gcode' | 'gcode.3mf' | 'bgcode'; stats?: { timeS?: number; grams?: number; layers?: number } }, onProgress?: (fraction: number) => void): Promise<SliceSummary>
  /** Sends a model for the host or cloud to slice. Returns the blob id for `slice({ source: { kind: 'blob', blobId } })`. */
  uploadModel(file: UploadFile & { kind: '3mf' | 'stl' }, onProgress?: (fraction: number) => void): Promise<string>
  /** Asks for an approval to upload (and start). Nothing reaches a printer until someone approves. */
  send(req: { sliceId: string; target: JobTarget; start: boolean; opts?: StartOptions }): Promise<{ jobId: string; requestId: string }>
  /** Starts a file an earlier job left on a printer (`fileRef` from its `queued` update). Needs an approval. */
  startFile(fileRef: string, opts?: StartOptions): Promise<{ jobId: string; requestId: string }>
  /** Pause, resume or cancel the current print. Needs an approval. */
  control(printerId: string, action: 'pause' | 'resume' | 'cancel'): Promise<{ jobId: string; requestId: string }>
  approvals(): Promise<ApprovalView[]>
  /** The relay quota of the computer's hub; null when it is not on the relay. */
  quota(): Promise<RemoteQuota | null>
  /** Call only from the approve button of the approval card. */
  /** `bedClear`: the person confirmed the build plate is clear on the screen that asked. */
  approve(v: ApprovalView, opts?: { bedClear?: boolean }): Promise<void>
  deny(v: ApprovalView): Promise<void>
  on<E extends EventName>(event: E, cb: (data: EventMap[E]) => void): () => void
  onJob(cb: (u: JobUpdate) => void): () => void
  onClose(cb: () => void): () => void
  close(): void
}

export interface PairedCameraFrame {
  stream: number
  capturedAt: number
  key: boolean
  kind: 'jpeg'
  /** Standard base64. */
  dataB64: string
}

export interface PairedCameraStats {
  stream: number
  fps: number
  kbps: number
  dropped: number
  quality: CameraQuality
}

export interface PairedCamera {
  /** Rejects with `not_supported` when the printer has no live camera (use stills then). */
  open(printerId: string, opts: { quality: CameraQuality | 'auto' }): Promise<{ stream: number; quality: CameraQuality }>
  setQuality(stream: number, quality: CameraQuality): Promise<{ quality: CameraQuality }>
  close(stream: number): Promise<void>
  onFrame(cb: (f: PairedCameraFrame) => void): () => void
  onStats(cb: (s: PairedCameraStats) => void): () => void
  /**
   * Direct video (WebRTC) from a hub with remote access: send a complete offer, apply the answer.
   * Rejects with `not_supported` on hosts without it; use `open` then.
   */
  rtc?(printerId: string, offer: string): Promise<{ stream: number; sdp: string }>
  /** `reason` `codec`: the camera sends H.264, which the phone cannot draw; fall back to stills. */
  onEnded(cb: (e: { stream: number; reason?: 'ended' | 'codec' | 'closed' }) => void): () => void
}

export interface PairedPush {
  register(reg: { token: string; platform: 'ios' | 'android'; prefs: PushPrefs }): Promise<void>
  unregister(token: string): Promise<void>
}

export interface UploadFile {
  name: string
  data: Uint8Array
  printerId?: string
}

export interface PairClient {
  readonly identity: PublicIdentity
  /** A scanned QR link or a typed short code. Throws PairError('bad_request') for invalid input. */
  pair(input: string): Promise<PairingFlow>
  /** Asks the signed-in account's trusted devices to approve this one. */
  joinAccount(): Promise<PairingFlow>
  /** Shows join requests from new devices of the same account. */
  watchJoinRequests(relay: RelayConnection, cb: (r: DeviceJoinRequest) => void): () => void
  hosts(): Promise<PairedHost[]>
  connect(pairingId: string, opts?: { via?: 'lan' | 'relay' }): Promise<HostConnection>
  /**
   * Removes the pairing on the host and here. When the host cannot be reached, the record stays as
   * `pendingRemoval` (with its key, so the removal can be sent later) and `removedOnHost` is false:
   * show "removal pending" and call `retryRemovals` when the phone is back online.
   */
  unpair(pairingId: string): Promise<{ removedOnHost: boolean }>
  /** Tells hosts about removals that could not be sent before. Resolves to the number still pending. */
  retryRemovals(): Promise<number>
  setAccount(accountId: string | null): void
  onHostsChanged(cb: () => void): () => void
}

export function createPairClient(o: PairClientOptions): PairClient {
  const env = o.env ?? defaultEnv
  const me = o.identity
  let accountId = o.accountId ?? null
  const live = new Map<string, Set<HostConnection>>()
  const changed = new Set<() => void>()
  const notify = () => {
    for (const cb of [...changed]) cb()
  }

  const trustedRelay = (url: string | undefined): string | undefined => (url && o.relays.includes(url) ? url : o.defaultRelay)
  const cleanEndpoints = (e: Endpoints | undefined, fallback?: Endpoints): Endpoints => {
    const lan = [...(e?.lan ?? []), ...(fallback?.lan ?? [])].filter(isLocalUrl)
    const relay = trustedRelay(e?.relay ?? fallback?.relay)
    return { lan: [...new Set(lan)].slice(0, 4), ...(relay ? { relay } : {}) }
  }

  const view = (r: PairingRecord): PairedHost => ({
    pairingId: r.pairingId,
    hostId: r.peer.deviceId,
    name: r.peer.name,
    platform: r.peer.platform,
    rights: r.rights,
    endpoints: r.endpoints ?? { lan: [] },
    createdAt: r.createdAt,
    ...(r.lastSeenAt !== undefined ? { lastSeenAt: r.lastSeenAt } : {}),
    accountLinked: accountId !== null && r.accountId === accountId,
    pendingIntroduction: r.pendingGrant !== undefined,
    pendingRemoval: r.pendingRevoke === true,
  })

  async function relayFor(url: string | undefined): Promise<RelayConnection> {
    if (!url || !o.openRelay) throw new PairError('unavailable', 'No relay is configured')
    return o.openRelay(url)
  }

  async function openLan(url: string): Promise<Pipe> {
    if (!isLocalUrl(url)) throw new PairError('forbidden', 'Not a local address')
    return pipeFromSocket(await openSocket(o.socket, url, o.lanTimeoutMs ?? 1500))
  }

  async function saveOutcome(res: JoinResult, offer: OfferInfo): Promise<PairingOutcome> {
    if (!res.ok) return { ok: false, reason: res.reason }
    const c = res.offerer
    const now = env.now()
    const records: PairingRecord[] = []
    if (c.grants && c.grants.length > 0) {
      for (const g of c.grants) {
        // The grants came over the SAS-checked channel from the offerer; they must be its own and name this device.
        if (g.issuer.signPub !== c.identity.signPub || g.subject.signPub !== me.public.signPub || g.subject.dhPub !== me.public.dhPub || !grantSignatureValid(g)) continue
        const k = introducedDeviceKey(me.dhSecret, g.host.identity.dhPub, g)
        if (!k) continue
        records.push({
          pairingId: introducedPairingId(g),
          peer: g.host.identity,
          deviceKey: toB64url(k),
          rights: g.rights,
          createdAt: now,
          endpoints: cleanEndpoints(g.host.endpoints),
          accountId: g.accountId,
          introducedBy: g.issuer.deviceId,
          grantId: g.grantId,
          pendingGrant: g,
        })
      }
      if (records.length === 0) return { ok: false, reason: 'protocol' }
    } else {
      records.push({
        pairingId: res.keys.pairingId,
        peer: c.identity,
        deviceKey: toB64url(res.keys.deviceKey),
        rights: c.rights,
        createdAt: now,
        endpoints: cleanEndpoints(c.endpoints, offer.endpoints),
        ...(accountId && c.accountId === accountId ? { accountId } : {}),
      })
    }
    for (const r of records) await o.store.put(r)
    notify()
    return { ok: true, hosts: records.map(view) }
  }

  function flow(pipe: Pipe, offer: OfferInfo, account?: { timeoutMs: number }): PairingFlow {
    const attempt = joinOverPipe(pipe, { env, offer, identity: me, ...(accountId ? { accountId } : {}), ...(account ? { timeoutMs: account.timeoutMs, announce: true } : { answerTimeoutMs: o.pairAnswerTimeoutMs ?? 20_000 }) })
    return {
      ...(offer.hostName ? { hostName: offer.hostName } : {}),
      sas: attempt.sas,
      confirm: () => attempt.confirm(),
      reject: () => attempt.reject('mismatch'),
      result: attempt.result.then((r) => saveOutcome(r, offer)).finally(() => pipe.close()),
    }
  }

  async function record(pairingId: string): Promise<PairingRecord> {
    const r = (await o.store.list()).find((x) => x.pairingId === pairingId)
    if (!r) throw new PairError('not_found', 'Unknown pairing')
    return r
  }

  async function connect(pairingId: string, opts: { via?: 'lan' | 'relay'; removing?: boolean } = {}): Promise<HostConnection> {
    const rec = await record(pairingId)
    if (rec.pendingRevoke && !opts.removing) throw new PairError('forbidden', 'This computer was removed from this phone')
    const deviceKey = fromB64url(rec.deviceKey)
    const hostSign = fromB64url(rec.peer.signPub)
    const hostDh = fromB64url(rec.peer.dhPub)
    if (!deviceKey || !hostSign || !hostDh) throw new PairError('failed', 'The pairing record is damaged')
    const routes = pairingRoutes(deviceKey)
    const hostRoute = rec.pendingGrant ? introRoute(hostSign) : routes.host
    const endpoints = rec.endpoints ?? { lan: [] }
    const tries: { via: 'lan' | 'relay'; open: () => Promise<Pipe> }[] = []
    if (opts.via !== 'relay') for (const url of endpoints.lan) tries.push({ via: 'lan', open: () => openLan(url) })
    if (opts.via !== 'lan' && endpoints.relay) {
      const url = endpoints.relay
      tries.push({ via: 'relay', open: async () => relayPipe(await relayFor(url), routes.device, hostRoute) })
    }
    let lastError: unknown = new PairError('unavailable', 'The host is not reachable')
    for (const t of tries) {
      let pipe: Pipe | null = null
      try {
        pipe = await t.open()
        const channel = await openSession(pipe, {
          env,
          deviceKey,
          hostDhPub: hostDh,
          route: hostRoute,
          ...(rec.pendingGrant ? { grant: rec.pendingGrant } : {}),
          timeoutMs: o.sessionTimeoutMs ?? 8000,
        })
        const p = pipe
        channel.onClose(() => p.close())
        const rpc = createRpcPeer(channel)
        const info = await rpc.call('host.info', {})
        if (info.identity.signPub !== rec.peer.signPub) {
          rpc.close()
          throw new PairError('forbidden', 'The host identity changed')
        }
        const { pendingGrant: _done, ...rest } = rec
        await o.store.put({ ...rest, rights: info.rights, lastSeenAt: env.now() })
        if (rec.pendingGrant) notify()
        return connection(pairingId, rpc, info, t.via)
      } catch (e) {
        pipe?.close()
        // A version mismatch will not clear on another route: stop and say which side to update.
        if (e instanceof SessionError && e.code === 'outdated') throw new PairError('not_supported', e.message)
        lastError = e
      }
    }
    throw lastError instanceof PairError ? lastError : new PairError('unavailable', 'The host is not reachable')
  }

  function connection(pairingId: string, rpc: RpcPeer, info: HostInfo, via: 'lan' | 'relay'): HostConnection {
    const closers = new Set<() => void>()
    const finished = new Map<string, { ok: true; slice: SliceSummary } | { ok: false; message: string }>()
    const waiters = new Map<string, (r: { ok: true; slice: SliceSummary } | { ok: false; message: string }) => void>()
    let closed = false

    const offEvents = rpc.onEvent((ev, data) => {
      if (ev === 'slice.done' || ev === 'slice.failed') {
        const d = data as EventMap['slice.done'] | EventMap['slice.failed']
        const id = 'slice' in d ? d.slice.sliceId : d.sliceId
        const r = 'slice' in d ? ({ ok: true, slice: d.slice } as const) : ({ ok: false, message: d.message } as const)
        const w = waiters.get(id)
        if (w) {
          waiters.delete(id)
          w(r)
        } else {
          finished.set(id, r)
          if (finished.size > 32) finished.delete(finished.keys().next().value ?? '')
        }
      }
      if (ev === 'pairing.revoked') {
        void o.store.delete(pairingId).then(notify)
        conn.close()
      }
    })

    async function upload(file: UploadFile & { kind: string; stats?: object }, onProgress?: (f: number) => void) {
      const digest = toHex(sha256(file.data))
      const begin = await rpc.call('upload.begin', {
        name: file.name,
        kind: file.kind as 'gcode',
        size: file.data.byteLength,
        sha256: digest,
        ...(file.stats ? { stats: file.stats } : {}),
        ...(file.printerId ? { printerId: file.printerId } : {}),
      })
      for (let off = 0; off < file.data.byteLength; off += begin.chunkBytes) {
        const chunk = file.data.subarray(off, Math.min(off + begin.chunkBytes, file.data.byteLength))
        await rpc.call('upload.chunk', { uploadId: begin.uploadId, offset: off, data: toB64url(chunk) })
        onProgress?.(Math.min(1, (off + chunk.byteLength) / file.data.byteLength))
      }
      return rpc.call('upload.finish', { uploadId: begin.uploadId }, 60_000)
    }

    const conn: HostConnection = {
      info,
      via,
      printers: () => rpc.call('printers.list', {}),
      fleets: () => rpc.call('fleets.list', {}),
      status: (printerId) => rpc.call('printers.status', { printerId }),
      async watch(printerId, cb) {
        const { watchId } = await rpc.call('printers.watch', { printerId })
        const off = rpc.onEvent((ev, d) => {
          if (ev === 'printer' && (d as EventMap['printer']).watchId === watchId) cb((d as EventMap['printer']).event)
        })
        return () => {
          off()
          void rpc.call('printers.unwatch', { watchId }).catch(() => {})
        }
      },
      async snapshot(printerId) {
        const r = await rpc.call('printers.snapshot', { printerId })
        const data = r ? fromB64url(r.dataB64) : null
        return r && data ? { contentType: r.contentType, data } : null
      },
      camera: {
        open: (printerId, o) => rpc.call('camera.open', { printerId, quality: o.quality }),
        rtc: (printerId, offer) => rpc.call('camera.rtc', { printerId, sdp: offer }),
        setQuality: (stream, quality) => rpc.call('camera.quality', { stream, quality }),
        close: async (stream) => void (await rpc.call('camera.close', { stream })),
        onFrame: (cb) => conn.on('camera.frame', cb),
        onStats: (cb) => conn.on('camera.stats', cb),
        onEnded: (cb) => conn.on('camera.ended', cb),
      },
      grab: (printerId) => rpc.call('camera.grab', { printerId }, 30_000),
      push: {
        register: async (reg) => void (await rpc.call('push.register', reg)),
        unregister: async (token) => void (await rpc.call('push.unregister', { token })),
      },
      library: () => rpc.call('library.list', {}),
      async slice(req, onProgress) {
        const off = onProgress
          ? rpc.onEvent((ev, d) => {
              if (ev === 'slice.progress') {
                const p = d as EventMap['slice.progress']
                if (p.sliceId === sliceId) onProgress(p.stage, p.fraction)
              }
            })
          : () => {}
        let sliceId = ''
        try {
          sliceId = (await rpc.call('slice.start', req)).sliceId
          const early = finished.get(sliceId)
          const r =
            early ??
            (await new Promise<{ ok: true; slice: SliceSummary } | { ok: false; message: string }>((resolve) => {
              waiters.set(sliceId, resolve)
              closers.add(() => resolve({ ok: false, message: 'The connection closed' }))
            }))
          finished.delete(sliceId)
          if (!r.ok) throw new PairError('failed', r.message)
          return r.slice
        } finally {
          off()
        }
      },
      async uploadSlice(file, onProgress) {
        const r = await upload(file, onProgress)
        if (!r.slice) throw new PairError('failed', 'The host did not keep the file')
        return r.slice
      },
      async uploadModel(file, onProgress) {
        return (await upload(file, onProgress)).blobId
      },
      send: (req) => rpc.call('jobs.send', req),
      startFile: (fileRef, opts) => rpc.call('jobs.start', { fileRef, ...(opts ? { opts } : {}) }),
      control: (printerId, action) => rpc.call('jobs.control', { printerId, action }),
      approvals: () => rpc.call('approvals.list', {}),
      quota: () => rpc.call('remote.quota', {}),
      async approve(v, o) {
        await rpc.call('approvals.decide', signDecision(me, v.request, 'approve', env.now(), o?.bedClear === true))
      },
      async deny(v) {
        await rpc.call('approvals.decide', signDecision(me, v.request, 'deny', env.now()))
      },
      on(event, cb) {
        return rpc.onEvent((ev: EventName, d: unknown) => {
          if (ev === (event as EventName)) cb(d as EventMap[typeof event])
        })
      },
      onJob(cb) {
        return conn.on('job', cb)
      },
      onClose(cb) {
        closers.add(cb)
        return () => closers.delete(cb)
      },
      close() {
        if (closed) return
        closed = true
        offEvents()
        rpc.close()
        live.get(pairingId)?.delete(conn)
        for (const cb of [...closers]) cb()
      },
    }
    let set = live.get(pairingId)
    if (!set) live.set(pairingId, (set = new Set()))
    set.add(conn)
    rpcOf.set(conn, rpc)
    return conn
  }

  /** Sends `pairing.revoke` to the host; true once the host confirmed it. Closes every session. */
  async function tellHost(pairingId: string): Promise<boolean> {
    let ok = false
    try {
      const conn = [...(live.get(pairingId) ?? [])][0] ?? (await connect(pairingId, { removing: true }))
      const rpc = rpcOf.get(conn)
      if (rpc) {
        await rpc.call('pairing.revoke', {}, 5000)
        ok = true
      }
    } catch {
      ok = false
    }
    for (const c of [...(live.get(pairingId) ?? [])]) c.close()
    return ok
  }

  let lastRetry = 0
  async function retryRemovals(): Promise<number> {
    lastRetry = env.now()
    let left = 0
    for (const r of await o.store.list()) {
      if (!r.pendingRevoke) continue
      if (await tellHost(r.pairingId)) await o.store.delete(r.pairingId)
      else left += 1
    }
    notify()
    return left
  }

  return {
    identity: me.public,
    async pair(input) {
      const parsed = parsePairingInput(input, {
        relays: o.relays,
        ...(o.linkBases ? { bases: o.linkBases } : {}),
        ...(o.defaultRelay ? { defaultRelay: o.defaultRelay } : {}),
      })
      if (parsed.kind === 'invalid') throw new PairError('bad_request', parsed.reason)
      const offer = parsed.offer
      if (offer.expiresAt !== undefined && env.now() > offer.expiresAt) throw new PairError('bad_request', 'This pairing code has expired. Show a new one.')
      const routes = offerRoutes(offer.offerId)
      for (const url of offer.endpoints.lan) {
        try {
          return flow(await openLan(url), offer)
        } catch {
          // Not on the same network; try the next address, then the relay.
        }
      }
      const relay = await relayFor(offer.endpoints.relay)
      return flow(relayPipe(relay, routes.joiner, routes.offerer), offer)
    },
    async joinAccount() {
      if (!accountId) throw new PairError('forbidden', 'Sign in first')
      const relay = await relayFor(o.defaultRelay)
      const offerId = env.random(16)
      const offer: OfferInfo = { offerId, secret: null, endpoints: { lan: [], ...(o.defaultRelay ? { relay: o.defaultRelay } : {}) } }
      return flow(accountJoinPipe(relay, accountId, offerId), offer, { timeoutMs: OFFER_TTL_MS })
    },
    watchJoinRequests(relay, cb) {
      if (!accountId) return () => {}
      const acct = accountId
      return watchAccountJoins(env, relay, acct, (req) => {
        cb({
          requestId: req.requestId,
          name: req.name,
          platform: req.platform,
          async review() {
            const hosts = (await o.store.list()).filter((r) => r.rights.introduce && r.accountId === acct && !r.pendingGrant && !r.pendingRevoke)
            if (hosts.length === 0) return null
            const attempt = req.review({
              identity: me,
              buildConfirm: async (joiner) => ({
                rights: NO_RIGHTS,
                accountId: acct,
                grants: hosts.map((h) =>
                  issueGrant(env, me, { accountId: acct, subject: joiner.identity, host: { identity: h.peer, endpoints: h.endpoints ?? { lan: [] } }, rights: h.rights }),
                ),
              }),
            })
            if (!attempt) return null
            return {
              sas: attempt.sas,
              confirm: () => attempt.confirm(),
              reject: () => attempt.reject('mismatch'),
              result: attempt.result.then((r): PairingOutcome => (r.ok ? { ok: true, hosts: [] } : { ok: false, reason: r.reason })),
            }
          },
        })
      })
    },
    async hosts() {
      const list = await o.store.list()
      // Removals that could not reach their host are retried now and then, not on every read.
      if (list.some((r) => r.pendingRevoke) && env.now() - lastRetry > RETRY_EVERY_MS) void retryRemovals().catch(() => undefined)
      return list.map(view)
    },
    connect: (pairingId, opts) => connect(pairingId, opts?.via ? { via: opts.via } : {}),
    async unpair(pairingId) {
      const rec = (await o.store.list()).find((r) => r.pairingId === pairingId)
      if (!rec) return { removedOnHost: true }
      const told = await tellHost(pairingId)
      if (told) await o.store.delete(pairingId)
      else await o.store.put({ ...rec, pendingRevoke: true })
      notify()
      return { removedOnHost: told }
    },
    retryRemovals,
    setAccount(id) {
      accountId = id
      notify()
    },
    onHostsChanged(cb) {
      changed.add(cb)
      return () => changed.delete(cb)
    },
  }

}

const rpcOf = new WeakMap<HostConnection, RpcPeer>()
/** How often `hosts()` retries removals that did not reach their host. */
const RETRY_EVERY_MS = 60_000
