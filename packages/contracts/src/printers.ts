// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printer and service plugins as the UI and Pilot see them.
import type { ApprovalToken, PermissionClass } from './pilot'

export type PluginKind = 'printer' | 'inventory' | 'home'
export type Capability = 'status' | 'events' | 'upload' | 'start' | 'pause' | 'resume' | 'cancel' | 'camera' | 'filament_slots' | 'gcode_console'

export interface PluginToolSpec {
  name: string
  description: string
  permission: PermissionClass
  inputSchema: Record<string, unknown>
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  kind: PluginKind
  protocols: string[]
  capabilities: Capability[]
  tools: PluginToolSpec[]
  /** Hosts and ports the plugin may reach, such as "lan:8883". */
  network: string[]
}

export interface PrinterInfo {
  id: string
  /** User label, such as "Bay 2". */
  name: string
  vendor: string
  model: string
  plugin: PluginManifest['id']
  host?: string
  nozzleCount: number
  filamentSystem?: 'ams' | 'mmu' | 'toolchanger'
}

export type PrinterState = 'idle' | 'preparing' | 'printing' | 'paused' | 'finished' | 'error' | 'offline'

export interface Temp { current: number; target: number }

export interface FilamentSlot {
  /** "A1".."A4" for AMS unit A, or "1" for a single spool. */
  id: string
  material?: string
  color?: string
  remainingPct?: number
  spoolmanId?: number
  /** The spool's own tag, when the printer reads one (Bambu Lab RFID `tray_uuid`), so a swapped spool reads as a new one. */
  spoolUid?: string
}

/**
 * What a filament slot holds, written to the printer as Bambu Studio writes an AMS slot (`ams_filament_setting`).
 * `filamentId` is the preset's `filament_id` ("GFA00"), `color` is `#rrggbb`, the nozzle range is the preset's.
 * Approved as a `printer.adjust` card whose params are `{ printerId, slot }`.
 */
export interface SlotSetting {
  slot: string
  filamentId: string
  material: string
  color: string
  nozzleTempMin: number
  nozzleTempMax: number
}

export interface PrinterStatus {
  printerId: string
  state: PrinterState
  jobName?: string
  progress?: number
  layer?: number
  layerCount?: number
  timeLeftS?: number
  nozzles: Temp[]
  /** The installed nozzle's diameter in mm, when the printer reports it (Bambu Lab does). The app resolves the matching presets. */
  nozzleDiameterMm?: number
  bed?: Temp
  chamber?: Temp
  slots: FilamentSlot[]
  cameraAvailable: boolean
  /** The model the printer itself reports (Bambu Lab: "A1", "A1 mini"), from the hub. Absent when the printer does not say. */
  model?: string
  /** The name the printer announces for itself (Bambu Lab: its SSDP `DevName`), from the hub. Absent when it has not been heard. */
  ownName?: string
  /** The firmware version the printer reports, such as "01.04.00.00". Absent when the driver does not read it. Bug reports include it. */
  firmware?: string
  message?: string
  updatedAt: string
  /**
   * The print watch, from the hub: `watching` while the printer prints and a failure detector looks
   * at it, `attention` for ten minutes after a detector reported something, else `off`. Absent when
   * the host has no hub.
   */
  watch?: 'off' | 'watching' | 'attention'
  /**
   * From the hub, on a paused print with a heater on when the printer's firmware does not turn heaters
   * off by itself while paused: plain words to show the person. Absent otherwise.
   */
  pauseNote?: string
  /** What the printer reports beyond the basics, for the device view. Absent when it reports none of it. */
  live?: PrinterLive
}

/** Fans, speed, light and filament feed as the printer reports them. Every field is absent when the printer does not say. */
export interface PrinterLive {
  /** Fan speeds in percent: part cooling, auxiliary and chamber. */
  fans?: { part?: number; aux?: number; chamber?: number }
  /** The print speed in percent of the sliced speeds (Bambu Lab levels: 50 silent, 100 standard, 124 sport, 166 ludicrous). */
  speedPercent?: number
  /** Whether the chamber light is on. */
  light?: boolean
  /** The slot feeding the nozzle now, as a slot id of `slots`. */
  activeSlot?: string
  /** `left` or `right` for each entry of `nozzles`, on printers with two side by side. */
  nozzleSides?: ('left' | 'right')[]
  /** The filament units in the order of their slots: the letter their slot ids start with, the kind, and the nozzle each feeds on a printer with two. */
  units?: { id: string; kind: FilamentUnit['kind']; feeds?: 'left' | 'right' }[]
  /** Height of the layer printing now, in mm. */
  layerZMm?: number
  /**
   * True while the printer sends status but refuses commands from other apps: a Bambu Lab printer with Developer Mode
   * off. It prints through Bambu Connect then. Absent when it takes commands or does not say.
   */
  monitorOnly?: boolean
}

export type PrinterEvent =
  | { type: 'status'; status: PrinterStatus }
  | { type: 'job_finished'; printerId: string; jobName: string; ok: boolean }
  | { type: 'error'; printerId: string; code: string; message: string }

export interface JobFile {
  name: string
  kind: 'gcode' | 'gcode.3mf' | 'bgcode'
  data: ArrayBuffer
  sha256: string
}

export interface RemoteFile {
  printerId: string
  path: string
  name: string
  /** Content hash, when the file went up through SlicerX. Start approvals bind to it. */
  sha256?: string
}

export interface StartOptions {
  plate?: number
  /** Bambu Lab, Elegoo. Default on. */
  bedLeveling?: boolean
  /** Bambu Lab. Default off, as Bambu Studio sends it. */
  flowCalibration?: boolean
  /** Bambu Lab motion compensation. Default off, as Bambu Studio sends it. */
  vibrationCompensation?: boolean
  /** Bambu Lab and Elegoo; needs storage in the printer. Default off. */
  timelapse?: boolean
  /** Bambu Lab X1 series. Default on, as Bambu Studio sends it. */
  firstLayerInspection?: boolean
  /**
   * Filament to printer slot id. Keys are 0 based filament indexes: key 0 is the first filament
   * (the G-code's T0, shown to people as filament 1). Values are slot ids as the printer reports
   * them, such as "A3", or "1" for the external spool. Only a printer that follows the map
   * accepts one (see `followsSlotMap`); every other start with a map is refused.
   */
  slotMap?: Record<number, string>
}

/**
 * Whether a printer makes its filament follow `StartOptions.slotMap` for this file. Today only
 * a Bambu Lab printer starting a .gcode.3mf does (`project_file` with `ams_mapping`); a plain
 * .gcode on Bambu and every other driver take filament as the G-code says.
 */
export function followsSlotMap(plugin: string, fileName: string): boolean {
  return plugin === 'bambu-lan' && /\.3mf$/i.test(fileName)
}

/**
 * A short, readable form of a hub key for people to compare with what `sx-link code` prints: the first
 * 80 bits of SHA-256 over the key bytes in Crockford base32, four groups of four ("CC6W TAB6 RGSP D48J").
 * Same as `sx_link::hub_fingerprint`. Null for a key that is not base64.
 */
export async function hubFingerprint(hubKey: string): Promise<string | null> {
  let raw: Uint8Array<ArrayBuffer>
  try {
    const bin = atob(hubKey.trim())
    raw = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i)
  } catch {
    return null
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', raw))
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let n = 0n
  for (const b of digest.slice(0, 10)) n = (n << 8n) | BigInt(b)
  let out = ''
  for (let i = 0; i < 16; i++) out += ALPHABET[Number((n >> BigInt(5 * (15 - i))) & 31n)]
  return out.match(/.{4}/g)!.join(' ')
}

/**
 * The slot map in plain words for an approval card, keys read as 0 based: `{0: "A1"}` reads
 * "filament 1 from slot A1". `clean` makes a slot id safe to show. Null for an empty map.
 */
export function slotMapLine(map: Record<number, string> | Record<string, unknown> | undefined, clean: (s: string) => string = (s) => s): string | null {
  if (!map || typeof map !== 'object') return null
  const pairs = Object.entries(map).map(([k, v]) => `filament ${Number(k) + 1} from slot ${clean(String(v))}`)
  return pairs.length ? `Filament slots: ${pairs.join(', ')}` : null
}

/**
 * A user-defined group of printers, such as "Workshop". Fleets are optional: every printer works
 * without one, and a printer can belong to any number of fleets. Deleting a fleet never removes
 * printers.
 */
export interface Fleet {
  id: string
  name: string
  printerIds: string[]
  /** A palette token or hex color the UI may use for the group. */
  color?: string
  /** An icon name from the shared icon set. */
  icon?: string
}

export interface FleetOptions {
  color?: string
  icon?: string
  /** Printers to put in the new fleet. Every id must be a known printer. */
  printerIds?: string[]
}

export interface PrinterHost {
  plugins(): Promise<PluginManifest[]>
  /** Every printer, whether or not it is in a fleet. */
  list(): Promise<PrinterInfo[]>
  /** The user's fleets, in creation order. */
  fleets(): Promise<Fleet[]>
  /** Names must be non-empty after trimming and unique ignoring case; otherwise `protocol` error. */
  createFleet(name: string, opts?: FleetOptions): Promise<Fleet>
  renameFleet(fleetId: string, name: string): Promise<Fleet>
  /** Changes color and icon; `null` clears one. */
  updateFleet(fleetId: string, patch: { color?: string | null; icon?: string | null }): Promise<Fleet>
  deleteFleet(fleetId: string): Promise<void>
  /** Adding a printer that is already in the fleet does nothing. Unknown ids fail with `not_found`. */
  addToFleet(fleetId: string, printerId: string): Promise<Fleet>
  removeFromFleet(fleetId: string, printerId: string): Promise<Fleet>
  status(printerId: string): Promise<PrinterStatus>
  subscribe(printerId: string, onEvent: (e: PrinterEvent) => void): () => void
  upload(printerId: string, file: JobFile, token: ApprovalToken): Promise<RemoteFile>
  start(file: RemoteFile, opts: StartOptions, token: ApprovalToken): Promise<void>
  pause(printerId: string, token: ApprovalToken): Promise<void>
  resume(printerId: string, token: ApprovalToken): Promise<void>
  cancel(printerId: string, token: ApprovalToken): Promise<void>
  snapshot(printerId: string): Promise<Blob | null>
  /** Service plugins (Spoolman, Home Assistant) and plugin tools without a printer target. */
  callTool(pluginId: string, tool: string, input: unknown, token?: ApprovalToken): Promise<unknown>
}

/** How a driver reaches one printer. Secrets are never in here; `credentialRef` names a keychain entry. */
export interface PrinterConfig {
  id: string
  name: string
  plugin: PluginManifest['id']
  host: string
  port?: number
  /** Keychain entry holding the access code or API key. */
  credentialRef?: string
  /** Bambu Lab serial number, used in MQTT topics. */
  serial?: string
  /** Moonraker or OctoPrint over https. */
  tls?: boolean
  /** Polling interval in ms for drivers without a push channel. Default 1000. */
  pollMs?: number
  /** Bambu Lab FTPS and camera port overrides (defaults 990 and 6000). Tests point them at mocks. */
  ftpPort?: number
  /** Camera port override (Bambu 6000, Creality 8080). */
  cameraPort?: number
  /** Creality WebSocket port (default 9999) and REST port (default 80). */
  wsPort?: number
  httpPort?: number
  /** Forces a protocol for plugins with two: `moonraker` or `native` (Creality), `moonraker` or `luban` (Snapmaker). Unset means probe. */
  protocol?: string
  /** User name for HTTP digest login (PrusaLink); the secret is then the password. */
  username?: string
  /** A camera that is not the printer's own: `rtsp://`, `rtsps://` or an http MJPEG URL on the local network, with no user name in it. */
  cameraUrl?: string
  /** Keychain entry holding `user:password` for `cameraUrl`. */
  cameraCredentialRef?: string
  /** Bambu Lab RTSPS port override (default 322). */
  rtspPort?: number
}

export interface DiscoveredPrinter {
  plugin: PluginManifest['id']
  host: string
  port?: number
  name?: string
  model?: string
  serial?: string
  /** Firmware version, when the announcement says. */
  firmware?: string
  /** Bambu Lab: true while LAN Only Mode is on, false while the printer uses Bambu Cloud. Anycubic: true while LAN Mode is on. */
  lanOnly?: boolean
  /** Bambu Lab: true while the printer is bound to a Bambu account (SSDP `DevBind` `occupied`). */
  bound?: boolean
  /** The printer also offers HTTPS (Moonraker's `https_port`); `port` stays the plain one. */
  tls?: boolean
  /** An identity that survives an address change, for printers that announce one without a serial number (Moonraker's `uuid`). */
  uid?: string
}

/** What a printer reports about its own hardware when it is added. Every field is absent when the printer did not say. */
export interface PrinterHardware {
  model?: string
  firmware?: string
  /** One per extruder, in tool order (T0 first). */
  extruders?: ExtruderInfo[]
  /** AMS units, MMUs and external spools, with what each slot holds. */
  filamentUnits?: FilamentUnit[]
  /** Bambu Lab: false while the printer wants signed commands, so Developer Mode is off: it sends status, and prints go through Bambu Connect. */
  developerMode?: boolean
  /** Bambu Lab: whether a micro SD card is in. An X1 needs one to start a print over the network. */
  sdCard?: boolean
  /** The printable volume, X, Y and Z in mm, from the printer's own travel limits (Klipper). */
  buildVolumeMm?: [number, number, number]
  /** The diameter of a round bed in mm (delta printers). */
  bedDiameterMm?: number
  /** Klipper's kinematics: `cartesian`, `corexy`, `delta` and so on. */
  kinematics?: string
  maxVelocityMmS?: number
  maxAccelMmS2?: number
  /** The name the printer has on the network, which outlives an address change. */
  hostname?: string
  /** The serial number or board id the printer reports, so a printer whose address changed is still the same one. */
  serial?: string
}

export interface ExtruderInfo {
  tool: number
  /** `left` or `right` on printers with two nozzles side by side. */
  position?: 'left' | 'right'
  nozzleDiameterMm?: number
  nozzleType?: 'brass' | 'hardened-steel' | 'stainless-steel' | 'tungsten-carbide'
  highFlow?: boolean
}

export interface FilamentUnit {
  /** The letter the unit's slots use (`A` for A1 to A4), or `external`. */
  id: string
  /** `qidi-box` is a QIDI Box, `cfs` a Creality CFS, `toolchanger` one spool per toolhead (Snapmaker U1), `ace` an Anycubic ACE. */
  kind: 'ams' | 'ams-lite' | 'ams-2-pro' | 'ams-ht' | 'mmu' | 'qidi-box' | 'cfs' | 'toolchanger' | 'ace' | 'external'
  /** The tool the unit feeds, when the printer has more than one. */
  tool?: number
  slots: FilamentSlot[]
}

export type PrinterErrorCode =
  | 'unreachable'
  | 'auth'
  /** The printer answered, but the secure connection failed (a certificate or TLS problem). */
  | 'tls'
  /** Nothing came back in time. */
  | 'timeout'
  | 'not_supported'
  | 'approval_required'
  | 'approval_invalid'
  | 'not_found'
  | 'bad_state'
  | 'protocol'
  /** The printer answered the start with a refusal; the message carries its reason. */
  | 'refused'

/** Error shape at the host boundary. Messages never contain secrets. */
export interface PrinterError {
  code: PrinterErrorCode
  message: string
  printerId?: string
}

/** Actions that change a printer or a queue and therefore need an approval token. */
export type PrinterAction = 'upload' | 'start' | 'pause' | 'resume' | 'cancel' | 'gcode'

/** Fixture shapes for packages/connect/fixtures/demo-fleet.json. */
export interface FleetJobFixture {
  name: string
  progress: number
  layer: number
  layerCount: number
  timeLeftS: number
}

export interface FleetPrinterFixture {
  id: string
  name: string
  vendor: string
  model: string
  plugin: PluginManifest['id']
  host: string
  nozzleCount: number
  filamentSystem?: 'ams' | 'mmu' | 'toolchanger'
  cameraAvailable: boolean
  state: PrinterState
  nozzles: Temp[]
  bed?: Temp
  chamber?: Temp
  slots: FilamentSlot[]
  job?: FleetJobFixture
  message?: string
  live?: PrinterLive
}

export interface SpoolFixture {
  id: number
  material: string
  vendor: string
  name: string
  color: string
  remainingG: number
  initialG: number
}

/** The demo data set: five printers, nine spools and one example fleet. */
export interface DemoFleet {
  version: number
  printers: FleetPrinterFixture[]
  /** Example user groups. Printers are listed independently of these. */
  fleets: Fleet[]
  spools: SpoolFixture[]
}
