// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Look and feel presets: the values behind docs/look-and-feel.md. React-free. A preset is data;
// `applyPreset` turns the `look` part into CSS variables and data attributes, the app shell reads
// `layout`, the viewport reads its own camera map by `controls`. The three "style" presets follow
// the mouse and keyboard conventions of those slicers and rename a tab or two; layout and look are
// SlicerX's for everyone, and the theme owns color.
import { LOOK_IDS, LOOK_OPTIONS, type LayoutSpec, type LookAndFeelPreset, type LookId, type LookSpec } from '@slicerx/contracts'

export { LOOK_IDS, LOOK_OPTIONS }
export type { LookAndFeelPreset, LookId, LayoutSpec, LookSpec }

// Developer is last in every look: it adds the setting keys and the developer commands.
const MODES = ['simple', 'advanced', 'expert', 'developer'] as const

/**
 * The one layout. A look is a control preset: the mouse map, the keymap and the tab names change
 * with it, nothing else. The theme owns color.
 */
const LAYOUT: LayoutSpec = {
  workspaceTabs: ['prepare', 'feed', 'library', 'printers', 'pilot'],
  settingsModel: 'sidebar',
  sidebar: { side: 'left', width: 340, resizable: true, collapseKey: 'Shift+Tab' },
  objectList: 'sidebar-after-filament',
  objectPanel: 'inline-table',
  toolbar: 'top-of-viewport',
  plateList: 'hidden-single',
  primaryAction: { placement: 'sidebar-footer', label: 'Slice plate' },
  layerSlider: { vertical: 'right', horizontal: 'bottom', timePlayback: true },
  legend: 'left-overlay',
  modes: MODES,
  modeSelector: 'sidebar',
  globalObjectSwitch: true,
  viewSwitcher: 'tabs',
}

/** The one look. Density, radius and the gradient primary are SlicerX's for everyone. */
const LOOK: LookSpec = { density: 'standard', accent: 'purple', radius: 'soft', rowHeight: 'lg', displayFont: true, gradientPrimary: true, iconSize: 18, iconStroke: 1.75, hairlines: 'lines' }

/** Tab order and names per style: the one thing a style changes about the layout. */
const TABS: Readonly<Record<LookId, Pick<LayoutSpec, 'workspaceTabs' | 'tabLabels'>>> = {
  slicerx: { workspaceTabs: LAYOUT.workspaceTabs },
  'bambu-studio': { workspaceTabs: ['prepare', 'printers', 'library', 'pilot'], tabLabels: { printers: 'Device' } },
  prusaslicer: { workspaceTabs: ['prepare', 'library', 'printers', 'pilot'] },
  orcaslicer: { workspaceTabs: ['prepare', 'printers', 'library', 'pilot'], tabLabels: { printers: 'Device' } },
}

const preset = (id: LookId): LookAndFeelPreset => ({ id, ...LOOK_OPTIONS[id], controls: id, keys: id, layout: { ...LAYOUT, ...TABS[id] }, look: LOOK, defaultTheme: 'nocturne' })

const PRESETS: Readonly<Record<LookId, LookAndFeelPreset>> = {
  slicerx: preset('slicerx'),
  'bambu-studio': preset('bambu-studio'),
  prusaslicer: preset('prusaslicer'),
  orcaslicer: preset('orcaslicer'),
}

/** The preset for an id. Unknown ids (a stale stored value) fall back to SlicerX. */
export function resolvePreset(id: string): LookAndFeelPreset {
  return PRESETS[id as LookId] ?? PRESETS.slicerx
}

/** All presets in picker order. */
export function allPresets(): LookAndFeelPreset[] {
  return LOOK_IDS.map((id) => PRESETS[id])
}

const RADIUS: Record<LookSpec['radius'], Record<'xs' | 'sm' | 'md' | 'lg', number>> = {
  sharp: { xs: 3, sm: 4, md: 6, lg: 10 },
  soft: { xs: 4, sm: 6, md: 10, lg: 16 },
  round: { xs: 6, sm: 8, md: 12, lg: 18 },
}
/** Height of a medium control, in px. */
const ROW: Record<LookSpec['rowHeight'], number> = { sm: 28, md: 30, lg: 34 }
/** Panel padding and the page gutter, in px. */
const GUTTER: Record<LookSpec['density'], number> = { compact: 12, standard: 16, roomy: 20 }
const PAD: Record<LookSpec['density'], number> = { compact: 8, standard: 12, roomy: 16 }

/** The CSS custom properties a look sets, as a name to value map. Colors stay with the theme; the accent is a pointer to a theme color. */
export function lookToVars(look: LookSpec): Record<string, string> {
  const r = RADIUS[look.radius]
  const md = ROW[look.rowHeight]
  return {
    '--accent': `var(--${look.accent})`,
    '--r-xs': `${r.xs}px`,
    '--r-sm': `${r.sm}px`,
    '--r-md': `${r.md}px`,
    '--r-lg': `${r.lg}px`,
    '--h-sm': `${md - 4}px`,
    '--h-md': `${md}px`,
    '--h-lg': `${md + 10}px`,
    '--gutter': `${GUTTER[look.density]}px`,
    '--pad': `${PAD[look.density]}px`,
    '--icon-size': `${look.iconSize}px`,
    '--icon-stroke': String(look.iconStroke),
    ...(look.displayFont ? {} : { '--f-display': 'var(--f-body)' }),
  }
}

export const LOOK_EVENT = 'sx-look'
const ALL_VAR_NAMES = Object.keys(lookToVars(PRESETS.slicerx.look)).concat(['--f-display'])

/**
 * Applies a preset's look at runtime, with no reload: sets the variables on the element (the
 * document root by default) and data-look, data-density, data-hairlines and data-gradient for
 * selectors, and dispatches an "sx-look" event. Layout and controls are read by their owners.
 * Apply the theme first, then the look; the accent reads the theme's colors.
 */
export function applyPreset(preset: LookAndFeelPreset, el?: HTMLElement): void {
  const target = el ?? (typeof document !== 'undefined' ? document.documentElement : undefined)
  if (!target) return
  for (const name of ALL_VAR_NAMES) target.style.removeProperty(name)
  for (const [k, v] of Object.entries(lookToVars(preset.look))) target.style.setProperty(k, v)
  target.dataset['look'] = preset.id
  target.dataset['density'] = preset.look.density
  target.dataset['hairlines'] = preset.look.hairlines
  target.dataset['gradient'] = preset.look.gradientPrimary ? 'on' : 'off'
  target.dispatchEvent(new CustomEvent<LookAndFeelPreset>(LOOK_EVENT, { detail: preset, bubbles: true }))
}

/** Removes what applyPreset set, so the stylesheet defaults apply again. */
export function clearPreset(el?: HTMLElement): void {
  const target = el ?? (typeof document !== 'undefined' ? document.documentElement : undefined)
  if (!target) return
  for (const name of ALL_VAR_NAMES) target.style.removeProperty(name)
  for (const key of ['look', 'density', 'hairlines', 'gradient']) delete target.dataset[key]
}

/** Calls back with each preset applied under the element (the document by default). Returns an unsubscribe. */
export function onLookChange(cb: (preset: LookAndFeelPreset) => void, el?: EventTarget): () => void {
  const target = el ?? (typeof document !== 'undefined' ? document : undefined)
  if (!target) return () => undefined
  const handler = (e: Event) => cb((e as CustomEvent<LookAndFeelPreset>).detail)
  target.addEventListener(LOOK_EVENT, handler)
  return () => target.removeEventListener(LOOK_EVENT, handler)
}

/** Which theme to use for a preset: its own default, or the OS scheme when it says `system`. Every bundled preset says nocturne; a stored override may still say system. */
export function themeNameFor(preset: LookAndFeelPreset, systemPrefersDark: boolean): 'nocturne' | 'nocturne-light' {
  if (preset.defaultTheme === 'nocturne') return 'nocturne'
  return systemPrefersDark ? 'nocturne' : 'nocturne-light'
}

// Keymaps. Actions are command ids; a value is a key chord ("Mod" is Command on macOS, Control elsewhere)
// or null when the action exists in the menu and the palette but has no default key.
export const KEY_ACTIONS = [
  'view.plate', 'view.top', 'view.bottom', 'view.front', 'view.back', 'view.left', 'view.right', 'view.iso',
  'view.zoomSelection', 'view.zoomBed', 'view.projection',
  'tool.move', 'tool.rotate', 'tool.scale', 'tool.cut', 'tool.placeOnFace', 'tool.supports', 'tool.orient',
  'plate.arrange', 'plate.arrangeSelected',
  'edit.copy', 'edit.cut', 'edit.paste', 'edit.duplicate', 'object.printable',
  'workspace.toggle', 'model.mode', 'slice', 'export', 'palette',
  'preview.legend', 'preview.singleLayer', 'preview.jumpToLayer', 'preview.layerUp', 'preview.layerDown',
  'help.shortcuts',
] as const
export type KeyAction = (typeof KEY_ACTIONS)[number]
export type Keymap = Readonly<Record<KeyAction, string | null>>

const COMMON: Keymap = {
  'view.plate': '0', 'view.top': '1', 'view.bottom': '2', 'view.front': '3', 'view.back': '4', 'view.left': '5', 'view.right': '6', 'view.iso': '7',
  'view.zoomSelection': null, 'view.zoomBed': null, 'view.projection': null,
  'tool.move': 'M', 'tool.rotate': 'R', 'tool.scale': 'S', 'tool.cut': 'C', 'tool.placeOnFace': 'F', 'tool.supports': null, 'tool.orient': null,
  'plate.arrange': 'A', 'plate.arrangeSelected': 'Shift+A',
  'edit.copy': 'Mod+C', 'edit.cut': 'Mod+X', 'edit.paste': 'Mod+V', 'edit.duplicate': null, 'object.printable': 'V',
  'workspace.toggle': null, 'model.mode': 'Mod+E', 'slice': 'Mod+G', 'export': 'Mod+Shift+E', 'palette': 'Mod+K',
  'preview.legend': 'L', 'preview.singleLayer': 'Shift+L', 'preview.jumpToLayer': 'Shift+G', 'preview.layerUp': 'Up', 'preview.layerDown': 'Down',
  'help.shortcuts': 'Shift+?',
}

export const KEYMAPS: Readonly<Record<LookId, Keymap>> = {
  slicerx: { ...COMMON, 'edit.duplicate': 'Mod+D', 'view.zoomSelection': 'Z', 'view.zoomBed': 'B', 'view.projection': 'K', 'tool.supports': 'I', 'tool.orient': 'Q', 'workspace.toggle': 'Tab', slice: 'Mod+Enter' },
  'bambu-studio': { ...COMMON, 'tool.supports': 'I', 'preview.legend': null, 'preview.singleLayer': 'L' },
  prusaslicer: { ...COMMON, 'view.plate': null, 'view.iso': '0', 'view.zoomSelection': 'Z', 'view.zoomBed': 'B', 'view.projection': 'K', 'workspace.toggle': 'Tab', slice: 'Mod+R', export: 'Mod+G' },
  orcaslicer: {
    ...COMMON,
    'edit.duplicate': 'Mod+D',
    'view.plate': 'Mod+0', 'view.top': 'Mod+1', 'view.bottom': 'Mod+2', 'view.front': 'Mod+3', 'view.back': 'Mod+4', 'view.left': 'Mod+5', 'view.right': 'Mod+6', 'view.iso': null,
    'tool.supports': 'L', 'tool.orient': 'Q', 'workspace.toggle': 'Tab', slice: 'Mod+R', palette: 'Space', 'preview.singleLayer': 'L', 'preview.legend': null,
  },
}

/** The keymap for a look, with the person's per-action overrides on top. An override of "" clears a binding. */
export function keymapFor(id: string, overrides: Readonly<Record<string, string>> = {}): Keymap {
  const base = KEYMAPS[id as LookId] ?? KEYMAPS.slicerx
  const out: Record<string, string | null> = { ...base }
  for (const [action, chord] of Object.entries(overrides)) if (action in out) out[action] = chord === '' ? null : chord
  return out as Keymap
}

type KeyContext = 'prepare' | 'preview' | 'global'
function keyContext(action: KeyAction): KeyContext {
  if (action.startsWith('preview.')) return 'preview'
  if (action.startsWith('tool.') || action.startsWith('plate.')) return 'prepare'
  return 'global'
}

/** Actions bound to the same chord in one keymap. A chord may repeat between Prepare tools and Preview controls (Orca uses L for supports and single layer); anything involving a global action may not. Empty when the map is clean. */
export function keymapConflicts(map: Keymap): [KeyAction, KeyAction][] {
  const out: [KeyAction, KeyAction][] = []
  for (let i = 0; i < KEY_ACTIONS.length; i++) {
    const a = KEY_ACTIONS[i]!
    const chord = map[a]
    if (!chord) continue
    for (let j = i + 1; j < KEY_ACTIONS.length; j++) {
      const b = KEY_ACTIONS[j]!
      if (map[b]?.toLowerCase() !== chord.toLowerCase()) continue
      const ca = keyContext(a)
      const cb = keyContext(b)
      if (ca === cb || ca === 'global' || cb === 'global') out.push([a, b])
    }
  }
  return out
}
