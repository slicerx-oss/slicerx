// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Per-user conveniences kept in localStorage. Anything read back from storage may be old, edited
// or corrupt, so every field is checked by hand and a bad one falls back to its default on its
// own. No schema library: this runs before first paint and stays out of the shell budget.
import { LOOK_IDS, type LookAndFeelChoice, type FirstRunState } from '@slicerx/contracts'

const KEY = 'slicerx.prefs.v1'

export interface Prefs {
  workspace: string
  rails: Record<string, { left?: boolean; right?: boolean }>
  recents: string[]
  /** Read once, for the move into appearance.colorVision. */
  toolpathPalette?: 'standard' | 'colorblind' | undefined
  /** Settings > Look and feel: text, contrast, color vision, density and accent. */
  appearance?: Appearance | undefined
  /** Slice sidebar sections folded to their summary line, by section id (printer, filament). */
  sidebarFolds?: Record<string, boolean> | undefined
  /** Preview draws the moving toolhead (the machine's fixed parts show either way). */
  showToolhead?: boolean | undefined
  /** Preview playback speed, times real time; the last choice is kept. */
  playbackSpeed?: number | undefined
  /** Preview playback keeps the camera on the nozzle. */
  followNozzle?: boolean | undefined
  easy: { detail: number; strength: number; speed: 'quality' | 'balanced' | 'fast' | 'fastest' | 'gentle' | 'maximum' | 'silent' | 'standard' | 'sport' | 'ludicrous'; supports: 'off' | 'auto' | 'painted' | 'everywhere'; brim: boolean; varyLayerHeight?: boolean; smartLayer?: 'off' | 'quality' | 'strength' } | null
  goal: 'draft' | 'standard' | 'fine' | 'strong' | 'custom'
  printerId: string | null
  scheme: 'dark' | 'light'
  lookAndFeel?: LookAndFeelChoice | null | undefined
  firstRun?: FirstRunState | null | undefined
  themeFollowsSystem?: boolean | undefined
  themeIds?: { dark: string; light: string } | undefined
  userThemes?: unknown[] | undefined
  fonts?: { ui: string; mono: string } | undefined
  settingsMode?: 'simple' | 'advanced' | 'expert' | 'developer' | undefined
  crashReports?: boolean | undefined
  /** Settings > Appearance > Motion; absent means the edition's default. */
  motion?: 'system' | 'full' | 'reduced' | undefined
  /** The pre-alpha agreement the person accepted, and when (ISO date). */
  agreement?: { version: number; acceptedAt: string } | null | undefined
  /** Random id of this install, sent with bug reports so the rate limit and repeats can be told apart. */
  installId?: string | undefined
  cadTools?: boolean | undefined
  /** The mode the first tab opens in: Slice or Design. */
  modelModeDefault?: 'slice' | 'design' | undefined
  /** How Slice shows the slice: solid models, layer lines on them, or the toolpaths in their place. */
  sliceLook?: 'solid' | 'print' | 'toolpaths' | undefined
  autoSlice?: boolean | undefined
  electricity?: { pricePerKwh: number; symbol: string } | undefined
  tooltips?: { enabled: boolean; media: boolean } | undefined
  setupPilotOff?: boolean | undefined
  noPrinter?: boolean | undefined
  activePresets?: { printer?: string; filament?: string; process?: string } | undefined
  sendChoices?: Record<string, Record<string, boolean>> | undefined
  dryMarks?: Record<string, { at: number; spool: string }> | undefined
  presetSync?: { deleted: { id: string; at: number }[]; changes: { at: number; id: string; name: string; kind: 'printer' | 'filament' | 'process'; action: 'added' | 'updated' | 'removed'; keys?: string[]; conflict?: boolean }[]; lastAt: number } | undefined
  printerNozzles?: Record<string, number> | undefined
  printerExtruders?: Record<string, ExtruderNozzle[]> | undefined
  handPrinters?: HandPrinter[] | undefined
  /** Bays printers stand in (a rack, a desk), in the order Printers lists them. */
  bays?: PrinterBay[] | undefined
  /** The bay each printer stands in, by printer id. A printer with none is unassigned. */
  printerBays?: Record<string, string> | undefined
  /** Printers shows one grid of all printers, or a section per bay. */
  printersView?: 'all' | 'bay' | undefined
  easyTouched?: string[] | undefined
  paneSizes?: Record<string, number> | undefined
  spoolLinks?: Record<string, number> | undefined
  queue?: { id: string; printerId: string; printerName: string; plateName: string; remote: { printerId: string; path: string; name: string }; sha256: string; layers: number; timeS: number; grams: number; options: Record<string, boolean>; startAfter?: string; addedAt: string }[] | undefined
  pilot?: { mode: 'on' | 'off' | 'unset'; provider?: 'openai' | 'anthropic' | 'local'; baseUrl?: string; model?: string } | null | undefined
}

/** A printer added by hand in setup that no host knows: it slices and exports, and takes no jobs. */
export interface HandPrinter {
  id: string
  name: string
  /** Catalog model id, which is also the printer profile id. */
  profileId: string
  vendor: string
  model: string
  nozzleCount: number
  filamentSystem?: 'ams' | 'mmu' | 'toolchanger'
  /** Where it is, kept for when a printer bridge can reach it. The access code is never kept here. */
  connection?: { family: string; address: string; serial?: string; needsSecret: boolean }
}

/** A bay printers stand in, with where it is. */
export interface PrinterBay {
  id: string
  name: string
  place?: string
}

// Guards: each returns the value when it has the right shape, else undefined, and callers pick the default.
type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined)
/**
 * Preview playback speeds, times real time. A fast printer at real speed is faithful but hard to follow, so a
 * first view plays at half speed; the faster ones cover a whole print.
 */
export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 5, 10, 50, 100] as const
export const DEFAULT_PLAYBACK_SPEED = 0.5
const num = (v: unknown, min = -Infinity, max = Infinity): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined)
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
const oneOf = <T extends string>(v: unknown, options: readonly T[]): T | undefined => (options.includes(v as T) ? (v as T) : undefined)
const list = <T>(v: unknown, max: number, each: (x: unknown) => T | undefined): T[] | undefined => {
  if (!Array.isArray(v) || v.length > max) return undefined
  const out: T[] = []
  for (const x of v) {
    const y = each(x)
    if (y === undefined) return undefined
    out.push(y)
  }
  return out
}
/** A record whose keys match `key` and whose values pass `each`; entries that do not are dropped. */
const record = <T>(v: unknown, key: (k: string) => boolean, each: (x: unknown) => T | undefined): Record<string, T> | undefined => {
  if (!isRec(v)) return undefined
  const out: Record<string, T> = {}
  for (const [k, x] of Object.entries(v)) {
    if (!key(k)) continue
    const y = each(x)
    if (y !== undefined) out[k] = y
  }
  return out
}
const nullable = <T>(v: unknown, each: (x: unknown) => T | undefined): T | null | undefined => (v === null ? null : each(v))
const WORKSPACE = /^[a-z][a-z0-9-]{0,31}$/
const workspace = (v: unknown) => (typeof v === 'string' && WORKSPACE.test(v) ? v : undefined)

function lookChoice(v: unknown): LookAndFeelChoice | undefined {
  if (!isRec(v)) return undefined
  const id = oneOf(v['id'], LOOK_IDS)
  if (!id) return undefined
  const o = v['overrides']
  if (o === undefined) return { id }
  if (!isRec(o)) return undefined
  const overrides: NonNullable<LookAndFeelChoice['overrides']> = {}
  const c = o['controls']
  if (isRec(c)) {
    const controls: Record<string, unknown> = {}
    const remap = c['remap']
    if (isRec(remap)) {
      const r: Record<string, 'rotate' | 'pan' | 'zoom' | null> = {}
      for (const b of ['left', 'middle', 'right']) {
        const a = remap[b]
        if (a === null) r[b] = null
        else {
          const action = oneOf(a, ['rotate', 'pan', 'zoom'] as const)
          if (action) r[b] = action
        }
      }
      controls['remap'] = r
    }
    for (const k of ['invert', 'zoomToCursor', 'freeCamera']) {
      const b = bool(c[k])
      if (b !== undefined) controls[k] = b
    }
    overrides.controls = controls
  }
  const keys = record(o['keys'], (k) => k.length <= 40, (x) => str(x, 40))
  if (keys) overrides.keys = keys
  if (isRec(o['layout'])) overrides.layout = o['layout'] as NonNullable<NonNullable<LookAndFeelChoice['overrides']>['layout']>
  if (isRec(o['look'])) overrides.look = o['look'] as NonNullable<NonNullable<LookAndFeelChoice['overrides']>['look']>
  return { id, overrides }
}

function firstRun(v: unknown): FirstRunState | undefined {
  if (!isRec(v)) return undefined
  const completedAt = nullable(v['completedAt'], (x) => str(x, 40))
  const step = oneOf(v['step'], ['theme', 'look', 'printer', 'open', 'done'] as const)
  const look = lookChoice(v['look'])
  const printerId = nullable(v['printerId'], (x) => str(x, 80))
  if (completedAt === undefined || !step || !look || printerId === undefined) return undefined
  const version = num(v['version'], 1, 1e6)
  return { completedAt, step, look, printerId, ...(version !== undefined ? { version: Math.floor(version) } : {}) }
}

function easy(v: unknown): Prefs['easy'] | undefined {
  if (!isRec(v)) return undefined
  const detail = num(v['detail'], 0, 100)
  const strength = num(v['strength'], 0, 100)
  const speed = oneOf(v['speed'], ['quality', 'balanced', 'fast', 'fastest', 'gentle', 'maximum', 'silent', 'standard', 'sport', 'ludicrous'] as const)
  const supports = oneOf(v['supports'], ['off', 'auto', 'painted', 'everywhere'] as const)
  const brim = bool(v['brim'])
  if (detail === undefined || strength === undefined || !speed || !supports || brim === undefined) return undefined
  const vary = bool(v['varyLayerHeight'])
  const smart = oneOf(v['smartLayer'], ['off', 'quality', 'strength'] as const)
  return { detail, strength, speed, supports, brim, ...(vary !== undefined ? { varyLayerHeight: vary } : {}), ...(smart ? { smartLayer: smart } : {}) }
}

function queueItem(v: unknown): NonNullable<Prefs['queue']>[number] | undefined {
  if (!isRec(v) || !isRec(v['remote'])) return undefined
  const r = v['remote']
  const id = str(v['id'], 40), printerId = str(v['printerId'], 80), printerName = str(v['printerName'], 100), plateName = str(v['plateName'], 100)
  const rp = str(r['printerId'], 80), rpath = str(r['path'], 300), rname = str(r['name'], 200)
  const sha256 = str(v['sha256'], 80), layers = num(v['layers']), timeS = num(v['timeS']), grams = num(v['grams']), addedAt = str(v['addedAt'], 40)
  const options = record(v['options'], () => true, bool)
  if (!id || !printerId || !printerName || !plateName || !rp || !rpath || !rname || !sha256 || layers === undefined || timeS === undefined || grams === undefined || !addedAt || !options) return undefined
  const startAfter = str(v['startAfter'], 40)
  return { id, printerId, printerName, plateName, remote: { printerId: rp, path: rpath, name: rname }, sha256, layers, timeS, grams, options, addedAt, ...(startAfter ? { startAfter } : {}) }
}

function presetSync(v: unknown): Prefs['presetSync'] | undefined {
  if (!isRec(v)) return undefined
  const deleted = list(v['deleted'], 500, (x) => {
    if (!isRec(x)) return undefined
    const id = str(x['id'], 60), at = num(x['at'])
    return id && at !== undefined ? { id, at } : undefined
  })
  const changes = list(v['changes'], 200, (x) => {
    if (!isRec(x)) return undefined
    const at = num(x['at']), id = str(x['id'], 60), name = str(x['name'], 100)
    const kind = oneOf(x['kind'], ['printer', 'filament', 'process'] as const), action = oneOf(x['action'], ['added', 'updated', 'removed'] as const)
    if (at === undefined || !id || !name || !kind || !action) return undefined
    const keys = list(x['keys'], 200, (k) => str(k, 80))
    const conflict = bool(x['conflict'])
    return { at, id, name, kind, action, ...(keys ? { keys } : {}), ...(conflict !== undefined ? { conflict } : {}) }
  })
  const lastAt = num(v['lastAt'])
  return deleted && changes && lastAt !== undefined ? { deleted, changes, lastAt } : undefined
}

function handPrinter(v: unknown): HandPrinter | undefined {
  if (!isRec(v)) return undefined
  const id = str(v['id'], 80), name = str(v['name'], 100), profileId = str(v['profileId'], 80), vendor = str(v['vendor'], 60), model = str(v['model'], 100)
  const nozzleCount = num(v['nozzleCount'], 1, 16)
  if (!id || !name || !profileId || !vendor || !model || nozzleCount === undefined) return undefined
  const filamentSystem = oneOf(v['filamentSystem'], ['ams', 'mmu', 'toolchanger'] as const)
  const c = v['connection']
  const family = isRec(c) ? str(c['family'], 40) : undefined, address = isRec(c) ? str(c['address'], 200) : undefined
  const serial = isRec(c) ? str(c['serial'], 60) : undefined, needsSecret = isRec(c) ? bool(c['needsSecret']) : undefined
  const connection = family && address && needsSecret !== undefined ? { family, address, needsSecret, ...(serial ? { serial } : {}) } : undefined
  return { id, name, profileId, vendor, model, nozzleCount, ...(filamentSystem ? { filamentSystem } : {}), ...(connection ? { connection } : {}) }
}

function printerBay(v: unknown): PrinterBay | undefined {
  if (!isRec(v)) return undefined
  const id = str(v['id'], 80), name = str(v['name'], 60)
  if (!id || !name?.trim()) return undefined
  const place = str(v['place'], 80)
  return { id, name, ...(place?.trim() ? { place } : {}) }
}

function pilot(v: unknown): Prefs['pilot'] | undefined {
  if (!isRec(v)) return undefined
  const mode = oneOf(v['mode'], ['on', 'off', 'unset'] as const)
  if (!mode) return undefined
  const provider = oneOf(v['provider'], ['openai', 'anthropic', 'local'] as const)
  const baseUrl = str(v['baseUrl'], 200)
  const model = str(v['model'], 80)
  return { mode, ...(provider ? { provider } : {}), ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}) }
}

const SEND_KEYS = ['bedLeveling', 'flowCalibration', 'vibrationCompensation', 'timelapse', 'firstLayerInspection']

/** Every field checked on its own; a bad one takes its default while the rest survive. Mirrors the old schema's `.catch` per field. */
export function normalizePrefs(v: unknown): Prefs {
  const r: Rec = isRec(v) ? v : {}
  const or = <T>(x: T | undefined, d: T): T => (x === undefined ? d : x)
  const opt = <K extends keyof Prefs>(key: K, x: Prefs[K] | undefined): Partial<Prefs> => (x === undefined ? {} : ({ [key]: x } as Partial<Prefs>))
  return {
    // There is no Preview tab any more: a saved Preview opens Slice, which shows the sliced plate.
    workspace: or(workspace(r['workspace'] === 'preview' ? 'prepare' : r['workspace']), 'prepare'),
    rails: or(record(r['rails'], (k) => WORKSPACE.test(k), (x) => (isRec(x) ? { ...(bool(x['left']) !== undefined ? { left: bool(x['left'])! } : {}), ...(bool(x['right']) !== undefined ? { right: bool(x['right'])! } : {}) } : undefined)), {}),
    recents: or(list(r['recents'], 8, (x) => str(x, 80)), []),
    appearance: appearance(r['appearance'], r['toolpathPalette'] === 'colorblind'),
    sidebarFolds: or(record(r['sidebarFolds'], (k) => /^[a-z-]{1,40}$/.test(k), bool), {}),
    showToolhead: or(bool(r['showToolhead']), true),
    playbackSpeed: or((PLAYBACK_SPEEDS as readonly number[]).includes(r['playbackSpeed'] as number) ? (r['playbackSpeed'] as number) : undefined, DEFAULT_PLAYBACK_SPEED),
    followNozzle: or(bool(r['followNozzle']), false),
    easy: or(nullable(r['easy'], easy), null),
    goal: or(oneOf(r['goal'], ['draft', 'standard', 'fine', 'strong', 'custom'] as const), 'standard'),
    printerId: or(nullable(r['printerId'], (x) => str(x, 80)), null),
    scheme: or(oneOf(r['scheme'], ['dark', 'light'] as const), 'dark'),
    lookAndFeel: or(nullable(r['lookAndFeel'], lookChoice), null),
    firstRun: or(nullable(r['firstRun'], firstRun), null),
    themeFollowsSystem: or(bool(r['themeFollowsSystem']), false),
    ...opt('themeIds', isRec(r['themeIds']) && str(r['themeIds']['dark'], 40) && str(r['themeIds']['light'], 40) ? { dark: themeId(r['themeIds']['dark'] as string), light: themeId(r['themeIds']['light'] as string) } : undefined),
    ...opt('userThemes', Array.isArray(r['userThemes']) && r['userThemes'].length <= 64 ? (r['userThemes'] as unknown[]) : undefined),
    ...opt('fonts', isRec(r['fonts']) && str(r['fonts']['ui'], 40) && str(r['fonts']['mono'], 40) ? { ui: r['fonts']['ui'] as string, mono: r['fonts']['mono'] as string } : undefined),
    settingsMode: or(oneOf(r['settingsMode'], ['simple', 'advanced', 'expert', 'developer'] as const), 'simple'),
    crashReports: or(bool(r['crashReports']), false),
    ...opt('motion', oneOf(r['motion'], ['system', 'full', 'reduced'] as const)),
    agreement: or(nullable(r['agreement'], (x) => (isRec(x) && num(x['version'], 1, 1e6) !== undefined && str(x['acceptedAt'], 40) ? { version: x['version'] as number, acceptedAt: x['acceptedAt'] as string } : undefined)), null),
    ...opt('installId', typeof r['installId'] === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r['installId']) ? r['installId'] : undefined),
    cadTools: or(bool(r['cadTools']), true),
    modelModeDefault: or(oneOf(r['modelModeDefault'], ['slice', 'design'] as const), 'slice'),
    sliceLook: or(oneOf(r['sliceLook'], ['solid', 'print', 'toolpaths'] as const), 'toolpaths'),
    // Absent stays absent, so the store picks the default (browser tests turn it off for the session); a bad value reads as on.
    ...opt('autoSlice', r['autoSlice'] === undefined ? undefined : or(bool(r['autoSlice']), true)),
    ...opt('electricity', isRec(r['electricity']) && num(r['electricity']['pricePerKwh'], 0, 5) !== undefined && str(r['electricity']['symbol'], 4) ? { pricePerKwh: r['electricity']['pricePerKwh'] as number, symbol: r['electricity']['symbol'] as string } : undefined),
    tooltips: or(isRec(r['tooltips']) && bool(r['tooltips']['enabled']) !== undefined && bool(r['tooltips']['media']) !== undefined ? { enabled: r['tooltips']['enabled'] as boolean, media: r['tooltips']['media'] as boolean } : undefined, { enabled: true, media: true }),
    setupPilotOff: or(bool(r['setupPilotOff']), false),
    noPrinter: or(bool(r['noPrinter']), false),
    activePresets: or(isRec(r['activePresets']) ? { ...opt2('printer', str(r['activePresets']['printer'], 80)), ...opt2('filament', str(r['activePresets']['filament'], 80)), ...opt2('process', str(r['activePresets']['process'], 80)) } : undefined, {}),
    sendChoices: or(record(r['sendChoices'], (k) => k.length <= 80, (x) => record(x, (k) => SEND_KEYS.includes(k), bool)), {}),
    dryMarks: or(record(r['dryMarks'], (k) => k.length <= 120, (x) => (isRec(x) && num(x['at'], 0) !== undefined && str(x['spool'], 200) !== undefined ? { at: x['at'] as number, spool: x['spool'] as string } : undefined)), {}),
    presetSync: or(presetSync(r['presetSync']), { deleted: [], changes: [], lastAt: 0 }),
    printerNozzles: or(record(r['printerNozzles'], (k) => k.length <= 80, (x) => num(x, 0.1, 2)), {}),
    printerExtruders: or(record(r['printerExtruders'], (k) => k.length <= 80, (x) => list(x, 8, extruderNozzle)), {}),
    handPrinters: or(list(r['handPrinters'], 100, handPrinter), []),
    bays: or(list(r['bays'], 100, printerBay), []),
    printerBays: or(record(r['printerBays'], (k) => k.length <= 80, (x) => str(x, 80)), {}),
    printersView: or(oneOf(r['printersView'], ['all', 'bay'] as const), 'all'),
    easyTouched: or(list(r['easyTouched'], 8, (x) => str(x, 20)), []),
    paneSizes: or(record(r['paneSizes'], (k) => k.length <= 60, (x) => num(x, 0, 4000)), {}),
    spoolLinks: or(record(r['spoolLinks'], () => true, (x) => num(x)), {}),
    queue: or(list(r['queue'], 200, queueItem), []),
    pilot: or(nullable(r['pilot'], pilot), null),
  }
}

/** The default theme's earlier ids (SlicerX dark and light, Nocturne), under its name now, Subban. Mirrors LEGACY_THEME_IDS in @slicerx/ui, kept here so prefs load without the theme bundle. */
const THEME_ID_MOVES: Readonly<Record<string, string>> = { 'slicerx-dark': 'subban-dark', 'slicerx-light': 'subban-light', nocturne: 'subban-dark', 'nocturne-dark': 'subban-dark', 'nocturne-light': 'subban-light' }
export const themeId = (id: string): string => THEME_ID_MOVES[id] ?? id

export interface Appearance {
  textSize: 'small' | 'default' | 'large' | 'larger'
  fontWeight: 'light' | 'regular' | 'medium' | 'bold'
  contrast: 'standard' | 'higher'
  /** Status and meaning colors, toolpaths included, for red-green or blue-yellow color vision. */
  colorVision: 'standard' | 'redgreen' | 'blueyellow'
  density: 'compact' | 'comfortable' | 'roomy'
  /** The interactive accent: the theme's own, or one of its palette colors. */
  accent: 'theme' | 'blue' | 'cyan' | 'green' | 'pink' | 'orange'
}

export const DEFAULT_APPEARANCE: Appearance = { textSize: 'default', fontWeight: 'regular', contrast: 'standard', colorVision: 'standard', density: 'comfortable', accent: 'theme' }

/** Each field on its own. The old toolpath palette switch becomes red-green color vision. */
function appearance(v: unknown, colorblindToolpaths: boolean): Appearance {
  const r: Rec = isRec(v) ? v : {}
  const d = DEFAULT_APPEARANCE
  return {
    textSize: oneOf(r['textSize'], ['small', 'default', 'large', 'larger'] as const) ?? d.textSize,
    fontWeight: oneOf(r['fontWeight'], ['light', 'regular', 'medium', 'bold'] as const) ?? d.fontWeight,
    contrast: oneOf(r['contrast'], ['standard', 'higher'] as const) ?? d.contrast,
    colorVision: oneOf(r['colorVision'], ['standard', 'redgreen', 'blueyellow'] as const) ?? (colorblindToolpaths ? 'redgreen' : d.colorVision),
    density: oneOf(r['density'], ['compact', 'comfortable', 'roomy'] as const) ?? d.density,
    accent: oneOf(r['accent'], ['theme', 'blue', 'cyan', 'green', 'pink', 'orange'] as const) ?? d.accent,
  }
}

const opt2 = (key: string, x: string | undefined): Record<string, string> => (x === undefined ? {} : { [key]: x })

const DEFAULTS: Prefs = { workspace: 'prepare', rails: {}, recents: [], easy: null, goal: 'standard', printerId: null, scheme: 'dark' }

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // Storage access throws in some private modes and sandboxed frames.
    return null
  }
}

/** True when this install has stored preferences, so it has run before (first-run setup shows only when false). */
export function hasStoredPrefs(): boolean {
  try {
    return Boolean(storage()?.getItem(KEY))
  } catch {
    return false
  }
}

export function loadPrefs(): Prefs {
  const raw = storage()?.getItem(KEY)
  if (!raw) return DEFAULTS
  try {
    return normalizePrefs(JSON.parse(raw))
  } catch {
    // Corrupt JSON: start fresh rather than fail to launch.
    return DEFAULTS
  }
}

export function savePrefs(p: Prefs): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(p))
  } catch {
    // Quota or access errors only cost the convenience, never the session.
  }
}

/** One extruder's nozzle on a printer with more than one (an H2D's left and right), in the slicer's extruder order. */
export interface ExtruderNozzle {
  mm: number
  /** `brass`, `hardened-steel`, `stainless-steel` or `tungsten-carbide`. */
  type?: string
  highFlow?: boolean
}

function extruderNozzle(x: unknown): ExtruderNozzle | undefined {
  if (!isRec(x)) return undefined
  const mm = num(x['mm'], 0.1, 2)
  if (mm === undefined) return undefined
  const type = str(x['type'], 24)
  const highFlow = bool(x['highFlow'])
  return { mm, ...(type ? { type } : {}), ...(highFlow !== undefined ? { highFlow } : {}) }
}
