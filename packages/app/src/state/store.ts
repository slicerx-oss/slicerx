// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The one client store. Server data (store listings,
// printer status) lives in TanStack Query; this holds what the user is doing.
import type { NamedValue } from '../cad/value-names'
import type {
  ApprovalRequest,
  Bed,
  EasyGoal,
  EasySettings,
  FilamentSlot,
  FileRef,
  PrinterInfo,
  HeightRange,
  MeshHandle,
  MeshPart,
  PreviewBuffers,
  SettingValue,
  SliceProgress,
  SliceResult,
  Workspace,
} from '@slicerx/contracts'
import { FLUSH_DEFAULTS, type FlushSettings } from '../filament/flush-defaults'
import type { CalibId } from '../calibration/tests'
import type { SlotSetup } from '../filament/slots'
import type { UserPreset, PresetKind } from '../presets/store'
import type { SyncChange, Tombstone } from '../presets/sync'
import type { LayerMark } from '../plate/layer-marks'
import type { Dimension } from '../geom/cad'
import type { History } from '../cad/history/model'
import type { Spool } from '../inventory/spools'
import type { QueueItem } from '../queue/queue'
import type { SendOptionId } from '../send/options'
import type { PrintSheetAsk } from '../send/print-sheet'
import { EASY_DEFAULTS, type FirstRunState, type LookAndFeelChoice } from '@slicerx/contracts'
import { DEFAULT_THEME_IDS, THEME_FONT_CHOICE, type FontChoice, type ThemeFile, type ThemeIds } from '@slicerx/ui/theme'
import { createStore, useStore } from 'zustand'
import { normalizeEasy } from '../lib/easy-values'
import { GENERIC_BED } from '../adapters/generic-bed'
import { loadUserThemes } from '../theme/load'
import { DEFAULT_PLAYBACK_SPEED, hasStoredPrefs, loadPrefs, savePrefs, type HandPrinter, type PrinterBay, type Prefs } from './prefs'
import type { DryMark } from '../filament/dry-marks'



export type Goal = EasyGoal | 'custom'
export type PrepareLook = 'studio' | 'clay' | 'xray' | 'overhang' | 'filament'
export type CameraView = 'iso' | 'top' | 'front' | 'fit'
export type ColorMode = 'feature' | 'tool' | 'speed' | 'flow' | 'layerTime'
export type Side = 'left' | 'right'

export interface NornState {
  /**
   * The toolpath clicked in Preview: its feature, layer, where on screen the click landed, and the plate entry it
   * belongs to (null for the skirt, a shared brim, the prime tower, or a plate of one object).
   */
  pick: { feature: number; layer: number; gcodeLine: number; screen: [number, number]; objectId: string | null } | null
  /** The slice as it was before the first change made from Preview, until the person keeps or undoes the change. */
  before: { timeS: number; grams: number; preview: PreviewBuffers; overrides: Record<string, SettingValue>; objectSettings: Record<string, Record<string, SettingValue>> } | null
  /** Draw the old paths as a faint layer under the new ones. */
  ghost: boolean
}

/** Modeling tools that work in the 3D view; their panel sits in the sidebar while one is on. */
export type CadTool = 'shape' | 'facetext' | 'array' | 'measure' | 'push' | 'sketch' | 'facesvg' | 'fillet' | 'holefit' | 'thread' | 'shell' | 'values'
export const CAD_TOOLS: readonly CadTool[] = ['shape', 'facetext', 'array', 'measure', 'push', 'sketch', 'facesvg', 'fillet', 'holefit', 'thread', 'shell', 'values']
export const isCadTool = (t: string | null): t is CadTool => t !== null && (CAD_TOOLS as readonly string[]).includes(t)

export interface PlateEntry {
  id: string
  name: string
  handle: MeshHandle
  /** Geometry in mm, Z up, for the viewport. */
  parts: MeshPart[]
  colors: string[]
  /** 4x4 column-major, mm. */
  transform: number[]
  thumb?: string
  /** Set on an instance: the id of the object it copies. Instances share the mesh. */
  instanceOf?: string
  /**
   * Painted triangles by part index and layer (color, seam, support, fuzzy skin), as the `paint_color` style text Bambu
   * Studio and OrcaSlicer write, keyed by triangle index into the part.
   */
  paint?: PaintData
  /** Negative volumes and support blockers or enforcers, in the object's own coordinates. */
  volumes?: PlateVolumeEntry[]
  /** Locked: the object cannot be moved, rotated, scaled or rearranged until it is unlocked. */
  locked?: boolean
  /** Off keeps the object on the plate but out of the slice (Orca's toggle printable). Absent means printable. */
  printable?: boolean
  /** The filament a part prints in when it differs from the file, by part name. */
  slotOverrides?: Record<string, number>
  /** Orca key overrides for single parts, by part name. They print in the part's own area. */
  partSettings?: Record<string, Record<string, SettingValue>>
  /** Painted brim ears: [x, y, z, headRadius] in the mesh's own space, mm. Used when the brim type is painted. */
  brimPoints?: [number, number, number, number][]
  /** Where the model came from, for the sx3mf metadata: the library model id and its creator's id. */
  source?: ModelSource
  /** Kept dimensions that start on this object. Anchors are in its mesh's own coordinates; `object` is a plate object id. */
  dimensions?: Dimension[]
  /** The CAD steps done to this object since it was imported or made (docs/cad-history.md). */
  history?: History
}

/** A history step open for editing: the object shows the result before it while its tool panel is open. */
export interface HistoryEdit {
  objectId: string
  /** The step's index in the object's history. */
  index: number
  /** The object as it was before the view rolled back; put back on finish or cancel. */
  original: PlateEntry
  /** Only looking: the part shows the result right after step `index`, and no tool is open. */
  view?: boolean
}

export interface ProfileInfo {
  printerId: string
  /** The nozzle size in use (mm), the sizes the printer model offers, and where the size came from. */
  nozzle: number
  nozzles: number[]
  nozzleFrom: 'printer' | 'choice' | 'default'
  tier: string
  source: 'orca' | 'slicerx'
  /** The custom G-code in the layer is the text shipped for the model. */
  shippedGcode: boolean
  gcodeKeys: string[]
  limits: { nozzleMaxC?: number; bedMaxC?: number }
  /** Each slot's filament preset id (`GFA00`), empty for a slot without a shipped preset; Bambu printers read it per tray. */
  filamentIds?: string[]
}

export interface PresetSyncState {
  deleted: Tombstone[]
  changes: SyncChange[]
  lastAt: number
}

export type PaintLayerName = 'color' | 'seam' | 'support' | 'fuzzy'
export type PaintData = Record<number, Partial<Record<PaintLayerName, Record<number, string>>>>

export type VolumeRole = 'negative' | 'support_blocker' | 'support_enforcer' | 'modifier'

export interface PlateVolumeEntry {
  id: string
  name: string
  role: VolumeRole
  handle: MeshHandle
  /** Geometry centered on its own origin, for the viewport. */
  part: MeshPart
  /** Placement in the object's coordinates, 4x4 column-major, mm. The slice request gets it composed with the object's transform. */
  local: number[]
  /** A modifier's setting overrides, Orca keys. */
  settings?: Record<string, SettingValue>
}

export interface ModelSource {
  modelId?: string
  creatorId?: string
}

export type SliceState =
  | { status: 'idle' }
  | { status: 'running'; progress: SliceProgress | null; startedAt: number }
  | { status: 'done'; result: SliceResult; stale: boolean }
  | { status: 'error'; message: string }

export interface PendingApproval {
  requests: ApprovalRequest[]
  /** Preflight results: errors block Approve, warnings are shown for the person to weigh. */
  checks?: { errors: string[]; warnings: string[] }
  /** A statement the approve button confirms, such as "The bed is clear". Pressing the button is the answer. */
  confirm?: string
  /** The approve button's label when it carries `confirm`, the statement first: "Bed is clear, start print". */
  go?: string
  approve: () => Promise<void>
  deny: () => Promise<void>
}

export interface AppState {
  workspace: Workspace
  /** Expanded (true) or collapsed to an icon rail (false), per workspace and side. */
  rails: Prefs['rails']
  commandOpen: boolean
  recents: string[]
  /** Toolpath colors: the standard set, or one for color vision deficiency. */
  toolpathPalette: 'standard' | 'colorblind'
  /** Preview draws the moving toolhead; the rack, dock, chute and wiper show either way. */
  showToolhead: boolean
  /** Preview playback speed, times real time (PLAYBACK_SPEEDS). */
  playbackSpeed: number
  /** Preview playback keeps the camera on the nozzle. */
  followNozzle: boolean
  toast: { id: number; text: string; tone?: 'ok' | 'info' | 'warn' | 'error'; action?: ToastAction } | null
  aboutOpen: boolean
  /** The Settings dialog, and the section it opens on. */
  settingsOpen: boolean
  settingsSection: string | null
  /** The approval card on screen, if any. Only its buttons can resolve it. */
  approval: PendingApproval | null
  bed: Bed
  plate: PlateEntry[]
  plateLoading: boolean
  /** A long arrange or fill the bed in progress: layouts tried and planned. */
  arranging: { done: number; total: number } | null
  selection: string | null
  /** Every selected object, primary included. Stale when it does not contain `selection`; use selectedIds(). */
  selectedIds: string[]
  printerId: string | null
  /** Per extruder printable areas of the selected printer (dual nozzle only), loaded from its profile. */
  extruderAreas: [number, number][][]
  /** The nozzle reach zone the legend points at, for the viewport to brighten. */
  zoneHover: string | null
  easy: EasySettings
  goal: Goal
  overrides: Record<string, SettingValue>
  expertOpen: boolean
  look: PrepareLook
  camera: CameraView
  /** Bumped on every camera command so choosing the same view twice still moves the camera. */
  cameraSeq: number
  slice: SliceState
  preview: PreviewBuffers | null
  colorMode: ColorMode
  layerHi: number
  /** First drawn layer, 1 based (the bottom handle of the layer slider). */
  layerLo: number
  /** 0 to 1: how much of the top visible layer is drawn. */
  moveCut: number
  /** Playback is inside the tool change before `segment`, `seconds` into it (`fixed`: the firmware's seconds of it). */
  toolChange: { segment: number; seconds: number; fixed: number } | null
  /** heimdall: the collision the list has selected (index into the slice's collisions). */
  strikePick: number | null
  /** heimdall: playback runs up to this print time and stops on it; `seq` tells two jumps to one moment apart. */
  strikeJump: { timeS: number; seq: number } | null
  shortcutsOpen: boolean
  /** A prompt handed to the Pilot workspace by a command; it clears it once started. */
  pilotPrompt: string | null
  fleetRefresh: number
  /** Files are being dragged over the window; drop targets glow. */
  dragging: boolean
  scheme: 'dark' | 'light'
  /** What the viewport reports it renders with, for the status line. */
  viewportBackend: string
  /** The stored look and feel, or null before one is chosen (the edition default applies). */
  lookAndFeel: LookAndFeelChoice | null
  /** Follow the operating system's light or dark setting instead of `scheme`. */
  themeFollowsSystem: boolean
  /** Which theme fills the dark and the light slot. */
  themeIds: ThemeIds
  /** Themes the person imported or put in the themes folder. */
  userThemes: ThemeFile[]
  /** Themes read from the desktop themes folder. Not saved: the folder is the source. */
  folderThemes: ThemeFile[]
  /** The person's font choice; "theme" follows the theme's suggestion. */
  fonts: FontChoice
  settingsMode: SettingsMode
  tooltips: { enabled: boolean; media: boolean }
  /** Slice in the background after every edit; off shows the Slice button. */
  autoSlice: boolean
  cadTools: boolean
  /** What a kWh costs the person and the currency symbol in front of it, for the electricity estimate. */
  electricity: { pricePerKwh: number; symbol: string }
  /** Draw every kept dimension, not only those of the selected object. */
  showDimensions: boolean
  /** The project's named values (cad/values.ts), saved with the project. */
  namedValues: NamedValue[]
  /** The nozzle size (mm) chosen for each printer id. */
  printerNozzles: Record<string, number>
  /** Each extruder's nozzle on printers with more than one, by printer id, in the slicer's extruder order (left first on an H2D). */
  printerExtruders: Record<string, import('./prefs').ExtruderNozzle[]>
  /** Printers added by hand that no host knows. They join the host's printers (lib/hand-printers). */
  handPrinters: HandPrinter[]
  /** Bays printers stand in, in the order Printers lists them. */
  bays: PrinterBay[]
  /** The bay each printer stands in, by printer id. */
  printerBays: Record<string, string>
  /** Printers shows one grid of all printers, or a section per bay. */
  printersView: 'all' | 'bay'
  /** The nozzle size the connected printer reports, by printer id. It wins over the choice. */
  nozzleReported: Record<string, number>
  /** Easy controls the person moved off the quality tier. Only these change the maker's process values. */
  easyTouched: string[]
  /** The printer model the slice follows (vendor and model), set from the connected printer. */
  printerModel: { id?: string; vendor: string; model: string } | null
  /** The printer, filament and process layer under the Easy choices, or null when no profile matches. */
  profile: ProfileInfo | null
  /** Pause, color change and custom G-code marks by plate id. */
  layerMarks: Record<string, LayerMark[]>
  /** Pane sizes in px by "look:pane". */
  paneSizes: Record<string, number>
  /** Profile sync bookkeeping: deletions, the change notes and when files were last merged. */
  presetSync: PresetSyncState
  /** Spools from the Spoolman plugin; null until read. */
  spools: Spool[] | null
  /** Slot number to the Spoolman spool id the person linked it to. */
  spoolLinks: Record<number, number>
  queue: QueueItem[]
  /** Sections whose second tier the person opened with More (Simple mode). */
  moreOpen: Record<string, boolean>
  firstRun: FirstRunState | null
  /** The setup flow on screen, and the step it opened at; `byHand` opens the printer step on the hand-made form. Null when closed. */
  setup: { step: SetupStep; byHand?: boolean } | null
  crashReports: boolean
  /** Settings > Appearance > Motion; null until picked, which means the edition's default. */
  motion: 'system' | 'full' | 'reduced' | null
  /** The pre-alpha agreement accepted on this install, or null. */
  agreement: { version: number; acceptedAt: string } | null
  /** The agreement covers the window until it is accepted (pre-alpha builds). */
  agreementOpen: boolean
  /** Random id of this install, for bug reports. Made on first use. */
  installId: string | null
  /** Help, Report a bug. */
  bugReportOpen: boolean
  /** What a screen that offers "Send a report" fills the form with (title and what happened). Cleared when the dialog takes it. */
  bugReportDraft: { title: string; happened: string } | null
  /** "Do not use mimir" in setup: hides the panel and sends nothing to a model. */
  setupPilotOff: boolean
  /** The person chose to slice without a printer, so launch stops opening printer setup when there is none. */
  noPrinter: boolean
  /** mimir's switch and connection. Null on installs from before setup asked: mimir stays on there. Fresh installs start at `unset`. */
  pilot: PilotPref | null
  /** Every plate of the project. The active plate's objects live in `plate`; its entry here holds them only while another plate is active. */
  plates: PlateMeta[]
  activePlate: string
  /** Per-object setting overrides by object id, in Orca keys. */
  objectSettings: Record<string, Record<string, SettingValue>>
  /** What the connected printer reports for its filament slots; the AMS panel keeps it current. */
  printerSlots: FilamentSlot[]
  /** The selected printer's `nozzle_volume` from its profile, the base of every flush volume. */
  printerNozzleVolume: number
  /** The prime tower: the engine picks the spot while auto is on; moving it by hand turns auto off. x and y are the front left corner, mm. */
  tower: { auto: boolean; x: number; y: number }
  /** The tower is the selected thing in the 3D view. */
  towerSelected: boolean
  /** Slots set by hand, by 1-based slot number. */
  slotSetup: Record<number, SlotSetup>
  flush: FlushSettings
  /** Preset matches for what the printer reports, by slot; the AMS panel fills it from the filament presets. */
  slotMatch: Record<number, Pick<SlotSetup, 'brand' | 'family' | 'vendor'>>
  /** The slot being edited (1-based) and the flush volume dialog. */
  slotDialog: number | null
  flushOpen: boolean
  calibrationOpen: boolean
  /** The filament slot the calibration dialog opens for (from its card), or null for the first. */
  calibrationSlot: number | null
  /** Print the rest from this height: set by the rescue screen, read by the next slice. The failed job's layer tops keep the layer numbers the same. */
  resume: { plan: { resumeLayer: number; printedHeightMm: number }; declareZ?: boolean; layerTopsMm?: number[] } | null
  /** norn, edit from Preview: the clicked toolpath, and the slice before a change made there (time, grams and its paths, for the comparison). */
  norn: NornState
  /** The projects dialog: unsaved work offered back after a crash, or the recent projects. */
  projectsDialog: 'recover' | 'recent' | null
  /** Asking whether to save before something replaces the project. `what` finishes "before you ...". */
  unsavedPrompt: { what: string } | null
  /**
   * Printer G-code an opened project carries that is not the printer's stock text, waiting for a person to choose it or
   * the profile's (`asking` while the dialog is open). Until then the plate slices with the profile's.
   */
  projectGcode: { source: string; changes: import('@slicerx/settings').GcodeChange[]; asking: boolean } | null
  /** G-code overrides a person chose from a project, by key, as they chose them. An edit since makes the key untrusted again. */
  vouchedGcode: Record<string, SettingValue>
  /** The .sx3mf file the project was opened from or last saved to, where Save writes without asking. */
  projectFile: FileRef | null
  /** The object tool whose dialog is open (cut, hollow and so on). */
  objectTool: 'cut' | 'hole' | 'hollow' | 'simplify' | CadTool | null
  /** A CAD history step being edited, or null. Not an edit itself: undo and autosave skip the rollback. */
  historyEdit: HistoryEdit | null
  /** A setting the command bar is sending the person to: Expert settings scroll to it, or Printer settings search for it. */
  settingFocus: { key: string; label: string } | null
  /** The printer bridge (sx-link) connection, and a counter that changes whenever the host's printers do. */
  /** `hubKey`: the key of the connected hub. `presentedKey`: after a hub mismatch, the key the program on the port proved. */
  bridgeStatus: { state: 'off' | 'connecting' | 'on' | 'error'; message?: string; hubKey?: string; presentedKey?: string }
  linkEpoch: number
  printerSettingsOpen: boolean
  /** Presets the person saved, and the one of each kind in use. */
  userPresets: UserPreset[]
  activePresets: Partial<Record<PresetKind, string>>
  /** The printer whose camera is open in the player. */
  cameraPlayer: Pick<PrinterInfo, 'id' | 'name'> | null
  /** Last print options chosen per printer id. */
  sendChoices: Partial<Record<string, Partial<Record<SendOptionId, boolean>>>>
  /** "It's dry" answers to the drying note, per printer and slot (filament/dry-marks.ts). */
  dryMarks: Record<string, DryMark>
  /** The Print sheet while it waits for an answer; its check fills in once the file is exported. */
  printSheet: PrintSheetAsk | null
  /** Calibration plates by plate id: what they test and the height bands to slice with. */
  calibration: Record<string, CalibrationRun>
}

export interface CalibrationRun {
  test: CalibId
  /** The filament slot the test printed in; its result is kept for that slot's spool. */
  slot?: number
  /** The values the model steps through, in print order. */
  values: number[]
  /** What the test was built with, so a measurement is read against it. */
  params: Record<string, number>
  /** For towers that change a firmware setting per band: custom G-code at layers, sent with the slice. */
  layerGcode?: { layer: number; kind: 'custom'; gcode: string }[]
  /** For tool path tests (pressure advance lines and pattern): the G-code body that replaces the placeholder's own. */
  body?: string
  /** The firmware commands of each band by its value, for results that are set in the printer and not the profile. */
  bandGcode?: Record<string, string>
  ranges: HeightRange[]
  instructions: string[]
  /** The new spool plate: every test on it, each read on its own. `test`, `values` and `params` above are the first one's. */
  combined?: CalibrationPart[]
}

export interface CalibrationPart {
  test: CalibId
  values: number[]
  params: Record<string, number>
}

export interface PlateSettings {
  /** Bed surface; absent means the printer's default. */
  bedType?: 'cool' | 'engineering' | 'high-temp' | 'textured-pei' | 'smooth-pei'
  /** Print all objects layer by layer, or one object after another; absent follows the Print sequence setting (Orca's "same as global"). */
  sequence?: 'by-layer' | 'by-object'
  /** Filament slots in printing order; absent means slot order. */
  filamentOrder?: number[]
  /** Color swaps: the slot a part's own slot prints in on this plate. Absent slots print as themselves. */
  slotMap?: Record<number, number>
  /**
   * On a printer with two extruders fed by their own AMS: the extruder of each slot (index slot - 1, 1 the left,
   * 2 the right) set by hand. Absent means the slicer picks it.
   */
  nozzleMap?: number[]
}

export interface PlateMeta {
  id: string
  name: string
  objects: PlateEntry[]
  settings: PlateSettings
}

export type SettingsMode = 'simple' | 'advanced' | 'expert' | 'developer'

export interface PilotPref {
  /** on: a model is connected. unset: never connected, so mimir shows and offers the connect step. off: turned off on purpose in Settings. */
  mode: 'on' | 'off' | 'unset'
  provider?: 'openai' | 'anthropic' | 'local'
  baseUrl?: string
  model?: string
}

/** mimir runs (and may call a model) only when this is true. */
export function pilotOn(s: Pick<AppState, 'pilot'> = get()): boolean {
  return s.pilot === null || s.pilot.mode === 'on'
}

/**
 * What mimir shows: `on` is the assistant, `connect` is the connect step (nothing is sent to a
 * model in that state), `off` hides it everywhere. Only Settings, or "Do not use mimir" in the
 * old setup, turns it off.
 */
export function pilotState(s: Pick<AppState, 'pilot' | 'setupPilotOff'> = get()): 'on' | 'connect' | 'off' {
  if (pilotOn(s)) return 'on'
  return s.pilot?.mode === 'unset' && !s.setupPilotOff ? 'connect' : 'off'
}
export type SetupStep = 'welcome' | 'look' | 'cad' | 'pilot' | 'printer' | 'done'

/** Electricity price until the person sets one: $0.15 per kWh. */
export const DEFAULT_ELECTRICITY = { pricePerKwh: 0.15, symbol: '$' }

const firstLaunch = !hasStoredPrefs()
const prefs = loadPrefs()

export const appStore = createStore<AppState>()(() => ({
  workspace: prefs.workspace,
  rails: prefs.rails,
  commandOpen: false,
  recents: prefs.recents,
  toolpathPalette: prefs.toolpathPalette ?? 'standard',
  showToolhead: prefs.showToolhead ?? true,
  playbackSpeed: prefs.playbackSpeed ?? DEFAULT_PLAYBACK_SPEED,
  followNozzle: prefs.followNozzle ?? false,
  toast: null,
  aboutOpen: false,
  settingsOpen: false,
  settingsSection: null,
  approval: null,
  bed: { ...GENERIC_BED },
  plate: [],
  plateLoading: false,
  arranging: null,
  selection: null,
  selectedIds: [],
  printerId: prefs.printerId,
  extruderAreas: [],
  zoneHover: null,
  easy: normalizeEasy(prefs.easy ? { ...EASY_DEFAULTS, ...prefs.easy } : EASY_DEFAULTS),
  goal: prefs.goal,
  overrides: {},
  expertOpen: false,
  look: 'studio',
  camera: 'iso',
  cameraSeq: 0,
  slice: { status: 'idle' },
  preview: null,
  colorMode: 'feature',
  layerHi: 0,
  layerLo: 1,
  moveCut: 1,
  toolChange: null,
  strikePick: null,
  strikeJump: null,
  shortcutsOpen: false,
  pilotPrompt: null,
  fleetRefresh: 0,
  dragging: false,
  viewportBackend: '',
  scheme: prefs.scheme,
  lookAndFeel: (prefs.lookAndFeel ?? null) as LookAndFeelChoice | null,
  themeFollowsSystem: prefs.themeFollowsSystem ?? false,
  themeIds: prefs.themeIds ?? DEFAULT_THEME_IDS,
  userThemes: loadUserThemes(prefs.userThemes),
  folderThemes: [],
  fonts: prefs.fonts ?? THEME_FONT_CHOICE,
  settingsMode: prefs.settingsMode ?? 'simple',
  tooltips: prefs.tooltips ?? { enabled: true, media: true },
  autoSlice: prefs.autoSlice ?? !noAutoSliceDefault(),
  cadTools: prefs.cadTools ?? true,
  electricity: prefs.electricity ?? DEFAULT_ELECTRICITY,
  showDimensions: false,
  namedValues: [],
  printerNozzles: prefs.printerNozzles ?? {},
  printerExtruders: prefs.printerExtruders ?? {},
  handPrinters: prefs.handPrinters ?? [],
  bays: prefs.bays ?? [],
  printerBays: prefs.printerBays ?? {},
  printersView: prefs.printersView ?? 'all',
  nozzleReported: {},
  easyTouched: prefs.easyTouched ?? [],
  printerModel: null,
  profile: null,
  layerMarks: {},
  paneSizes: prefs.paneSizes ?? {},
  presetSync: (prefs.presetSync ?? { deleted: [], changes: [], lastAt: 0 }) as PresetSyncState,
  spools: null,
  spoolLinks: (prefs.spoolLinks ?? {}) as Record<number, number>,
  queue: (prefs.queue ?? []) as QueueItem[],
  moreOpen: {},
  firstRun: (prefs.firstRun ?? null) as FirstRunState | null,
  // Setup opens by itself only on an install that has never stored anything.
  setup: firstLaunch ? { step: 'welcome' } : null,
  crashReports: prefs.crashReports ?? false,
  motion: prefs.motion ?? null,
  agreement: prefs.agreement ?? null,
  agreementOpen: false,
  installId: prefs.installId ?? null,
  bugReportOpen: false,
  bugReportDraft: null,
  setupPilotOff: prefs.setupPilotOff ?? false,
  noPrinter: prefs.noPrinter ?? false,
  // A fresh install has no model: mimir shows the connect step until the person connects one.
  pilot: (prefs.pilot ?? (firstLaunch ? { mode: 'unset' } : null)) as PilotPref | null,
  plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }],
  activePlate: 'plate-1',
  objectSettings: {},
  printerSlots: [],
  printerNozzleVolume: 0,
  tower: { auto: true, x: 0, y: 0 },
  towerSelected: false,
  slotSetup: {},
  flush: FLUSH_DEFAULTS,
  slotMatch: {},
  slotDialog: null,
  flushOpen: false,
  calibrationOpen: false,
  calibrationSlot: null,
  resume: null,
  norn: { pick: null, before: null, ghost: false },
  projectsDialog: null,
  unsavedPrompt: null,
  projectGcode: null,
  vouchedGcode: {},
  projectFile: null,
  objectTool: null,
  historyEdit: null,
  settingFocus: null,
  bridgeStatus: { state: 'off' },
  linkEpoch: 0,
  printerSettingsOpen: false,
  userPresets: [],
  activePresets: (prefs.activePresets ?? {}) as Partial<Record<PresetKind, string>>,
  cameraPlayer: null,
  sendChoices: prefs.sendChoices ?? {},
  dryMarks: prefs.dryMarks ?? {},
  printSheet: null,
  calibration: {},
}))

/** Browser tests drive the Slice button, so they turn the default off with this session flag. A saved choice always wins. */
function noAutoSliceDefault(): boolean {
  try {
    return sessionStorage.getItem('sx-no-auto-slice') === '1'
  } catch {
    return false
  }
}


const PERSISTED = ['workspace', 'rails', 'recents', 'toolpathPalette', 'showToolhead', 'playbackSpeed', 'followNozzle', 'easy', 'goal', 'printerId', 'scheme', 'lookAndFeel', 'themeFollowsSystem', 'themeIds', 'userThemes', 'fonts', 'settingsMode', 'tooltips', 'autoSlice', 'cadTools', 'electricity', 'printerNozzles', 'printerExtruders', 'handPrinters', 'bays', 'printerBays', 'printersView', 'easyTouched', 'paneSizes', 'queue', 'spoolLinks', 'presetSync', 'firstRun', 'crashReports', 'motion', 'agreement', 'installId', 'setupPilotOff', 'noPrinter', 'pilot', 'sendChoices', 'dryMarks', 'activePresets'] as const satisfies readonly (keyof AppState)[]

appStore.subscribe((s, prev) => {
  if (PERSISTED.some((k) => s[k] !== prev[k])) {
    savePrefs({
      workspace: s.workspace,
      rails: s.rails,
      recents: s.recents,
      toolpathPalette: s.toolpathPalette,
      showToolhead: s.showToolhead,
      playbackSpeed: s.playbackSpeed,
      followNozzle: s.followNozzle,
      easy: s.easy,
      goal: s.goal,
      printerId: s.printerId,
      scheme: s.scheme,
      lookAndFeel: s.lookAndFeel as Prefs['lookAndFeel'],
      themeFollowsSystem: s.themeFollowsSystem,
      themeIds: s.themeIds,
      userThemes: s.userThemes,
      fonts: s.fonts,
      settingsMode: s.settingsMode,
      tooltips: s.tooltips,
      autoSlice: s.autoSlice,
      cadTools: s.cadTools,
      electricity: s.electricity,
      printerNozzles: s.printerNozzles,
      printerExtruders: s.printerExtruders,
      handPrinters: s.handPrinters,
      bays: s.bays,
      printerBays: s.printerBays,
      printersView: s.printersView,
      easyTouched: s.easyTouched,
      queue: s.queue as Prefs['queue'],
      paneSizes: s.paneSizes,
      presetSync: s.presetSync as Prefs['presetSync'],
      spoolLinks: s.spoolLinks,
      firstRun: s.firstRun as Prefs['firstRun'],
      crashReports: s.crashReports,
      ...(s.motion ? { motion: s.motion } : {}),
      agreement: s.agreement,
      ...(s.installId ? { installId: s.installId } : {}),
      setupPilotOff: s.setupPilotOff,
      noPrinter: s.noPrinter,
      pilot: s.pilot as Prefs['pilot'],
      sendChoices: s.sendChoices as Prefs['sendChoices'],
      dryMarks: s.dryMarks,
      activePresets: s.activePresets as Prefs['activePresets'],
    })
  }
})

export function useApp<T>(select: (s: AppState) => T): T {
  return useStore(appStore, select)
}

export const set = appStore.setState
export const get = appStore.getState

let toastSeq = 0
/** A button on a toast, for example an undo. */
export interface ToastAction {
  label: string
  run: () => void
}

export function toast(text: string, tone?: 'ok' | 'info' | 'warn' | 'error', action?: ToastAction): void {
  set({ toast: { id: ++toastSeq, text, ...(tone ? { tone } : {}), ...(action ? { action } : {}) } })
}

/** The selected objects: the multi-selection when it includes the primary, else just the primary. */
export function selectedIds(s: Pick<AppState, 'selection' | 'selectedIds'> = get()): string[] {
  if (!s.selection) return []
  return s.selectedIds.includes(s.selection) ? s.selectedIds : [s.selection]
}

export function setWorkspace(ws: Workspace): void {
  if (get().workspace !== ws) set({ workspace: ws })
}

/** Opens Settings, on a section when given. */
export function openSettings(section?: string): void {
  set({ settingsOpen: true, settingsSection: section ?? null })
}

/** Default rail state: expanded on wide windows, collapsed below 1200 px */
export function railOpen(rails: AppState['rails'], ws: Workspace, side: Side, wide: boolean): boolean {
  return rails[ws]?.[side] ?? wide
}

export function setRail(ws: Workspace, side: Side, open: boolean): void {
  const rails = get().rails
  set({ rails: { ...rails, [ws]: { ...rails[ws], [side]: open } } })
}

/** Any settings or plate change marks a finished slice stale instead of discarding it. */
export function markStale(): void {
  const s = get().slice
  if (s.status === 'done' && !s.stale) set({ slice: { ...s, stale: true } })
}

export function pushRecent(id: string): void {
  const recents = [id, ...get().recents.filter((r) => r !== id)].slice(0, 8)
  set({ recents })
}

export function setCamera(camera: CameraView): void {
  set((s) => ({ camera, cameraSeq: s.cameraSeq + 1 }))
}
