// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the setup preview shows for a look: the real tabs, keys and mouse map, and the few ways the
// look differs, most important first. React-free and read from the same data the app uses (the
// preset's layout, the keymap, the viewport's control map), so the preview cannot drift from the app.
import { LOOK_IDS, type LayoutSpec, type LookId } from '@slicerx/contracts'
import { keymapFor, resolvePreset, type IconName, type Keymap, type KeyAction } from '@slicerx/ui'
import type { ControlsMap, DragAction } from '@slicerx/viewport'
import { PLATE_TOOLS } from '../workspaces/prepare/plate-tool-list'
import type { ActiveWorkspace } from '../features'
import { topBarTabs } from './look'
import { APP_FOR_LOOK, APP_NAMES } from './preset-import'

/** Where a note points in the miniature. */
export type PreviewTarget = 'tab' | 'search' | 'tools' | 'plate' | 'slice'

export interface PreviewNote {
  id: string
  target: PreviewTarget
  /** "Printers is named Device". */
  title: string
  /** One more line: what else to know. */
  detail: string
  /** Two or three words for the card: "Device tab". */
  short: string
  /** For a tab note, the workspace it points at. */
  tab?: string
}

export interface PreviewTab {
  id: string
  label: string
  icon: IconName
  renamed: boolean
}

export interface PreviewTool {
  label: string
  icon: IconName
  key: string | null
}

export interface LookPreview {
  id: LookId
  tabs: PreviewTab[]
  /** Sidebar sections top to bottom. */
  sidebar: string[]
  modes: string[]
  tools: PreviewTool[]
  palette: string | null
  slice: string | null
  /** The two, at most three, differences that matter most for this look. */
  notes: PreviewNote[]
  /** The other differences, as titles. */
  more: string[]
}

export type ControlsLookup = (id: LookId) => ControlsMap

type Fmt = (chord: string) => string

const BASE_LABEL: Readonly<Record<string, string>> = { prepare: 'Prepare', preview: 'Preview', printers: 'Printers', library: 'Vault', feed: 'Vault', pilot: 'mimir' }

/** Sidebar sections in the order the Prepare sidebar stacks them. */
export function sidebarSections(layout: LayoutSpec): string[] {
  const top = ['Printer', 'Filament']
  if (layout.objectList === 'sidebar-above-settings') return ['Objects', ...top, 'Print settings']
  if (layout.objectList === 'sidebar-after-filament') return [...top, 'Objects', 'Print settings']
  return [...top, 'Print settings', 'Objects']
}

function plainDrag(map: ControlsMap, button: 'left' | 'middle' | 'right'): DragAction {
  return map.drags.find((d) => d.button === button && !d.mods && (d.context ?? 'any') !== 'preview')?.action ?? 'none'
}

function hasSpacePan(map: ControlsMap): boolean {
  return map.drags.some((d) => d.button === 'left' && d.mods?.space && d.action === 'pan')
}

/** Lowercases a leading word ("Dragging a model" to "dragging a model") so titles read inside a sentence; keys stay as they are. */
function inline(title: string): string {
  return /^[A-Z][a-z]/.test(title) ? title[0]!.toLowerCase() + title.slice(1) : title
}

interface Facts {
  id: LookId
  keys: Keymap
  map: ControlsMap
  tabs: PreviewTab[]
}

interface Candidate {
  id: string
  target: PreviewTarget
  /** The value compared between looks. */
  value: (f: Facts) => unknown
  /** The note for a look, or null when this look has nothing to say here (a key it leaves unbound). */
  note: (f: Facts, fmt: Fmt, app: string | null) => Omit<PreviewNote, 'id' | 'target'> | null
}

const VIEW_KEYS: readonly KeyAction[] = ['view.plate', 'view.top', 'view.bottom', 'view.front', 'view.back', 'view.left', 'view.right', 'view.iso']

/** In order of how much a person coming from that slicer notices them. */
const CANDIDATES: readonly Candidate[] = [
  {
    id: 'tabs',
    target: 'tab',
    value: (f) => f.tabs.map((t) => t.label).join(','),
    note: (f, _fmt, app) => {
      const t = f.tabs.find((x) => x.renamed)
      if (!t) return null
      const was = BASE_LABEL[t.id] ?? t.id
      const i = f.tabs.indexOf(t)
      const where = i === 0 ? 'the first tab' : `right after ${f.tabs[i - 1]!.label}`
      return { title: `${was} is named ${t.label}`, detail: app ? `As in ${app}, ${where}.` : `It is ${where}.`, short: `${t.label} tab`, tab: t.id }
    },
  },
  {
    id: 'palette',
    target: 'search',
    value: (f) => f.keys.palette,
    note: (f, fmt) => (f.keys.palette ? { title: `${fmt(f.keys.palette)} opens the command bar`, detail: `Type to find any setting or command. ${fmt('Mod+K')} works too.`, short: `${fmt(f.keys.palette)} for commands` } : null),
  },
  {
    id: 'slice',
    target: 'slice',
    value: (f) => `${f.keys.slice}|${f.keys.export}`,
    note: (f, fmt) => (f.keys.slice ? { title: `${fmt(f.keys.slice)} slices the plate`, detail: f.keys.export ? `${fmt(f.keys.export)} exports the G-code.` : 'Export the G-code from Preview.', short: `${fmt(f.keys.slice)} to slice` } : null),
  },
  {
    id: 'scroll',
    target: 'plate',
    value: (f) => f.map.trackpad.scroll,
    note: (f, _fmt, app) => {
      const s = f.map.trackpad.scroll
      if (s === 'zoom') return { title: 'Two-finger scroll zooms', detail: app ? `As in ${app}. Pinch zooms too.` : 'Pinch zooms too.', short: 'scroll to zoom' }
      if (s === 'pan') return { title: 'Two-finger scroll pans', detail: 'Pinch to zoom. Hold Shift and scroll to turn the view.', short: 'scroll to pan' }
      return { title: 'Two-finger scroll turns the view', detail: 'Pinch to zoom.', short: 'scroll to turn' }
    },
  },
  {
    id: 'space-pan',
    target: 'plate',
    value: (f) => hasSpacePan(f.map),
    note: (f) => (hasSpacePan(f.map) ? { title: 'Hold Space and drag to pan', detail: 'Handy on a trackpad or a one-button mouse.', short: 'Space to pan' } : null),
  },
  {
    id: 'object-drag',
    target: 'plate',
    value: (f) => f.map.objectDrag,
    note: (f) =>
      f.map.objectDrag === 'move-any'
        ? { title: 'Dragging a model moves it', detail: 'Drag empty space to turn the view.', short: 'drag to move' }
        : { title: 'Click a model, then drag to move it', detail: 'Dragging a model you have not picked turns the view instead.', short: 'click, then drag' },
  },
  {
    id: 'views',
    target: 'plate',
    value: (f) => VIEW_KEYS.map((a) => f.keys[a]).join(','),
    note: (f, fmt) => {
      const k = f.keys
      if (k['view.top'] && k['view.right'] && /\+/.test(k['view.top'])) return { title: `${fmt(k['view.top'])} to ${fmt(k['view.right'])} pick a view`, detail: k['view.plate'] ? `${fmt(k['view.plate'])} shows the whole plate.` : 'Top, bottom, front, back, left and right.', short: 'view keys' }
      if (k['view.iso'] && k['view.iso'] !== '7') return { title: `${fmt(k['view.iso'])} shows the iso view`, detail: k['view.top'] && k['view.right'] ? `${fmt(k['view.top'])} to ${fmt(k['view.right'])} pick the others.` : 'The other views are in the View menu.', short: 'view keys' }
      return null
    },
  },
  {
    id: 'supports',
    target: 'tools',
    value: (f) => f.keys['tool.supports'],
    note: (f, fmt) => (f.keys['tool.supports'] ? { title: `${fmt(f.keys['tool.supports'])} paints supports`, detail: 'The Paint tool in the plate toolbar.', short: 'support key' } : null),
  },
  {
    id: 'one-layer',
    target: 'plate',
    value: (f) => f.keys['preview.singleLayer'],
    note: (f, fmt) => (f.keys['preview.singleLayer'] ? { title: `${fmt(f.keys['preview.singleLayer'])} shows a single layer`, detail: 'In Preview, next to the layer slider.', short: 'one layer key' } : null),
  },
  {
    id: 'orbit',
    target: 'plate',
    value: (f) => f.map.orbitAround,
    note: (f) =>
      f.map.orbitAround === 'selection'
        ? { title: 'The view turns around what you picked', detail: 'With nothing picked, around the plate.', short: 'orbit the pick' }
        : { title: 'The view turns around the plate', detail: 'Whatever is picked.', short: 'orbit the plate' },
  },
  {
    id: 'double-click',
    target: 'plate',
    value: (f) => `${f.map.doubleClick.object}|${f.map.doubleClick.empty}`,
    note: (f) => (f.map.doubleClick.object === 'zoom' ? { title: 'Double-click a model to frame it', detail: 'Double-click empty space to see the whole plate.', short: 'double-click to frame' } : null),
  },
]

/** The tabs a look shows, given the workspaces this build has. SlicerX's own names (Model) are the baseline, never a rename. */
export function previewTabs(id: LookId, workspaces: readonly ActiveWorkspace[]): PreviewTab[] {
  const layout = resolvePreset(id).layout
  return topBarTabs(workspaces, layout).map((w) => ({ id: w.id, label: w.label, icon: w.icon, renamed: id !== 'slicerx' && Boolean(layout.tabLabels?.[w.id]) }))
}

function facts(id: LookId, workspaces: readonly ActiveWorkspace[], controls: ControlsLookup, keys: Readonly<Record<string, string>>): Facts {
  return { id, keys: keymapFor(id, keys), map: controls(id), tabs: previewTabs(id, workspaces) }
}

/**
 * The preview for a look. A difference counts when the look's value differs from the SlicerX
 * defaults; for the SlicerX defaults themselves, when it differs from every other look, so the
 * notes say what is its own. The person's key overrides apply to the look they have picked.
 */
export function lookPreview(id: LookId, workspaces: readonly ActiveWorkspace[], controls: ControlsLookup, fmt: Fmt, keys: Readonly<Record<string, string>> = {}): LookPreview {
  const self = facts(id, workspaces, controls, keys)
  const others = LOOK_IDS.filter((x) => x !== id).map((x) => facts(x, workspaces, controls, {}))
  const ref = id === 'slicerx' ? others : others.filter((o) => o.id === 'slicerx')
  const app = APP_FOR_LOOK[id] ? APP_NAMES[APP_FOR_LOOK[id]!] : null
  const differences: PreviewNote[] = []
  for (const c of CANDIDATES) {
    const mine = JSON.stringify(c.value(self))
    if (!ref.every((o) => JSON.stringify(c.value(o)) !== mine)) continue
    const n = c.note(self, fmt, app)
    if (n) differences.push({ id: c.id, target: c.target, ...n })
  }
  const notes = differences.slice(0, 3)
  const layout = resolvePreset(id).layout
  return {
    id,
    tabs: self.tabs,
    sidebar: sidebarSections(layout),
    modes: [...layout.modes],
    tools: PLATE_TOOLS.map((t) => ({ label: t.label, icon: t.icon, key: self.keys[t.key] })),
    palette: self.keys.palette,
    slice: self.keys.slice,
    notes,
    more: differences.slice(3).map((d) => inline(d.title)),
  }
}

/** The mouse in one line, from the same map the plate uses: "Left drag rotates, right drag pans". */
export function mouseLine(map: ControlsMap): string {
  const verb: Record<DragAction, string> = { rotate: 'rotates', pan: 'pans', zoom: 'zooms', none: 'does nothing' }
  const l = plainDrag(map, 'left')
  const r = plainDrag(map, 'right')
  const m = plainDrag(map, 'middle')
  const right = r === m ? `right or middle drag ${verb[r]}` : `right drag ${verb[r]}, middle drag ${verb[m]}`
  return `Left drag ${verb[l]}, ${right}`
}
