// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @slicerx/link-client. A PrinterHost that talks to sx-link over its
// localhost WebSocket. The protocol is documented in packages/connect/link/README.md.
import { pakeStart } from './cpace.ts'
import type {
  ApprovalHost,
  ApprovalRequest,
  ApprovalToken,
  DiscoveredPrinter,
  Fleet,
  FleetOptions,
  JobFile,
  PluginManifest,
  PrinterConfig,
  PrinterError,
  PrinterErrorCode,
  PrinterEvent,
  PrinterHardware,
  PrinterHost,
  PrinterInfo,
  PrinterState,
  PrinterStatus,
  RemoteFile,
  SlotSetting,
  FilamentSlot,
  StartOptions,
} from '@slicerx/contracts'

export type LinkErrorCode = PrinterErrorCode | 'bad_request' | 'unauthorized' | 'locked' | 'closed' | 'hub_identity' | 'forbidden'

/** Every failure a link call can report. Carries the `PrinterError` shape. */
export { avcCodecString, createCanvasRenderer, linkCameraStreams } from './camera.ts'
export type { CameraSession, CameraStreams, Renderer, StreamStats } from './camera.ts'
export { pakeAnswer, pakeStart, PAKE_ROLES, type PakeContext, type PakeRole } from './cpace.ts'

export class LinkError extends Error implements Omit<PrinterError, 'code'> {
  readonly code: LinkErrorCode
  /**
   * With `hub_identity` for a pinned hub: the key the program on the port signed this connection with, when its
   * signature verified. The app shows its fingerprint so the person can compare it with `sx-link code` before
   * trusting it. Nothing was sent to that program.
   */
  readonly presentedKey?: string
  constructor(code: LinkErrorCode, message: string, presentedKey?: string) {
    super(message)
    this.name = 'LinkError'
    this.code = code
    if (presentedKey) this.presentedKey = presentedKey
  }
}

/** A file the cloud inbox delivered to the bridge and that waits for the user's approval. */
export interface InboxDelivery {
  deliveryId: string
  jobId: string
  /** The bridge's printer id (the cloud's `printerLocalId`). */
  printerId: string
  fileName: string
  sha256: string
  bytes: number
  stats: { timeS?: number; filamentG?: number } | null
  /** `awaiting_approval` when listed. Events also report `uploaded`, `printing`, `declined` and `failed`. */
  state: 'awaiting_approval' | 'uploaded' | 'printing' | 'declined' | 'failed'
  message?: string
}

export interface LinkInbox {
  list(): Promise<InboxDelivery[]>
  decline(deliveryId: string): Promise<void>
  /** Called for each new delivery and each state change. Returns an unsubscribe function. */
  onDelivery(cb: (d: InboxDelivery) => void): () => void
  /**
   * Uploads a delivered file to its printer. The approval token must cover `printer.upload` with
   * `{printerId, name, sha256}` of the delivery; then call `start` with the returned file.
   */
  uploadDelivery(printerId: string, deliveryId: string, token: ApprovalToken): Promise<RemoteFile>
}

/** Where a printer test got to. `ok: null` means the step never ran because an earlier one failed. */
export interface PrinterTestStep {
  id: 'reach' | 'sign_in' | 'read_state' | 'read_temperatures'
  ok: boolean | null
}

/**
 * The outcome of `testPrinter`. `cause` is one of `unreachable` (nothing answered: wrong address or
 * port, printer off, blocked), `auth` (it answered and refused the code or key), `timeout`,
 * `protocol` (it answered something unexpected), `not_supported` or `bad_request` (not a local address).
 * The bridge cannot tell LAN mode being off, a wrong port or a certificate problem from `unreachable`.
 */
export type AuthNeed = 'not_trusted' | 'key_wrong' | 'login_required'

export interface PrinterTestResult {
  ok: boolean
  state?: PrinterState
  cause?: 'unreachable' | 'auth' | 'timeout' | 'protocol' | 'not_supported' | 'bad_request'
  message?: string
  /** On a failure: the words to show are keyed by this (`tls`, `auth`, `timeout` or `other`), never by `message`. */
  kind?: 'tls' | 'auth' | 'timeout' | 'other'
  /** On a failure: the raw error, for Copy details and reports only. */
  details?: string
  /** Bambu Lab: whether Bambu Lab's CA issued the printer's certificate for its serial. Recorded, never refusing. */
  certificate?: { verified: boolean; detail: string }
  /** A refused sign-in, when the printer said why (Moonraker): no key and not trusted, a wrong key, or a user login required. */
  authNeed?: AuthNeed
  steps: PrinterTestStep[]
  /** First nozzle and bed temperature, rounded, after a passing test. */
  nozzleC?: number
  bedC?: number
  /** What the printer reported about itself: model, firmware, nozzles and filament units. */
  hardware?: PrinterHardware
}

export type { DiscoveredPrinter }

/**
 * What the hub knows about a printer's build plate. `clear`: someone confirmed the plate was
 * removed and no job ran since. `not_cleared`: the last job ended and nobody confirmed it.
 * `unknown`: never watched, or the hub was not watching for a while. `busy`: a job is running.
 */
export type BedStateName = 'clear' | 'not_cleared' | 'unknown' | 'busy'

export interface BedInfo {
  printerId: string
  state: BedStateName
  /** True when a local Print click must ask "Is the build plate clear?" first. False only for `clear`. */
  askOnPrint: boolean
  /** The job the printer last reported. */
  lastJob?: string
  /** When the last job was seen ending, ISO 8601. */
  endedAt?: string
  /** When someone last confirmed the plate clear, ISO 8601. */
  confirmedAt?: string
  /** Moves whenever a job starts or the printer went unwatched. `device.skipObject` sends the one read with the list. */
  epoch: number
}

export interface LocalPrintResult {
  file: RemoteFile
  started: true
  bed: BedInfo
}

export type QueueItemState = 'waiting' | 'awaiting_approval' | 'approved' | 'needs_bed' | 'started' | 'expired' | 'canceled' | 'failed'

/** A plate the hub holds and starts itself, with the app closed. */
export interface QueueItem {
  id: string
  printerId: string
  name: string
  kind: JobFile['kind']
  sha256: string
  bytes: number
  opts: StartOptions
  title?: string
  /** Scheduled start, ISO 8601 (and `startAfterMs`). Absent: start when its turn comes. */
  startAfter?: string
  startAfterMs?: number
  addedAt: string
  state: QueueItemState
  message?: string
  /** The approval card waiting for an answer. */
  requestId?: string
  /** Until when the standing approval holds, ISO 8601. */
  approvedUntil?: string
}

/**
 * Something the phone should hear about. `finished`, `failed`, `canceled`, `paused` (the printer
 * may have paused itself, such as a filament runout) and `error` come from the printer's state;
 * `approval_waiting` when the hub raised a card (`requestId`).
 */
export interface HubAlert {
  printerId: string
  kind: 'finished' | 'failed' | 'canceled' | 'paused' | 'error' | 'approval_waiting'
  at: string
  jobName?: string
  message?: string
  requestId?: string
}

/** The opt-in LAN listener for phones: a byte pipe, all pairing cryptography stays in the app. */
export interface LinkPair {
  /**
   * Starts or stops the listener (`0.0.0.0`, `/pair` only). Stopping closes every phone connection.
   * Starting resolves with the port and this machine's addresses for the QR code: private IPv4 first,
   * then link-local IPv6 with the interface as zone (`fe80::1%en0`). Loopback and tunnels are left out.
   * `advertised` is true when the listener is also announced as `_slicerx._tcp` over mDNS, so a phone can
   * find it without the addresses. The announcement stops with the listener.
   */
  listen(enabled: boolean, port?: number): Promise<{ listening: boolean; port?: number; addresses?: string[]; advertised?: boolean }>
  /** Sends a text frame (at most 1.5 MB) to one phone connection. */
  send(conn: string, frame: string): Promise<void>
  close(conn: string): Promise<void>
  /** A text frame from a phone. Returns an unsubscribe function. */
  onFrame(cb: (conn: string, frame: string) => void): () => void
  /** A phone connection ended. Returns an unsubscribe function. */
  onClosed(cb: (conn: string) => void): () => void
}

/** One camera frame as the bridge sends it. H.264 is Annex B (start code delimited NAL units). */
export interface CameraFrame {
  kind: 'jpeg' | 'h264'
  /** Decoding can start here. Always true for JPEG. */
  key: boolean
  stream: number
  /** Bridge clock, milliseconds since the epoch, when the frame arrived from the printer. */
  capturedAt: number
  data: Uint8Array
}

/**
 * What a stream's camera feed is doing (`camera.status`). `retrying`: the camera dropped the
 * connection or stopped, and the bridge tries again in `retryInMs` (try `attempt`, `reason` in
 * plain words), for as long as the stream is open. `live`: the camera is open. `failed`: it will not
 * open by waiting (`reason`); the stream ends.
 */
export interface CameraStatus {
  state: 'live' | 'retrying' | 'failed'
  attempt?: number
  retryInMs?: number
  reason?: string
}

/** What the bridge is doing for one stream, about once a second. */
export interface CameraStats {
  fps: number
  kbps: number
  /** Frames the bridge dropped because this client was behind. */
  dropped: number
  /** The quality in force. The bridge lowers it on its own when the client falls behind. */
  quality: 'low' | 'medium' | 'high'
}

export interface CameraProbe {
  ok: boolean
  kind: 'jpeg' | 'h264' | null
  firstFrameMs: number | null
  fps: number
  kbps: number
  /** A quality to start the player at. */
  recommended: 'low' | 'medium' | 'high'
}

export interface CameraHandle {
  readonly stream: number
  /** The quality in force when the stream opened. */
  readonly quality: 'low' | 'medium' | 'high'
  onFrame(cb: (f: CameraFrame) => void): () => void
  onStats(cb: (s: CameraStats) => void): () => void
  /** The source ended (camera off, printer gone). */
  onEnded(cb: () => void): () => void
  /** The feed's state now, then each change. */
  onStatus(cb: (s: CameraStatus) => void): () => void
  /** `auto` starts high and lets the bridge step down when this client cannot keep up. */
  setQuality(q: 'low' | 'medium' | 'high' | 'auto'): Promise<void>
  /** `reason`, in plain words, goes to the bridge's connection log. */
  close(reason?: string): Promise<void>
}

/** An ONVIF camera heard on the local network. `cameraUrl` goes into a printer's `PrinterConfig.cameraUrl`. */
export interface DiscoveredCamera {
  host: string
  port: number
  name?: string
  hardware?: string
  cameraUrl: string
}

export interface LinkCamera {
  /**
   * Scans the local network for ONVIF cameras (a WS-Discovery probe). Only call it when the user starts
   * a scan. `timeoutMs` is 300 to 10000 (default 3000).
   */
  discover(timeoutMs?: number): Promise<DiscoveredCamera[]>
  /** Rejects with `not_supported` when the printer has no camera stream. */
  /**
   * `jpegOnly` is for clients that cannot decode H.264 (the phone, through the app): the hub decodes
   * key frames of H.264 cameras to JPEG and leaves the other frames out, or ends the stream with
   * `reason: "codec"` where it has no decoder.
   */
  open(printerId: string, opts?: { quality?: 'low' | 'medium' | 'high' | 'auto'; jpegOnly?: boolean }): Promise<CameraHandle>
  /** Looks at the camera without streaming to the client. */
  probe(printerId: string, windowMs?: number): Promise<CameraProbe>
  /**
   * Passes a WebRTC offer (video, recvonly, ICE candidates already gathered) to the printer's camera
   * service and returns its answer SDP. Only the signaling goes through the bridge; media flows between
   * the browser and the camera directly, so it works only where the browser can reach the printer.
   * Rejects with `not_supported` when the camera has no WebRTC service.
   */
  webrtc(printerId: string, offerSdp: string): Promise<string>
  /**
   * One still for the assistant or a failure detector: the printer's snapshot when it has one, else
   * the first JPEG frame of its live stream. Null when the printer has no camera; rejects with
   * `not_supported` for a camera that sends only H.264 and has no snapshot.
   */
  grab(printerId: string): Promise<CameraStill | null>
}

export interface CameraStill {
  contentType: string
  data: Uint8Array
  /** ISO 8601 UTC. */
  capturedAt: string
  source: 'snapshot' | 'stream'
}

/** One change to a running print. The hub refuses values outside the safe limits (`adjust.limits`). */
export type PrintAdjustment =
  | { kind: 'fan'; fan: 'part' | 'aux' | 'chamber'; percent: number }
  | { kind: 'speed'; percent: number }
  | { kind: 'nozzle'; celsius: number }
  | { kind: 'bed'; celsius: number }

/** What a change may be on this printer right now. `null` ranges cannot be changed now. */
export interface AdjustLimits {
  running: boolean
  fan: { fans: ('part' | 'aux' | 'chamber')[]; min: 0; max: 100 }
  speed: { min: number; max: number } | { levels: number[] }
  nozzle: { min: number; max: number } | null
  bed: { min: number; max: number } | null
}

/** A file stored on the printer. `modified` is seconds since the epoch. */
export interface StoredFile {
  path: string
  name: string
  size?: number
  modified?: number
}

/** One print from the printer's own history. */
export interface PrintRecord {
  name: string
  outcome: 'completed' | 'canceled' | 'failed'
  detail?: string
  startedAt?: number
  durationS?: number
  filamentMm?: number
}

/** An object of the running print that can be skipped. `id` is what `skip` takes. */
export interface PrintObject {
  id: string
  name: string
  skipped: boolean
  center?: [number, number]
  polygon?: [number, number][]
}

/** What the printer reports as wrong, in plain words. */
export interface PrinterIssue {
  code: string
  severity: 'fatal' | 'serious' | 'common' | 'info'
  module: string
  text: string
  /** Where the maker explains this code. */
  helpUrl?: string
  /** Left over from a job that is no longer running: history, not a problem now. */
  stale?: boolean
}

/** A still the print watch hands a failure detector while a printer prints. */
export interface WatchFrame {
  subscription: number
  printerId: string
  /** The printer's state, layer and layer count when the frame was taken, so a detector needs no status calls. */
  state?: string
  layer?: number | null
  layerCount?: number | null
  contentType: string
  data: Uint8Array
  capturedAt: string
  source: 'snapshot' | 'stream'
}

/** Work an agent's person-only card carries; the hub runs it after a person approves. */
export type AgentWork =
  | { kind: 'print'; printerId: string; file: JobFile; opts?: StartOptions }
  | { kind: 'resume'; printerId: string }
  | { kind: 'gcode'; printerId: string; line: string }
  | { kind: 'adjust'; printerId: string; change: PrintAdjustment }

export interface ApprovalDone {
  requestId: string
  printerId: string
  ok: boolean
  code?: string
  message?: string
}

/** Which alerts a phone wants pushed. Same names as the phone's notification settings. */
export interface PushPrefs {
  printDone: boolean
  printFailed: boolean
  attention: boolean
  approvals: boolean
}

/**
 * Phone alerts while the app is closed. The hub posts them to Expo with fixed text that names no
 * file, model or printer; `data` carries `{kind, printerId?, requestId?}` for routing a tap.
 */
export interface HubSettings {
  experimentalConnectors: boolean
  /** Printers the watch may pause on its own when a detector is at least 80 % sure. Set with `watch.setAutoPause`. */
  watchAutoPausePrinters: string[]
  /** Bed masks per printer. Set with `watch.setMask`. */
  watchMasks: Record<string, [number, number][]>
}

export interface LinkPush {
  /** `token` is the phone's Expo push token. `tag` is an opaque id (the pairing id) for `unregister({tag})`. */
  register(reg: { token: string; platform: 'ios' | 'android'; prefs: PushPrefs; tag?: string }): Promise<void>
  /** Removes by token, or every registration with the tag (a revoked pairing). Resolves with the count. */
  unregister(by: { token?: string; tag?: string }): Promise<number>
  /** Tokens are not returned, only their last six characters. */
  list(): Promise<{ tokenEnd: string; platform: 'ios' | 'android'; prefs: PushPrefs; tag?: string; createdAt: string }[]>
}

/** A device's public pair identity (`PublicIdentity` in packages/pair). */
export interface PairIdentity {
  deviceId: string
  name: string
  platform: string
  signPub: string
  dhPub: string
}

/** The relay's answer to `quota`: bytes this UTC month, sent plus received. */
export interface RemoteQuota {
  tier: 'account' | 'anonymous'
  used: number
  cap: number
  resetsAt: number
  connections: number
  maxConnections: number
  framesPerSecond?: number
  bytesPerMinute?: number
  maxBody?: number
}

export interface RemoteStatus {
  enabled: boolean
  relay: string | null
  connected: boolean
  sessions: number
  pairings: number
  lastError: string | null
  /** The relay accepted the account session: the account's limits and monthly cap apply. */
  signedIn: boolean
  quota: RemoteQuota | null
}

/** What a remote agent needs, from `clients.create(name, 'agent', { remote: true })`. Shown once. */
export interface RemoteAgentAccess {
  pairingId: string
  deviceKey: string
  relay: string | null
  host: PairIdentity | null
  hubKey: string
}

export interface LinkHost extends PrinterHost {
  /** Live camera video. Streams end when this connection closes. */
  camera: LinkCamera
  /** Phone pairing over the LAN. The listener stops when this connection closes. */
  pair: LinkPair
  /** Cloud deliveries. Errors with `not_supported` when the bridge runs without `--inbox-url`. */
  inbox: LinkInbox
  /**
   * The bridge's approval broker. `grant` belongs in the approval card's button handler and
   * nowhere else; the bridge trusts a paired client to keep to that.
   */
  approvals: ApprovalHost & {
    /**
     * Grant from the approval card, saying whether the card asked "Is the build plate clear?" and
     * the person said yes. Starts from a card (Pilot, MCP, phone, inbox, queue, schedule) are refused
     * with `bed_check` without it. A card the hub raised for a queued or scheduled plate resolves to
     * `{queued: true}` instead of a token: the hub keeps the approval and starts the plate itself.
     */
    grantWith(requestId: string, opts: { bedClear: boolean }): Promise<ApprovalToken | { queued: true; itemId: string; notBefore: string; approvedUntil: string }>
    /** Cards waiting for an answer, including the ones the hub raised. */
    pending(): Promise<ApprovalRequest[]>
    /** A card the hub raised (queued plate whose turn came, scheduled plate). */
    onRequest(cb: (r: ApprovalRequest) => void): () => void
    /**
     * For agents (MCP): registers a card that only a person may answer (start, resume, G-code,
     * adjust) together with its work. The hub checks that the card's actions are exactly the work's,
     * shows the card in the app and on phones, and runs the work itself once a person approves; the
     * agent never gets the token. Watch `onApprovalDone` for the outcome.
     */
    registerWork(request: ApprovalRequest, work: AgentWork): Promise<{ registered: true; answeredIn: 'app' | 'here' }>
  }
  /** How agent work ended after a person answered its card (`approvals.registerWork`). */
  onApprovalDone(cb: (d: ApprovalDone) => void): () => void
  /**
   * The person pressed Print in the Print sheet: uploads and starts in one call, with no approval
   * card (the click is the approval). Rejects with `LinkError('bed_check')` when the sheet has to ask
   * "Is the build plate clear?" first (check `bed.state(printerId).askOnPrint` to ask up front);
   * call again with `bedClear: true` once the person says yes. Rejects with `busy` while a job runs.
   */
  printLocal(printerId: string, file: JobFile, opts?: StartOptions, bedClear?: boolean, objects?: PrintObject[]): Promise<LocalPrintResult>
  bed: {
    state(printerId: string): Promise<BedInfo>
    /** "Plate removed": the person cleared the plate. Rejects with `busy` while a job runs. */
    confirmClear(printerId: string): Promise<BedInfo>
    onChange(cb: (b: BedInfo) => void): () => void
  }
  /** Plates the hub starts itself: queued (approved on their turn) or scheduled (approved now). */
  queue: {
    /** `startAfter` (ISO 8601 UTC, up to 7 days ahead) schedules it; the result then carries the card to show now. */
    add(printerId: string, file: JobFile, opts?: { startOptions?: StartOptions; startAfter?: string; title?: string }): Promise<{ item: QueueItem; request?: ApprovalRequest }>
    list(): Promise<QueueItem[]>
    remove(id: string): Promise<void>
    onChange(cb: (item: QueueItem | { id: string; removed: true }) => void): () => void
  }
  /** Alerts for push notifications: job finished, failed, paused, a card waiting. */
  onAlert(cb: (a: HubAlert) => void): () => void
  /** Phone push registrations (Expo). */
  push: LinkPush
  /**
   * Remembered clients (Settings, Devices), app only. `create` makes a key for an AI agent or a
   * failure detector: it is in this reply once and never again. `revoke` also closes the client's
   * open connections.
   */
  clients: {
    /** `clientKey` for a local client; a remote agent (`remote: true`) gets only `remote`, its relay pairing. */
    create(name: string, role: 'agent' | 'watch', opts?: { remote?: boolean }): Promise<{ clientId: string; clientKey?: string; role: 'agent' | 'watch'; remote?: RemoteAgentAccess }>
    list(): Promise<{ id: string; name: string; role: 'app' | 'agent' | 'watch'; createdAt: string; lastSeenAt: string }[]>
    revoke(clientId: string): Promise<void>
  }
  /**
   * Remote access, app only: the hub answers paired phones and remote agents over the relay, also
   * while the app is closed. `configure` needs a `wss://` relay and the app's pair identity, which
   * phones pinned. While it is on, the app's own pair host must not answer the pairing routes.
   */
  remote: {
    status(): Promise<RemoteStatus>
    /** `hostDh` is the identity's static X25519 secret (base64url); session keys mix it in, so the hub needs it to answer phones. */
    configure(o: { enabled: boolean; relay?: string; host?: PairIdentity; hostDh?: string }): Promise<RemoteStatus>
    /** Asks the relay for a fresh quota; the status as it stands (the new quota follows shortly). */
    quota(): Promise<RemoteStatus>
    /**
     * A relay token for the relay's account tier: a short-lived JWT with audience `sx-relay`, minted
     * for the signed-in account by the backend (`relayTokenSource` in @slicerx/pair). Never the
     * account's own session: the hub refuses any other audience. The hub keeps it in the secret
     * store and never returns it; call again with each fresh token, and with null on sign-out (the
     * hub then uses the anonymous tier and reports `signedIn: false` at once).
     */
    setToken(token: string | null): Promise<RemoteStatus>
    /** The relay's quota as the hub hears it: on connect, every five minutes and after `quota()`. */
    onQuota(cb: (q: RemoteQuota) => void): () => void
    pairings: {
      put(p: { pairingId: string; deviceKey: string; kind: 'phone' | 'agent'; peer: PairIdentity; rights?: { request?: boolean; approve?: boolean } }): Promise<{ saved: boolean }>
      remove(pairingId: string): Promise<{ removed: boolean }>
      list(): Promise<{ pairingId: string; kind: 'phone' | 'agent'; peer: PairIdentity; rights: { request: boolean; approve: boolean }; addedAt: number; clientId?: string }[]>
      /**
       * The app's full list of phone pairings: the hub removes every phone pairing not in it (agents stay).
       * An empty list is refused while the hub holds phones unless `removeAll` is set, so a pair store that
       * did not open cannot unpair every phone.
       */
      sync(pairingIds: string[], opts?: { removeAll?: boolean }): Promise<{ removed: string[] }>
    }
    /** A phone removed itself over the relay (`pairing.revoke`); forget it here too. */
    onPairingRevoked(cb: (pairingId: string) => void): () => void
  }
  /**
   * The device page. `files`, `history`, `issues` and `objects` only read. `jog`, `skipObject` and
   * `startFile` are for the app (an agent or the watch gets `forbidden`, and over remote access they
   * are `not_supported`). `jog` moves the head 0.1 to 10 mm while the printer is idle and rejects
   * with `out_of_range` outside the limits, `not_homed` for an unhomed axis, `position_unknown` for Z
   * down on a printer that does not report the head position, and `bed_check` for Z down over a
   * finished print. `skipObject` needs a running print and the bed `epoch` read with the list
   * (`job_changed` when another print started since). On printers that cannot list objects (Bambu
   * Lab), `objects` lists the plate `printLocal` sent with `objects`, and is `not_supported` for
   * prints sent some other way. `startFile` prints a
   * file already on the printer: it rejects with `unverified_file` for a file this hub did not
   * upload until called again with `unverifiedOk: true`, and with `bed_check` like `printLocal`.
   */
  device: {
    files(printerId: string): Promise<StoredFile[]>
    history(printerId: string): Promise<PrintRecord[]>
    issues(printerId: string): Promise<PrinterIssue[]>
    objects(printerId: string): Promise<PrintObject[]>
    jog(printerId: string, axis: 'x' | 'y' | 'z', distanceMm: number, feedMmMin?: number): Promise<void>
    skipObject(printerId: string, id: string, epoch: number): Promise<void>
    startFile(printerId: string, path: string, o?: { opts?: StartOptions; bedClear?: boolean; unverifiedOk?: boolean }): Promise<LocalPrintResult>
  }
  /**
   * Changes to a running print. `apply` needs a token from a card with a `printer.adjust` action
   * whose params are `{printerId, change}`; values outside `limits` are refused with `out_of_range`.
   */
  adjust: {
    limits(printerId: string): Promise<AdjustLimits>
    apply(printerId: string, change: PrintAdjustment, token: ApprovalToken): Promise<void>
    /**
     * Writes a filament slot to the printer (Bambu Lab AMS), with a token from a card whose `printer.adjust` params are
     * `{printerId, slot}`. App connections only, and not while a print runs. Answers the slot as the printer reports it
     * afterwards, and whether that report shows the change yet.
     */
    setSlot(printerId: string, setting: SlotSetting, token: ApprovalToken): Promise<{ slot?: FilamentSlot; shown: boolean }>
    /** Turns the chamber light on or off. App connections only; like the switch on the printer's screen, it asks no approval. */
    light(printerId: string, on: boolean): Promise<void>
  }
  /** The print watch: frames for failure detectors, and their findings. */
  watch: {
    /** Calls `onFrame` with a still of each printing printer every `everyMs` (2000 to 120000, default 10000). */
    subscribe(onFrame: (f: WatchFrame) => void, opts?: { everyMs?: number; printerIds?: string[] }): Promise<() => void>
    /**
     * A detector saw something. Pauses the print only when huginn confirmed it (`confirmed: true`),
     * confidence is at least 0.8 and the person turned on watchAutoPause; otherwise it notifies.
     */
    report(f: { printerId: string; kind: 'spaghetti' | 'first_layer' | 'detached' | 'nozzle_blob' | 'other'; confidence: number; confirmed?: boolean; note?: string }): Promise<{ paused: boolean }>
    onFinding(cb: (f: { printerId: string; kind: string; confidence: number; confirmed?: boolean; note?: string; at: string }) => void): () => void
    /** The printers huginn double-checks. Detectors read it. */
    huginnPrinters(): Promise<string[]>
    /** App only, audited: whether huginn double-checks findings on this printer. */
    setHuginn(printerId: string, enabled: boolean): Promise<void>
    /** Every printer's bed mask: a polygon in 0 to 1 frame coordinates. Detectors read it. */
    masks(): Promise<Record<string, [number, number][]>>
    /** App only: draw or clear (null) a printer's bed mask. */
    setMask(printerId: string, polygon: [number, number][] | null): Promise<void>
    /** App only: the person answered "this is fine"; detectors get `watch.dismissed`. */
    dismiss(printerId: string, kind: string): Promise<void>
    onDismissed(cb: (d: { printerId: string; kind: string; at: string }) => void): () => void
    /** App only: let the watch pause this printer on a failure (standing permission, off by default). */
    setAutoPause(printerId: string, enabled: boolean): Promise<void>
  }
  /** Show and allow the connectors not yet tested on real printers (Duet, Snapmaker, Creality WebSocket, Home Assistant). */
  settings: {
    get(): Promise<HubSettings>
    set(patch: Partial<HubSettings>): Promise<HubSettings>
  }
  /** Register a printer with the bridge. The bridge refuses hosts outside the local network. */
  addPrinter(config: PrinterConfig, info?: Partial<Pick<PrinterInfo, 'vendor' | 'model' | 'nozzleCount' | 'filamentSystem'>>): Promise<PrinterInfo>
  removePrinter(printerId: string): Promise<void>
  /**
   * Scans the local network for printers: Bambu Lab announcements, an mDNS query for Moonraker,
   * OctoPrint and PrusaLink, and Elegoo's UDP broadcast. Only call it when the user starts a scan.
   * `timeoutMs` is 300 to 10000 (default 3000). Hosts off the local network are never returned.
   */
  discover(timeoutMs?: number): Promise<DiscoveredPrinter[]>
  /** Asks one IP address whether a printer is there, without signing in. Empty when nothing answered. */
  probe(host: string, timeoutMs?: number): Promise<DiscoveredPrinter[]>
  /**
   * Tries a printer without registering it or changing anything on it: reach, sign in, read state,
   * read temperatures. The credential must already be in the keychain under `config.credentialRef`.
   * Resolves with the outcome, including failures; it rejects only when the bridge is gone.
   */
  testPrinter(config: PrinterConfig): Promise<PrinterTestResult>
  /**
   * Pairs with a printer that asks for a tap on its own screen (Snapmaker 2.0). Resolves once the
   * user confirmed; the bridge keeps the resulting token in the keychain under the printer's
   * `credentialRef` and never returns it.
   */
  authorizePrinter(printerId: string, timeoutSeconds?: number): Promise<{ stored: boolean }>
  /** Point a service plugin (Spoolman, Home Assistant) at a server on the local network. */
  configureService(pluginId: 'spoolman' | 'home-assistant', baseUrl: string, secretRef?: string): Promise<void>
  /** The configured services: address and whether a keychain secret is named. Never the secret. */
  listServices(): Promise<ServiceEntry[]>
  /** Forgets a service. Resolves false when it was not configured. */
  removeService(pluginId: string): Promise<boolean>
  /** Write only. The bridge stores it in the OS keychain and never sends it back. */
  setSecret(name: string, value: string): Promise<void>
  hasSecret(name: string): Promise<boolean>
  deleteSecret(name: string): Promise<void>
  /** Send a G-code line (needs a `gcode` approval token). */
  sendGcode(printerId: string, line: string, token: ApprovalToken): Promise<void>
  /** The key the hub gave when `remember` was asked. Store it where this client keeps credentials; it is shown once. */
  clientKey?: string
  /** The hub's verified public key. Pin it after a first pairing and pass it as `hubKey` next time. */
  hubKey?: string
  close(): void
}

/** A service plugin the hub is pointed at (`services.list`). */
export interface ServiceEntry {
  pluginId: string
  baseUrl: string
  hasSecret: boolean
}

export interface ConnectOptions {
  /** Default `ws://127.0.0.1:47615`. */
  url?: string
  /**
   * The app code `sx-link` printed (`sx-link code`), or for the MCP server and other tools the agent
   * code (`sx-link code --agent`, or the hub's `agent-code` file). The code decides what this client may do.
   */
  code?: string
  /** Ask for a narrower role than the code gives: `agent` (MCP, tools) or `watch` (a failure detector). */
  role?: 'agent' | 'watch'
  /**
   * The hub's public key (base64 Ed25519): from `hub-key.pub` in its state directory, from the
   * desktop app, or pinned at the first pairing (`host.hubKey`). When set, the client checks the
   * hub's signed `hello` first and sends no code or key to a hub that fails.
   */
  hubKey?: string
  /** A key from an earlier `remember` pairing, used instead of the code. Needs `hubKey`: the key goes only to a hub that proves it. */
  clientKey?: string
  /** Ask the hub for a key so this client can reconnect after a restart without the code. Read it from `host.clientKey`. */
  remember?: { name: string }
  /**
   * A stable id for this app install (letters, digits, `-` and `_`, at most 64). The hub tags the
   * phones this app pairs with it, so a second app on the same hub never removes them in a sync.
   */
  appId?: string
  /** Defaults to the global WebSocket (browsers and Node 22+). */
  WebSocket?: typeof WebSocket
}

interface Pending { resolve(v: unknown): void; reject(e: LinkError): void }
type Listener = (e: PrinterEvent) => void

/** Opens the socket and pairs. Rejects with `LinkError('unauthorized')` for a wrong code. */
export async function connectLink(opts: ConnectOptions): Promise<LinkHost> {
  // A saved key is sent as it is, and it works again on the real hub, so it goes only to a hub that
  // proved the pinned key. Without a pin any program on the port could sign its own hello and keep it.
  if (opts.clientKey && !opts.code && !opts.hubKey) throw new LinkError('hub_identity', 'A saved client key is sent only to a hub whose key is pinned (hubKey). Nothing was sent.')
  const WS = opts.WebSocket ?? globalThis.WebSocket
  const ws = new WS(opts.url ?? 'ws://127.0.0.1:47615')
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new LinkError('unreachable', 'Cannot reach sx-link. Is it running?')), { once: true })
  })

  let nextId = 1
  const pending = new Map<number, Pending>()
  const listeners = new Map<number, Listener>()
  const inboxListeners = new Set<(d: InboxDelivery) => void>()
  const frameListeners = new Set<(conn: string, frame: string) => void>()
  const closedListeners = new Set<(conn: string) => void>()
  const bedListeners = new Set<(b: BedInfo) => void>()
  const queueListeners = new Set<(i: QueueItem | { id: string; removed: true }) => void>()
  const watchFrameListeners = new Set<(d: Record<string, unknown>) => void>()
  const approvalDoneListeners = new Set<(d: ApprovalDone) => void>()
  const dismissedListeners = new Set<(d: { printerId: string; kind: string; at: string }) => void>()
  const quotaListeners = new Set<(q: RemoteQuota) => void>()
  const revokedListeners = new Set<(pairingId: string) => void>()
  const findingListeners = new Set<(f: { printerId: string; kind: string; confidence: number; note?: string; at: string }) => void>()
  const alertListeners = new Set<(a: HubAlert) => void>()
  const requestListeners = new Set<(r: ApprovalRequest) => void>()
  ws.binaryType = 'arraybuffer'
  interface StreamSink { frame: Set<(f: CameraFrame) => void>; stats: Set<(s: CameraStats) => void>; ended: Set<() => void>; status: Set<(s: CameraStatus) => void>; last?: CameraStatus; early: CameraFrame[] }
  const sinks = new Map<number, StreamSink>()
  const sink = (id: number): StreamSink => {
    let k = sinks.get(id)
    if (!k) sinks.set(id, (k = { frame: new Set(), stats: new Set(), ended: new Set(), status: new Set(), early: [] }))
    return k
  }

  ws.addEventListener('message', (m) => {
    if (typeof m.data !== 'string') {
      // A camera frame: 16 byte header, then the payload (see packages/connect/link/src/camera.rs).
      if (!(m.data instanceof ArrayBuffer) || m.data.byteLength < 16) return
      const dv = new DataView(m.data)
      if (dv.getUint8(0) !== 0xc1) return
      const frame: CameraFrame = {
        kind: dv.getUint8(1) === 2 ? 'h264' : 'jpeg',
        key: (dv.getUint8(2) & 1) === 1,
        stream: dv.getUint32(4),
        capturedAt: Number(dv.getBigUint64(8)),
        data: new Uint8Array(m.data, 16),
      }
      const k = sink(frame.stream)
      if (k.frame.size === 0) {
        // Frames can beat the caller to onFrame by a tick; keep a few.
        if (k.early.length < 8) k.early.push(frame)
      } else for (const cb of k.frame) cb(frame)
      return
    }
    const msg = JSON.parse(m.data) as { id?: number; result?: unknown; error?: { code: LinkErrorCode; message: string }; event?: string; subscription?: number; data?: PrinterEvent }
    if (msg.event === 'pair' || msg.event === 'pair.closed') {
      const p = msg as unknown as { conn: string; frame?: string }
      if (msg.event === 'pair' && typeof p.frame === 'string') for (const cb of frameListeners) cb(p.conn, p.frame)
      if (msg.event === 'pair.closed') for (const cb of closedListeners) cb(p.conn)
      return
    }
    if (msg.event === 'camera.status') {
      const c = msg as unknown as CameraStatus & { stream: number }
      const k = sink(c.stream)
      k.last = { state: c.state, ...(c.attempt !== undefined ? { attempt: c.attempt } : {}), ...(c.retryInMs !== undefined ? { retryInMs: c.retryInMs } : {}), ...(c.reason ? { reason: c.reason } : {}) }
      for (const cb of k.status) cb(k.last)
      return
    }
    if (msg.event === 'camera.stats' || msg.event === 'camera.ended') {
      const c = msg as unknown as CameraStats & { stream: number }
      const k = sink(c.stream)
      if (msg.event === 'camera.stats') for (const cb of k.stats) cb({ fps: c.fps, kbps: c.kbps, dropped: c.dropped, quality: c.quality })
      else for (const cb of k.ended) cb()
      return
    }
    if ((msg.event === 'bed' || msg.event === 'queue' || msg.event === 'alert' || msg.event === 'approval') && msg.data) {
      const d = msg.data as unknown
      if (msg.event === 'bed') for (const cb of bedListeners) cb(d as BedInfo)
      else if (msg.event === 'queue') for (const cb of queueListeners) cb(d as QueueItem)
      else if (msg.event === 'alert') for (const cb of alertListeners) cb(d as HubAlert)
      else for (const cb of requestListeners) cb(d as ApprovalRequest)
      return
    }
    if (msg.event === 'approval.done' && msg.data) {
      for (const cb of approvalDoneListeners) cb(msg.data as unknown as ApprovalDone)
      return
    }
    if (msg.event === 'watch.frame' && msg.data) {
      for (const cb of watchFrameListeners) cb(msg.data as Record<string, unknown>)
      return
    }
    if (msg.event === 'remote.quota' && msg.data) {
      for (const cb of quotaListeners) cb(msg.data as unknown as RemoteQuota)
    }
    if (msg.event === 'remote.pairing.revoked') {
      const id = (msg.data as unknown as { pairingId?: unknown } | undefined)?.pairingId
      if (typeof id === 'string') for (const cb of revokedListeners) cb(id)
    }
    if (msg.event === 'watch.dismissed' && msg.data) {
      for (const cb of dismissedListeners) cb(msg.data as unknown as { printerId: string; kind: string; at: string })
      return
    }
    if (msg.event === 'watch.finding' && msg.data) {
      for (const cb of findingListeners) cb(msg.data as unknown as { printerId: string; kind: string; confidence: number; note?: string; at: string })
      return
    }
    if (msg.event === 'inbox' && msg.data) {
      for (const cb of inboxListeners) cb(msg.data as unknown as InboxDelivery)
      return
    }
    if (msg.event === 'printer' && typeof msg.subscription === 'number' && msg.data) {
      listeners.get(msg.subscription)?.(msg.data)
      return
    }
    if (typeof msg.id !== 'number') return
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new LinkError(msg.error.code, msg.error.message))
    else p.resolve(msg.result)
  })
  ws.addEventListener('close', () => {
    const err = new LinkError('closed', 'The sx-link connection closed')
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  })

  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (ws.readyState !== WS.OPEN) return reject(new LinkError('closed', 'The sx-link connection is closed'))
      const id = nextId++
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  // Who answers on this port? With a pinned key, nothing secret goes out until the hub proves it.
  const url = new URL(opts.url ?? 'ws://127.0.0.1:47615')
  const port = Number(url.port || (url.protocol === 'wss:' ? 443 : 80))
  let hello: HubHello
  try {
    hello = await checkHub(call, port, opts.hubKey)
  } catch (e) {
    ws.close()
    throw e
  }
  const hubKey = hello.hubKey

  let clientKey: string | undefined
  try {
    const extra = { ...(opts.role ? { role: opts.role } : {}), ...(opts.remember ? { remember: true, name: opts.remember.name } : {}) }
    // After a verified hello the code is used only in the code exchange bound to this hello: it never
    // goes on the socket, and a program posing as the hub gets one guess, nothing to test offline.
    const r =
      opts.clientKey && !opts.code
        ? await call<{ paired: boolean; clientKey?: string }>('pair', { clientKey: opts.clientKey, ...(opts.role ? { role: opts.role } : {}) })
        : await pairWithCode(call, hello, opts.code ?? '', extra)
    clientKey = r.clientKey
  } catch (e) {
    ws.close()
    throw e
  }

  const camera: LinkCamera = {
    discover: async (timeoutMs) => (await call<{ cameras: DiscoveredCamera[] }>('cameras.discover', timeoutMs === undefined ? {} : { timeoutMs })).cameras,
    async open(printerId, o = {}) {
      const r = await call<{ stream: number; quality: CameraHandle['quality'] }>('camera.open', { printerId, ...(o.quality ? { quality: o.quality } : {}), ...(o.jpegOnly ? { jpegOnly: true } : {}) })
      const k = sink(r.stream)
      const handle: CameraHandle = {
        stream: r.stream,
        quality: r.quality,
        onFrame(cb) {
          k.frame.add(cb)
          for (const f of k.early.splice(0)) cb(f)
          return () => void k.frame.delete(cb)
        },
        onStats(cb) {
          k.stats.add(cb)
          return () => void k.stats.delete(cb)
        },
        onEnded(cb) {
          k.ended.add(cb)
          return () => void k.ended.delete(cb)
        },
        onStatus(cb) {
          k.status.add(cb)
          if (k.last) cb(k.last)
          return () => void k.status.delete(cb)
        },
        setQuality: async (q) => void (await call('camera.quality', { stream: r.stream, quality: q })),
        async close(reason) {
          sinks.delete(r.stream)
          await call('camera.close', { stream: r.stream, ...(reason ? { reason } : {}) }).catch(() => undefined)
        },
      }
      return handle
    },
    probe: (printerId, windowMs) => call<CameraProbe>('camera.probe', { printerId, ...(windowMs ? { windowMs } : {}) }),
    async grab(printerId) {
      const r = await call<{ contentType: string; dataBase64: string; capturedAt: string; source: 'snapshot' | 'stream' } | null>('camera.grab', { printerId })
      return r ? { contentType: r.contentType, data: base64ToBytes(r.dataBase64), capturedAt: r.capturedAt, source: r.source } : null
    },
    webrtc: async (printerId, sdp) => (await call<{ sdp: string }>('camera.webrtc', { printerId, sdp })).sdp,
  }

  const host: LinkHost = {
    camera,
    plugins: () => call<PluginManifest[]>('plugins'),
    list: () => call<PrinterInfo[]>('list'),
    fleets: () => call<Fleet[]>('fleets.list'),
    createFleet: (name, opts?: FleetOptions) => call<Fleet>('fleets.create', { name, ...opts }),
    renameFleet: (fleetId, name) => call<Fleet>('fleets.rename', { fleetId, name }),
    updateFleet: (fleetId, patch) => call<Fleet>('fleets.update', { fleetId, ...patch }),
    deleteFleet: async (fleetId) => void (await call('fleets.delete', { fleetId })),
    addToFleet: (fleetId, printerId) => call<Fleet>('fleets.add', { fleetId, printerId }),
    removeFromFleet: (fleetId, printerId) => call<Fleet>('fleets.remove', { fleetId, printerId }),
    status: (printerId) => call<PrinterStatus>('status', { printerId }),

    subscribe(printerId, onEvent) {
      let sub: number | undefined
      let stopped = false
      call<{ subscription: number }>('subscribe', { printerId }).then(
        (r) => {
          if (stopped) {
            void call('unsubscribe', { subscription: r.subscription }).catch(() => undefined)
            return
          }
          sub = r.subscription
          listeners.set(sub, onEvent)
        },
        (e: LinkError) => onEvent({ type: 'error', printerId, code: e.code, message: e.message }),
      )
      return () => {
        stopped = true
        if (sub !== undefined) {
          listeners.delete(sub)
          void call('unsubscribe', { subscription: sub }).catch(() => undefined)
        }
      }
    },

    upload: (printerId, file, token) => call<RemoteFile>('upload', { printerId, token, file: encodeFile(file) }),
    start: async (file, opts2: StartOptions, token) => void (await call('start', { file, opts: opts2, token })),
    pause: async (printerId, token) => void (await call('pause', { printerId, token })),
    resume: async (printerId, token) => void (await call('resume', { printerId, token })),
    cancel: async (printerId, token) => void (await call('cancel', { printerId, token })),

    async snapshot(printerId) {
      const r = await call<{ contentType: string; dataBase64: string } | null>('snapshot', { printerId })
      return r ? new Blob([base64ToBytes(r.dataBase64)], { type: r.contentType }) : null
    },

    callTool: (pluginId, tool, input, token) => call('callTool', { pluginId, tool, input, ...(token ? { token } : {}) }),

    addPrinter: (config, info) => call<PrinterInfo>('printers.add', { config, ...(info ? { info } : {}) }),
    removePrinter: async (printerId) => void (await call('printers.remove', { printerId })),
    testPrinter: (config) => call<PrinterTestResult>('printers.test', { config }),
    discover: async (timeoutMs) => (await call<{ printers: DiscoveredPrinter[] }>('discover', timeoutMs === undefined ? {} : { timeoutMs })).printers,
    probe: async (host, timeoutMs) => (await call<{ printers: DiscoveredPrinter[] }>('probe', timeoutMs === undefined ? { host } : { host, timeoutMs })).printers,
    authorizePrinter: (printerId, timeoutSeconds) => call<{ stored: boolean }>('printers.authorize', { printerId, ...(timeoutSeconds ? { timeoutSeconds } : {}) }),
    configureService: async (pluginId, baseUrl, secretRef) => void (await call('services.configure', { pluginId, baseUrl, ...(secretRef ? { secretRef } : {}) })),
    listServices: () => call<ServiceEntry[]>('services.list'),
    removeService: async (pluginId) => (await call<{ removed: boolean }>('services.remove', { pluginId })).removed,
    setSecret: async (name, value) => void (await call('secrets.set', { name, value })),
    hasSecret: async (name) => (await call<{ has: boolean }>('secrets.has', { name })).has,
    deleteSecret: async (name) => void (await call('secrets.delete', { name })),
    sendGcode: async (printerId, line, token) => void (await call('gcode', { printerId, line, token })),
    pair: {
      listen: (enabled, port) => call('pair.listen', { enabled, ...(port === undefined ? {} : { port }) }),
      send: async (conn, frame) => void (await call('pair.send', { conn, frame })),
      close: async (conn) => void (await call('pair.close', { conn })),
      onFrame: (cb) => {
        frameListeners.add(cb)
        return () => void frameListeners.delete(cb)
      },
      onClosed: (cb) => {
        closedListeners.add(cb)
        return () => void closedListeners.delete(cb)
      },
    },
    inbox: {
      list: () => call<InboxDelivery[]>('inbox.list'),
      decline: async (deliveryId) => void (await call('inbox.decline', { deliveryId })),
      onDelivery: (cb) => {
        inboxListeners.add(cb)
        return () => void inboxListeners.delete(cb)
      },
      uploadDelivery: (printerId, deliveryId, token) => call<RemoteFile>('upload', { printerId, deliveryId, token }),
    },
    approvals: {
      register: async (req: ApprovalRequest) => void (await call('approvals.register', { request: req })),
      grant: (requestId) => call<ApprovalToken>('approvals.grant', { requestId }),
      grantWith: (requestId, o) => call<ApprovalToken | { queued: true; itemId: string; notBefore: string; approvedUntil: string }>('approvals.grant', { requestId, bedClear: o.bedClear }),
      deny: async (requestId) => void (await call('approvals.deny', { requestId })),
      pending: () => call<ApprovalRequest[]>('approvals.pending'),
      onRequest: (cb) => {
        requestListeners.add(cb)
        return () => void requestListeners.delete(cb)
      },
      registerWork: (req, work) =>
        call<{ registered: true; answeredIn: 'app' | 'here' }>('approvals.register', { request: req, work: work.kind === 'print' ? { ...work, file: encodeFile(work.file) } : work }),
    },
    onApprovalDone: (cb) => {
      approvalDoneListeners.add(cb)
      return () => void approvalDoneListeners.delete(cb)
    },
    printLocal: (printerId, file, startOptions, bedClear, objects) =>
      call<LocalPrintResult>('print.local', { printerId, file: encodeFile(file), ...(startOptions ? { opts: startOptions } : {}), ...(bedClear ? { bedClear: true } : {}), ...(objects?.length ? { objects } : {}) }),
    bed: {
      state: (printerId) => call<BedInfo>('bed.state', { printerId }),
      confirmClear: (printerId) => call<BedInfo>('bed.confirmClear', { printerId }),
      onChange: (cb) => {
        bedListeners.add(cb)
        return () => void bedListeners.delete(cb)
      },
    },
    queue: {
      add: (printerId, file, o = {}) =>
        call<{ item: QueueItem; request?: ApprovalRequest }>('queue.add', { printerId, file: encodeFile(file), ...(o.startOptions ? { opts: o.startOptions } : {}), ...(o.startAfter ? { startAfter: o.startAfter } : {}), ...(o.title ? { title: o.title } : {}) }),
      list: () => call<QueueItem[]>('queue.list'),
      remove: async (id) => void (await call('queue.remove', { id })),
      onChange: (cb) => {
        queueListeners.add(cb)
        return () => void queueListeners.delete(cb)
      },
    },
    onAlert: (cb) => {
      alertListeners.add(cb)
      return () => void alertListeners.delete(cb)
    },
    clients: {
      create: (name, role, opts) => call('clients.create', { name, role, ...(opts?.remote ? { remote: true } : {}) }),
      list: () => call('clients.list'),
      revoke: async (clientId) => void (await call('clients.revoke', { clientId })),
    },
    remote: {
      status: () => call<RemoteStatus>('remote.status'),
      configure: (o) => call<RemoteStatus>('remote.configure', o),
      quota: () => call<RemoteStatus>('remote.quota'),
      setToken: (token) => call<RemoteStatus>('remote.token', { token }),
      onQuota: (cb) => {
        quotaListeners.add(cb)
        return () => void quotaListeners.delete(cb)
      },
      pairings: {
        put: (p) => call('remote.pairings.put', { ...p, ...(opts.appId ? { appId: opts.appId } : {}) }),
        remove: (pairingId) => call('remote.pairings.remove', { pairingId }),
        list: () => call('remote.pairings.list'),
        sync: (pairingIds, o) => call('remote.pairings.sync', { pairingIds, ...(o?.removeAll ? { removeAll: true } : {}), ...(opts.appId ? { appId: opts.appId } : {}) }),
      },
      onPairingRevoked: (cb) => {
        revokedListeners.add(cb)
        return () => void revokedListeners.delete(cb)
      },
    },
    push: {
      register: async (reg) => void (await call('push.register', reg)),
      unregister: async (by) => (await call<{ unregistered: number }>('push.unregister', by)).unregistered,
      list: () => call('push.list'),
    },
    device: {
      files: (printerId) => call<StoredFile[]>('files.list', { printerId }),
      history: (printerId) => call<PrintRecord[]>('history.list', { printerId }),
      issues: (printerId) => call<PrinterIssue[]>('issues.list', { printerId }),
      objects: (printerId) => call<PrintObject[]>('objects.list', { printerId }),
      jog: async (printerId, axis, distanceMm, feedMmMin) => void (await call('jog', { printerId, axis, distanceMm, ...(feedMmMin ? { feedMmMin } : {}) })),
      skipObject: async (printerId, id, epoch) => void (await call('objects.skip', { printerId, id, epoch })),
      startFile: (printerId, path, o = {}) =>
        call<LocalPrintResult>('files.start', { printerId, path, ...(o.opts ? { opts: o.opts } : {}), ...(o.bedClear ? { bedClear: true } : {}), ...(o.unverifiedOk ? { unverifiedOk: true } : {}) }),
    },
    adjust: {
      limits: (printerId) => call<AdjustLimits>('adjust.limits', { printerId }),
      apply: async (printerId, change, token) => void (await call('adjust', { printerId, change, token })),
      setSlot: (printerId, setting, token) => call<{ slot?: FilamentSlot; shown: boolean }>('adjust.slot', { printerId, setting, token }),
      light: async (printerId, on) => void (await call('adjust.light', { printerId, on })),
    },
    watch: {
      async subscribe(onFrame, o = {}) {
        const { subscription } = await call<{ subscription: number }>('watch.subscribe', { ...(o.everyMs ? { everyMs: o.everyMs } : {}), ...(o.printerIds ? { printerIds: o.printerIds } : {}) })
        const cb = (d: Record<string, unknown>) => {
          if (d['subscription'] !== subscription) return
          onFrame({
            subscription,
            printerId: String(d['printerId']),
            contentType: String(d['contentType']),
            data: base64ToBytes(String(d['dataBase64'])),
            capturedAt: String(d['capturedAt']),
            source: d['source'] === 'stream' ? 'stream' : 'snapshot',
            ...(typeof d['state'] === 'string' ? { state: d['state'] } : {}),
            ...('layer' in d ? { layer: d['layer'] as number | null } : {}),
            ...('layerCount' in d ? { layerCount: d['layerCount'] as number | null } : {}),
          })
        }
        watchFrameListeners.add(cb)
        return () => {
          watchFrameListeners.delete(cb)
          void call('watch.unsubscribe', { subscription }).catch(() => undefined)
        }
      },
      report: async (f) => ({ paused: (await call<{ paused: boolean }>('watch.report', f)).paused }),
      onFinding: (cb) => {
        findingListeners.add(cb)
        return () => void findingListeners.delete(cb)
      },
      masks: () => call<Record<string, [number, number][]>>('watch.masks'),
      huginnPrinters: () => call<string[]>('watch.huginnPrinters'),
      setHuginn: async (printerId, enabled) => void (await call('watch.huginn', { printerId, enabled })),
      setMask: async (printerId, polygon) => void (await call('watch.mask', { printerId, polygon })),
      dismiss: async (printerId, kind) => void (await call('watch.dismiss', { printerId, kind })),
      onDismissed: (cb) => {
        dismissedListeners.add(cb)
        return () => void dismissedListeners.delete(cb)
      },
      setAutoPause: async (printerId, enabled) => void (await call('watch.autoPause', { printerId, enabled })),
    },
    settings: {
      get: () => call<HubSettings>('settings.get'),
      set: (patch) => call<HubSettings>('settings.set', patch),
    },
    ...(clientKey ? { clientKey } : {}),
    ...(hubKey ? { hubKey } : {}),
    close: () => ws.close(),
  }
  return host
}

function encodeFile(f: JobFile): { name: string; kind: JobFile['kind']; sha256: string; dataBase64: string } {
  return { name: f.name, kind: f.kind, sha256: f.sha256, dataBase64: bytesToBase64(new Uint8Array(f.data)) }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode(...bytes.subarray(i, i + step))
  return btoa(s)
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

const HELLO_CONTEXT = new TextEncoder().encode('sx-link hello v2\n')
/** A verified hello: the hub's key, the port it signed and the nonces the code exchange is bound to. */
export interface HubHello {
  hubKey: string
  port: number
  clientNonce: Uint8Array
  hubNonce: Uint8Array
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/**
 * Asks the hub to sign a fresh nonce, its own nonce and the port this client reached it on, and
 * checks it. With `pinned`, the signature must come from that key or this throws `hub_identity`
 * before anything secret is sent. A signature for another port means a relay, and fails too.
 * Every hub answers `hello`, so a program that does not is refused even when nothing is pinned:
 * otherwise it could answer with an error and receive the code in clear.
 */
export async function checkHub(call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>, port: number, pinned?: string): Promise<HubHello> {
  const clientNonce = crypto.getRandomValues(new Uint8Array(32))
  let r: { hubKey: string; hubNonce: string; port: number; sig: string }
  try {
    r = await call<{ hubKey: string; hubNonce: string; port: number; sig: string }>('hello', { nonce: bytesToBase64(clientNonce) })
  } catch {
    throw new LinkError('hub_identity', 'The program on this port did not prove it is a SlicerX hub. Nothing was sent.')
  }
  if (pinned && r.hubKey !== pinned) {
    // Another key. When it signed this very connection, say which, so the person can compare fingerprints.
    let signed = false
    try {
      signed = typeof r.hubKey === 'string' && r.port === port && (await verifyHello(r.hubKey, clientNonce, base64ToBytes(r.hubNonce ?? ''), port, r.sig))
    } catch {
      signed = false
    }
    throw new LinkError('hub_identity', 'The program on this port is not the SlicerX hub you paired with. Nothing was sent.', signed ? r.hubKey : undefined)
  }
  const hubNonce = base64ToBytes(r.hubNonce ?? '')
  if (r.port !== port || !(await verifyHello(r.hubKey, clientNonce, hubNonce, port, r.sig))) {
    throw new LinkError('hub_identity', 'The hub signature did not verify for this connection. Nothing was sent.')
  }
  return { hubKey: r.hubKey, port, clientNonce, hubNonce }
}

/** Checks the hub's Ed25519 signature over the hello transcript. */
export async function verifyHello(hubKey: string, clientNonce: Uint8Array, hubNonce: Uint8Array, port: number, sig: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', base64ToBytes(hubKey), { name: 'Ed25519' }, false, ['verify'])
    const p = new Uint8Array([(port >> 8) & 0xff, port & 0xff])
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, base64ToBytes(sig), concat(HELLO_CONTEXT, clientNonce, hubNonce, p))
  } catch {
    return false
  }
}

/**
 * Pairs with `code` through the code exchange (CPace, cpace.ts) bound to a verified hello. The hub
 * must prove it holds the same code before this resolves, so a key pinned afterwards is the real
 * hub's, not whatever answered first. A hub that predates the exchange is told apart and named.
 */
export async function pairWithCode<T extends { paired: boolean; clientKey?: string }>(
  call: <R>(method: string, params?: Record<string, unknown>) => Promise<R>,
  hello: HubHello,
  code: string,
  extra: Record<string, unknown> = {},
): Promise<T & { role: string }> {
  const ctx = { hubKey: base64ToBytes(hello.hubKey), port: hello.port, clientNonce: hello.clientNonce, hubNonce: hello.hubNonce }
  const random = crypto.getRandomValues(new Uint8Array(32))
  const run = pakeStart(code, ctx, random)
  random.fill(0)
  try {
    return await runExchange<T>(call, run, extra)
  } finally {
    run.wipe()
  }
}

async function runExchange<T extends { paired: boolean; clientKey?: string }>(
  call: <R>(method: string, params?: Record<string, unknown>) => Promise<R>,
  run: ReturnType<typeof pakeStart>,
  extra: Record<string, unknown>,
): Promise<T & { role: string }> {
  let answer: { pake?: Record<string, string> }
  try {
    answer = await call<{ pake?: Record<string, string> }>('pair', { pake: bytesToBase64(run.ya) })
  } catch (e) {
    // An older hub reads the message as a wrong code. It cannot have learned anything from it.
    if (e instanceof LinkError && e.code === 'unauthorized') throw new LinkError('unauthorized', 'This hub is older than this app. Update SlicerX (sx-link) on the computer to pair.')
    throw e
  }
  const yb: Record<string, Uint8Array> = {}
  for (const [role, m] of Object.entries(answer.pake ?? {})) if (typeof m === 'string') yb[role] = base64ToBytes(m)
  const tags = run.respond(yb)
  if (!tags) throw new LinkError('hub_identity', 'The hub did not complete the code exchange. Nothing about the code was sent.')
  const confirm = Object.fromEntries(Object.entries(tags).map(([role, t]) => [role, bytesToBase64(t)]))
  const r = await call<T & { role: string; confirm?: string }>('pair', { confirm, ...extra })
  if (typeof r.confirm !== 'string' || !run.hubConfirmed(base64ToBytes(r.confirm))) {
    throw new LinkError('hub_identity', 'The program on this port did not prove it holds the code. Do not trust it.')
  }
  return r
}
