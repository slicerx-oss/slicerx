// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The one interface the UI talks to. The web and Tauri hosts implement it.
import type { ApprovalHost, LlmTransport, PermissionClass } from './pilot'
import type { PrinterHost } from './printers'
import type { SlicerHost } from './slice'

export interface HostCapabilities {
  nativeSlicing: boolean
  orcaEngine: boolean
  /** Where printers come from: none, the in-memory demo fleet, sx-link, or linked in. */
  printers: 'none' | 'sim' | 'link' | 'native'
  webgpu: boolean
  /** Worker shards (web) or threads (desktop) available for slicing. */
  threads: number
  /** Secrets live in the OS keychain (desktop, sx-link) rather than nowhere. */
  secureStorage: boolean
}

export interface FileRef {
  id: string
  name: string
  size: number
  /** Desktop only. */
  path?: string
}

export interface FileHost {
  open(opts: { accept: string[]; multiple?: boolean }): Promise<FileRef[]>
  read(ref: FileRef): Promise<ArrayBuffer>
  save(suggestedName: string, data: ArrayBuffer | Blob, opts?: { accept?: string[] }): Promise<FileRef | null>
  /** Writes over a project file opened or saved before, without asking. Desktop only. */
  saveTo?(ref: FileRef, data: ArrayBuffer | Blob): Promise<FileRef | null>
  recent(): Promise<FileRef[]>
  /** Files dropped on the window or opened by file association. */
  onOpenRequest(cb: (refs: FileRef[]) => void): () => void
}

/**
 * Printer credentials (access codes, API keys). Write-only from the webview:
 * secrets can be set and checked, never read back. The OpenAI key is not
 * handled here; the owner stores it in the Keychain and code only reads it.
 */
export interface SecretsHost {
  has(name: string): Promise<boolean>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
}

/** Themes the person keeps in a folder of the app data directory. Desktop only. */
export interface ThemesHost {
  /** The text of each .json file in the themes folder (small files only). */
  list(): Promise<string[]>
  /** Shows the themes folder in the system file manager, creating it first. */
  openFolder(): Promise<void>
}

/** What the About screen and the status line show, including the link to this build's source. */
export interface BuildInfo {
  version: string
  /** Git commit of the running build, or 'dev'. */
  commit: string
  /** Link to the source of exactly this build. */
  sourceUrl: string
  /** A build made for the end-to-end tests (SLICERX_E2E=1 at build time): first-run screens stay out of the way. */
  e2e?: boolean
}

/**
 * Bambu Connect, Bambu Lab's own app for printing from other software to a printer with Developer Mode off. The
 * hand-off is the URL scheme on Bambu Lab's wiki (https://wiki.bambulab.com/en/software/bambu-connect, "Launching
 * Bambu Connect from Third-Party Software"): `bambu-connect://import-file?path=...&name=...&version=1.0.0`, with the
 * absolute path of a .gcode.3mf. Desktop only, since a web page has no file path to give.
 */
export interface BambuConnectHost {
  /**
   * Writes `data` where Bambu Connect can read it and opens it there under `title`. `opened` when Bambu Connect took
   * the link, `missing` when it is not installed, `unsupported` where Bambu Lab makes no Bambu Connect (Linux).
   */
  open(fileName: string, data: ArrayBuffer, title: string): Promise<'opened' | 'missing' | 'unsupported'>
}

/**
 * The base members are always present. Optional members exist only when the
 * matching feature is compiled in; code checks for them instead of assuming
 * them. Editions extend this interface with their own members.
 */
export interface Host {
  kind: 'web' | 'desktop' | 'embedded'
  capabilities: HostCapabilities
  build: BuildInfo
  slicer: SlicerHost
  files: FileHost
  secrets: SecretsHost
  /** Desktop only: the themes folder. The browser keeps imported themes in local storage. */
  themes?: ThemesHost
  /** Feature `connect`. */
  printers?: PrinterHost
  /** Feature `pilot`. */
  llm?: LlmTransport
  /** Features `pilot` and `connect`: every side effect needs an approval token. */
  approvals?: ApprovalHost
  /** Feature `connect`, desktop only: prints for a Bambu Lab printer with Developer Mode off. */
  bambuConnect?: BambuConnectHost
}

/** Base workspaces are 'prepare', 'preview' and 'library'; features add their own, such as 'printers' and 'pilot'. */
export type Workspace = string

/** One entry in the Cmd+K registry. Pilot sees commands with a `tool` as `app.<id>` tools. */
export interface CommandSpec {
  id: string
  title: string
  section: 'navigate' | 'plate' | 'slice' | 'printers' | 'library' | 'pilot' | 'settings' | 'view' | 'help'
  keywords?: string[]
  shortcut?: string
  workspace?: Workspace
  /** Present when Pilot may call it; the permission class it needs. */
  tool?: { permission: PermissionClass; inputSchema?: Record<string, unknown> }
  /** Hidden from the bar and refused as a tool while this returns false. */
  enabled?(): boolean
  run(input?: unknown): void | Promise<void>
}
