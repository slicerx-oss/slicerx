// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// First-run look and feel: the preset ids, the shape of a preset, the stored choice and the
// first-run state. The viewport reads its own camera map by id, the app shell reads `layout`,
// the theme reads `look`. The preset values live in @slicerx/ui (docs/look-and-feel.md), not here.
// The other presets are described as "<name> style". No logos or artwork from those apps.

export const LOOK_IDS = ['slicerx', 'bambu-studio', 'prusaslicer', 'orcaslicer'] as const
export type LookId = (typeof LOOK_IDS)[number]

/**
 * A named keymap. One per look; a user override is stored next to the choice.
 * The keymaps themselves are defined in docs/look-and-feel.md section 4 and live in @slicerx/ui.
 */
export type KeymapId = LookId

/** Ids of the four camera and mouse maps. The maps live in the viewport (`ControlsMap`, keyed by LookId) so it stays independent of this package. */
export type ControlsId = LookId

/** Read by the app shell. Spec details and per preset values: docs/look-and-feel.md section 2. */
export interface LayoutSpec {
  /** Order of the top tabs, by workspace id. */
  workspaceTabs: readonly string[]
  /** Tab label per workspace id when the look renames it (Bambu style shows Device for the Printers workspace). Absent ids use the default label. */
  tabLabels?: Record<string, string>
  /** Sidebar sections, or separate Print, Filament and Printer tabs. */
  settingsModel: 'sidebar' | 'tabs'
  sidebar: { side: 'left' | 'right'; width: number; resizable: true; collapseKey: string | null }
  /** Where the object list sits in the sidebar: under the settings, above everything, or between the filament and the print settings. */
  objectList: 'sidebar-below-settings' | 'sidebar-above-settings' | 'sidebar-after-filament'
  objectPanel: 'inline-table' | 'popover'
  toolbar: 'top-of-viewport' | 'left-of-viewport'
  plateList: 'thumbnails-bottom' | 'sidebar' | 'hidden-single'
  primaryAction: { placement: 'sidebar-footer' | 'viewport-bottom-right'; label: 'Slice plate' | 'Slice now' }
  layerSlider: { vertical: 'right'; horizontal: 'bottom' | 'below-legend'; timePlayback: boolean }
  legend: 'left-overlay' | 'right-overlay'
  modes: readonly ('simple' | 'advanced' | 'expert' | 'developer')[]
  modeSelector: 'sidebar' | 'top-right' | 'preferences-only'
  /** Bambu style Global and Objects switch at the top of process settings. */
  globalObjectSwitch: boolean
  viewSwitcher: 'tabs' | 'tabs-and-lower-left'
}

/** Read by the theme. Token names resolve through CSS variables in @slicerx/ui. */
export interface LookSpec {
  density: 'compact' | 'standard' | 'roomy'
  accent: 'purple' | 'green' | 'orange' | 'cyan'
  radius: 'sharp' | 'soft' | 'round'
  rowHeight: 'sm' | 'md' | 'lg'
  displayFont: boolean
  gradientPrimary: boolean
  iconSize: 16 | 18
  iconStroke: 1.5 | 1.75
  hairlines: 'lines' | 'boxes'
}

/**
 * One preset. The values are defined once, in @slicerx/ui (`resolvePreset(id)`), because design owns
 * them; `controls` is only an id (the viewport owns the map) and `layout` is interpreted by the app.
 */
export interface LookAndFeelPreset {
  id: LookId
  /** Picker label, sentence case: "SlicerX", "Bambu Studio style". */
  label: string
  /** One line under the label. */
  summary: string
  controls: ControlsId
  keys: KeymapId
  layout: LayoutSpec
  look: LookSpec
  defaultTheme: 'nocturne' | 'system'
}

/** Picker labels, in the owner's order. The full preset (layout, look) comes from @slicerx/ui `resolvePreset`. */
export const LOOK_OPTIONS: Record<LookId, { label: string; summary: string }> = {
  slicerx: { label: 'SlicerX', summary: 'The default. Bambu Studio flow, tuned for speed and mimir.' },
  'bambu-studio': { label: 'Bambu Studio style', summary: 'Left settings sidebar, top tabs, Global and Objects switch.' },
  prusaslicer: { label: 'PrusaSlicer style', summary: 'Right sidebar, Simple, Advanced and Expert modes, orthographic toggle.' },
  orcaslicer: { label: 'OrcaSlicer style', summary: 'Bambu-like layout with more tuning controls and mappable mouse buttons.' },
}

/** Stored per install by the host settings store; the first-run flow writes it once and Settings can change it. */
export interface LookAndFeelChoice {
  id: LookId
  /** Per-part overrides after the preset is applied, so a user can keep Bambu controls with the SlicerX layout. */
  overrides?: { controls?: Record<string, unknown>; keys?: Record<string, string>; layout?: Partial<LayoutSpec>; look?: Partial<LookSpec> }
}

/** Steps of the first-run flow in order. mimir can drive `printer` through the printer setup tools. */
export const FIRST_RUN_STEPS = ['look', 'printer', 'open', 'done'] as const
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number]

export interface FirstRunState {
  completedAt: string | null
  step: FirstRunStep
  look: LookAndFeelChoice
  /** Printer chosen during setup, by printer profile id; null while skipped. */
  printerId: string | null
}

/** How to reach a printer. Only `family` and `address` are always needed; the rest depends on the family (Bambu Lab needs `serial` and the access code as `credential`). */
export interface PrinterConnection {
  family: string
  address: string
  serial?: string
  username?: string
  /** Access code, API key or password. Goes to the OS keychain, never into config, logs, tool results or return values. */
  credential?: string
}

export interface PrinterSetupHost {
  /** Discover printers on the network. No credentials, cancellable, only runs when called. */
  discover(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<{ id: string; name: string; family: string; address?: string }[]>
  /** Search the profile library by vendor or model text. */
  searchProfiles(query: string): Promise<{ id: string; vendor: string; model: string; nozzles: number[] }[]>
  /** Reach the printer, sign in and read state and temperatures, without registering anything. */
  testConnection(connection: PrinterConnection): Promise<{
    ok: boolean
    state?: string
    /** Why it failed: unreachable, auth, timeout, protocol, not_supported, bad_request (not a local address) or local (it stopped on this computer before reaching the printer). */
    cause?: 'unreachable' | 'auth' | 'timeout' | 'protocol' | 'not_supported' | 'bad_request' | 'local'
    message?: string
    /** How far it got. `ok: null` means an earlier step failed, so this one never ran. */
    steps: { id: 'reach' | 'sign_in' | 'read_state' | 'read_temperatures'; ok: boolean | null }[]
  }>
  /** Add a printer with a profile, nozzle diameter in mm and optional connection. Requires approval because it stores credentials. */
  addPrinter(input: { profileId: string; nozzleMm: number; connection?: PrinterConnection }): Promise<{ printerId: string }>
}
