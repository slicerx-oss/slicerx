// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

/**
 * How the machine moves. `cartesian` moves the head in X and Y on its own axes and the bed in Z (the UltiMaker S
 * series); `corexz` moves the bed on Y only; `toolchanger` has several independent toolheads.
 */
export type Kinematics = 'bed-slinger' | 'cartesian' | 'corexy' | 'corexz' | 'delta' | 'idex' | 'toolchanger'

/** Local superset of `PrinterInfo.filamentSystem` in `@slicerx/contracts`: it also names the Creality CFS. */
export type FilamentSystem = 'ams' | 'mmu' | 'toolchanger' | 'cfs'

/**
 * How SlicerX reaches a printer. The ids match the plugin ids in `packages/connect/manifests.json`,
 * except `export`, which means no connection: save G-code and carry it over on USB or an SD card.
 */
export type ConnectionId =
  | 'bambu-lan'
  | 'moonraker'
  | 'octoprint'
  | 'prusalink'
  | 'duet'
  | 'creality'
  | 'snapmaker'
  | 'elegoo'
  | 'ultimaker'
  | 'anycubic'
  | 'export'

export interface Brand {
  id: string
  name: string
}

export type BuildVolume =
  | { shape: 'rectangular'; x: number; y: number; z: number }
  /** Delta and other round beds. The origin is the center of the bed. */
  | { shape: 'circular'; diameter: number; z: number }

/** Where a person reads what SlicerX asks for. Screen names are what the printer's own menus call them. */
export interface FindGuide {
  /** Where to read the IP address. */
  ip: string
  /** Where to read or create the access code, API key or password, when the connection needs one. */
  credential?: string
  /** Where to read the serial number, when the connection needs it. */
  serial?: string
  /**
   * True only when someone read these screen names on the printer itself. All are false until a
   * printer has been tried; the wording comes from the vendor's documentation.
   */
  checkedOnPrinter: boolean
}

export interface PrinterModel {
  /** Stable id, `brand-model` in lowercase, such as `bambu-a1-mini`. The settings package keys its printer profile by it (`printerProfile` in @slicerx/settings). */
  id: string
  brand: string
  name: string
  kinematics: Kinematics
  enclosed: boolean
  buildVolume: BuildVolume
  /** Nozzle diameters in millimeters that the maker sells or supports. */
  nozzles: number[]
  defaultNozzle: number
  /** Independent nozzles on the machine (2 for the Bambu Lab H2D, 4 for the Snapmaker U1). */
  nozzleCount: number
  filamentSystem?: FilamentSystem
  /** What the maker calls the unit when it is not the plain system name, such as the A1's AMS lite. */
  filamentUnit?: string
  /** Ways to reach it, best first. Always ends in `export` unless the machine has no other way to take a file. */
  connections: ConnectionId[]
  find: FindGuide
  /** One line on anything that changes what works, such as an unsupported protocol. */
  note?: string
}

export type Discovery =
  /** Sends one SSDP search and listens for the answers and the announcements printers send by themselves. */
  | { kind: 'ssdp'; detail: string }
  /** Asks the network with multicast DNS. One small multicast query, answered by the printers. */
  | { kind: 'mdns'; detail: string; service: string }
  /** Sends one UDP broadcast when the user starts a scan. */
  | { kind: 'udp-broadcast'; detail: string }
  /** The user types the address. */
  | { kind: 'manual'; detail: string }

/** Print options a connection can pass when it starts a job. Names match `StartOptions` in `@slicerx/contracts`. */
export type StartOptionKey = 'bedLeveling' | 'flowCalibration' | 'vibrationCompensation' | 'timelapse' | 'firstLayerInspection'

export type FieldKey = 'host' | 'port' | 'serial' | 'accessCode' | 'apiKey' | 'username' | 'password' | 'pairing'

export interface ConnectionField {
  key: FieldKey
  label: string
  /** Stored in the OS keychain and never shown again. */
  secret: boolean
  required: boolean
  placeholder?: string
}

export interface ConnectionMethod {
  id: ConnectionId
  name: string
  /** Plugin id in the connectors manifest, or null for `export`. */
  plugin: string | null
  /** File in `packages/connect/docs` that holds the step by step guide. */
  guide: string
  defaultPort?: number
  discovery: Discovery
  /** What the add-printer form asks for, in order. */
  fields: ConnectionField[]
  /**
   * Options the connection sends with a start. Anything not listed is ignored, so the UI should hide it.
   * Klipper and other G-code firmware run their own start routines from the start G-code instead.
   */
  startOptions: StartOptionKey[]
  /** Set when the printer must be paired on its own screen (Snapmaker 2.0). */
  pairsOnPrinter?: boolean
  /** One line for the setup screen. */
  summary: string
}
