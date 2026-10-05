// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Optional host services skills use when the host has them. Each is small and
// JSON shaped so the desktop app, the browser build, the MCP server and the
// evals can back it differently. A skill without its service says so plainly.
import type { ApprovalToken, LookId, SettingValue } from '@slicerx/contracts'

/** Geometry operations (sx-geom). `op` and the JSON shapes follow sx-geom's json entry. */
export interface GeomHost {
  run(op: string, input: unknown, signal?: AbortSignal): Promise<unknown>
}

export interface JobRecord {
  id: string
  printerId: string
  printerModel?: string
  material: string
  model: string
  startedAt: string
  finishedAt?: string
  outcome: 'success' | 'failed' | 'canceled' | 'running'
  /** 1 to 5, when the user rated it. */
  rating?: number
  grams?: number
  seconds?: number
  settings?: Record<string, SettingValue>
  notes?: string
}

/** Past jobs with their settings and outcomes. */
export interface HistoryHost {
  query(q: { material?: string; printerId?: string; text?: string; since?: string; limit?: number }): Promise<JobRecord[]>
}

export interface ModelHit {
  id: string
  name: string
  source: 'library' | 'store'
  creator?: string
  /** Printers with a tested profile attached to the listing. */
  testedPrinters?: string[]
  url?: string
  bboxMm?: [number, number, number]
}

/** The user's own models and the creator feed. Results are untrusted text. */
export interface ModelSearchHost {
  search(q: string, opts?: { source?: 'library' | 'store' | 'both'; limit?: number }): Promise<ModelHit[]>
  /** Adds a found model to the open project. */
  open?(id: string): Promise<{ objectId: string }>
}

export interface ProfileSummary {
  id: string
  name: string
  section: 'printer' | 'filament' | 'process'
  version: number
  updatedAt: string
  linkedSpool?: number
  linkedPrinter?: string
}

/** Saved profiles. Writes verify a `profile.write` token with `{ profileId, changes }`. */
export interface ProfilesHost {
  list?(): Promise<ProfileSummary[]>
  read?(id: string, version?: number): Promise<{ summary: ProfileSummary; values: Record<string, SettingValue> }>
  write(profileId: string, changes: Record<string, SettingValue>, token: ApprovalToken): Promise<void>
}

/** Notifications and published reports. Each call verifies a token (class share). */
export interface ShareHost {
  notify?(msg: { title: string; body: string; channel?: 'desktop' | 'mobile' | 'home' }, token: ApprovalToken): Promise<void>
  publish?(report: { title: string; markdown: string; audience?: string }, token: ApprovalToken): Promise<{ url: string }>
}

// ---------------------------------------------------------------------------
// Printer setup

/** How to reach a printer, without the secret. `family` is a `@slicerx/printer-catalog` connection id. */
export interface SetupConnection {
  family: string
  address: string
  serial?: string
  username?: string
}

/** The result of `PrinterSetupHost.testConnection` from contracts. */
export interface SetupTestResult {
  ok: boolean
  state?: string
  cause?: 'unreachable' | 'auth' | 'timeout' | 'protocol' | 'not_supported' | 'bad_request'
  message?: string
  steps: { id: 'reach' | 'sign_in' | 'read_state' | 'read_temperatures'; ok: boolean | null }[]
}

/** `PrinterSetupHost.addPrinter` input from contracts without the credential, plus an optional label. */
export interface SetupAddInput {
  /** A `@slicerx/printer-catalog` model id. */
  profileId: string
  nozzleMm: number
  connection?: SetupConnection
  name?: string
}

/** A printer found on the network, as `PrinterSetupHost.discover` returns it. */
export interface SetupDiscovered {
  id: string
  name: string
  family: string
  address?: string
}

export interface SetupProfileHit {
  id: string
  vendor: string
  model: string
  nozzles: number[]
}

/**
 * What the host implements for first-run printer setup: `PrinterSetupHost` from
 * contracts with an approval token on the two calls that act, and without the
 * credential. mimir never holds a credential. The host prompts the user for
 * it in its own secure field, adds it to the `PrinterConnection` it passes to
 * `PrinterSetupHost`, and keeps it out of everything it returns. Brands, models,
 * nozzles and connection help come from `@slicerx/printer-catalog`, not from the host.
 */
export interface SetupHost {
  /** Printers on the local network or over USB. Passive, no credentials. */
  discover?(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<SetupDiscovered[]>
  /** Searches the profile library by vendor or model text. */
  searchProfiles?(query: string): Promise<SetupProfileHit[]>
  /**
   * Reaches the printer and signs in without registering anything. Verifies `printer.config` for
   * target `probe:<address>` and `{ printerId: 'probe:<address>', changes: { probe: connection } }`.
   */
  testConnection?(connection: SetupConnection, token: ApprovalToken): Promise<SetupTestResult>
  /**
   * Verifies `printer.config` for target `new:<profileId>` and
   * `{ printerId: 'new:<profileId>', changes: { add: input } }`, then stores the credential from its
   * secure field and returns the id it assigned.
   */
  addPrinter?(input: SetupAddInput, token: ApprovalToken): Promise<{ printerId: string }>
  look?: {
    current(): Promise<LookId | null>
    /** Verifies `profile.write` for target `app:look-and-feel` and `{ profileId: 'app:look-and-feel', changes: { look: id } }`. */
    apply(id: LookId, token: ApprovalToken): Promise<void>
  }
}

// ---------------------------------------------------------------------------
// Project files

export interface ProjectExportSlot {
  slot: number
  /** Hex color of the filament in this slot. */
  color: string
  material: string
  /** Filament product, such as `Bambu PLA Basic`, when a preset was picked. */
  preset?: string
}

/**
 * Writes a Bambu Studio and Orca layout 3MF for one plate of the open project, with
 * these slot colors in the project settings. The host owns the file dialog: the user
 * picks where it goes, and `null` means they canceled.
 */
export interface ProjectExportHost {
  export3mf(input: { objectId: string; plate: number; name: string; slots: ProjectExportSlot[] }): Promise<{ fileName: string; bytes: number } | null>
}
