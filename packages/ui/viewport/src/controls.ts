// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Camera and mouse controls as data. One map per look and feel preset; the
// viewport resolves every drag and wheel event through these functions, so a
// preset's bindings can be tested without a canvas. No three.js import here.

/** Mirrors LookId in @slicerx/contracts so the viewport stays independent of that package. */
import { BAMBU_GIZMO, ORCA_GIZMO, PRUSA_GIZMO, withGizmoOverrides, type GizmoBindings, type GizmoOverrides } from './gizmobindings'

export type ControlsPresetId = 'slicerx' | 'bambu-studio' | 'prusaslicer' | 'orcaslicer'
export type ControlsContext = 'prepare' | 'preview'
export type DragAction = 'rotate' | 'pan' | 'zoom' | 'none'
export type MouseButtonName = 'left' | 'middle' | 'right'
export type OrbitCenter = 'scene' | 'selection'

export interface Modifiers {
  shift: boolean
  /** Control, or Command on macOS. */
  ctrl: boolean
  alt: boolean
  /** The space bar, held. */
  space: boolean
}

export interface DragBinding {
  button: MouseButtonName
  /** Modifiers that must be down. Any modifier not listed must be up. */
  mods?: Partial<Modifiers>
  /** Where the binding applies. Default: both. */
  context?: 'prepare' | 'preview' | 'any'
  action: DragAction
}

export interface ControlsMap {
  id: ControlsPresetId
  /** Full text for settings screens. */
  label: string
  drags: readonly DragBinding[]
  wheel: {
    /** Flip the zoom direction. */
    invert: boolean
    /** Zoom toward the point under the cursor instead of the orbit center. */
    zoomToCursor: boolean
  }
  trackpad: {
    /** Two-finger scroll. */
    scroll: 'pan' | 'rotate' | 'zoom'
    /** Two-finger scroll with Shift held. */
    shiftScroll: 'pan' | 'rotate' | 'zoom'
    /** Pinch always zooms. */
    pinch: 'zoom'
  }
  /** What a rotate drag orbits around. Selection falls back to the current orbit center when nothing is selected. */
  orbitAround: OrbitCenter
  /** Orbit around the point under the cursor at the start of a rotate drag (at that point's depth). Off by default. */
  freeCamera: boolean
  /**
   * Who takes a plain left drag that starts on a model in Prepare.
   * `move-selected`: only an already selected model moves, otherwise the view rotates and a click selects.
   * `move-any`: the model under the cursor is selected and moved.
   * Camera bindings still win over a drag on a model when a modifier is bound to one (for example Ctrl in SlicerX).
   */
  objectDrag: 'move-selected' | 'move-any'
  doubleClick: { empty: 'fit' | 'none'; object: 'zoom' | 'none' }
  rotateSpeed: number
  zoomSpeed: number
  /** Modifier keys and steps of the move, scale and paint tools (see gizmobindings.ts). */
  gizmo: GizmoBindings
}

const NO_MODS: Modifiers = { shift: false, ctrl: false, alt: false, space: false }

/** Left rotates, right and middle pan, wheel zooms toward the cursor. Bambu Studio, PrusaSlicer and OrcaSlicer all start here. */
const CLASSIC: readonly DragBinding[] = [
  { button: 'left', action: 'rotate' },
  { button: 'right', action: 'pan' },
  { button: 'middle', action: 'pan' },
]

// Bindings follow docs/look-and-feel.md section 3 (design research). Trackpad rows
// for the three imitated apps are unverified there; keep them as settings defaults.
export const CONTROL_PRESETS: Readonly<Record<ControlsPresetId, ControlsMap>> = {
  slicerx: {
    id: 'slicerx',
    label: 'SlicerX',
    drags: [
      ...CLASSIC,
      { button: 'left', mods: { space: true }, action: 'pan' },
      { button: 'left', mods: { ctrl: true }, action: 'rotate' },
      { button: 'left', mods: { shift: true }, context: 'preview', action: 'pan' },
    ],
    wheel: { invert: false, zoomToCursor: true },
    trackpad: { scroll: 'pan', shiftScroll: 'rotate', pinch: 'zoom' },
    orbitAround: 'selection',
    freeCamera: false,
    objectDrag: 'move-selected',
    doubleClick: { empty: 'fit', object: 'zoom' },
    rotateSpeed: 0.8,
    zoomSpeed: 0.9,
    gizmo: BAMBU_GIZMO,
  },
  'bambu-studio': {
    id: 'bambu-studio',
    label: 'Bambu Studio style',
    drags: CLASSIC,
    wheel: { invert: false, zoomToCursor: true },
    trackpad: { scroll: 'zoom', shiftScroll: 'zoom', pinch: 'zoom' },
    orbitAround: 'scene',
    freeCamera: false,
    objectDrag: 'move-any',
    doubleClick: { empty: 'none', object: 'none' },
    rotateSpeed: 0.8,
    zoomSpeed: 0.9,
    gizmo: BAMBU_GIZMO,
  },
  prusaslicer: {
    id: 'prusaslicer',
    label: 'PrusaSlicer style',
    drags: [...CLASSIC, { button: 'left', mods: { ctrl: true }, action: 'rotate' }],
    wheel: { invert: false, zoomToCursor: true },
    trackpad: { scroll: 'zoom', shiftScroll: 'zoom', pinch: 'zoom' },
    orbitAround: 'scene',
    freeCamera: false,
    objectDrag: 'move-any',
    doubleClick: { empty: 'none', object: 'none' },
    rotateSpeed: 1,
    zoomSpeed: 0.9,
    gizmo: PRUSA_GIZMO,
  },
  orcaslicer: {
    id: 'orcaslicer',
    label: 'OrcaSlicer style',
    drags: CLASSIC,
    wheel: { invert: false, zoomToCursor: true },
    trackpad: { scroll: 'zoom', shiftScroll: 'zoom', pinch: 'zoom' },
    orbitAround: 'scene',
    freeCamera: false,
    objectDrag: 'move-any',
    doubleClick: { empty: 'none', object: 'none' },
    rotateSpeed: 0.8,
    zoomSpeed: 0.9,
    gizmo: ORCA_GIZMO,
  },
}

export const CONTROL_PRESET_IDS: readonly ControlsPresetId[] = ['slicerx', 'bambu-studio', 'prusaslicer', 'orcaslicer']

export function controlsPreset(id: ControlsPresetId): ControlsMap {
  return CONTROL_PRESETS[id]
}

export function buttonName(button: number): MouseButtonName | null {
  return button === 0 ? 'left' : button === 1 ? 'middle' : button === 2 ? 'right' : null
}

export function modifiersOf(e: { shiftKey: boolean; ctrlKey: boolean; metaKey?: boolean; altKey: boolean }, space = false): Modifiers {
  return { shift: e.shiftKey, ctrl: e.ctrlKey || !!e.metaKey, alt: e.altKey, space }
}

/** What a mouse drag does. Exact modifier match wins; a plain binding is the fallback only when no modifier is down. */
export function resolveDrag(map: ControlsMap, button: MouseButtonName, mods: Modifiers = NO_MODS, context: ControlsContext = 'prepare'): DragAction {
  for (const b of map.drags) {
    if (b.button !== button) continue
    if (b.context && b.context !== 'any' && b.context !== context) continue
    const want = { ...NO_MODS, ...b.mods }
    if (want.shift === mods.shift && want.ctrl === mods.ctrl && want.alt === mods.alt && want.space === mods.space) return b.action
  }
  return 'none'
}

/** three.js MOUSE codes: 0 rotate, 1 dolly, 2 pan; -1 does nothing. */
export const ORBIT_CODE = { rotate: 0, zoom: 1, pan: 2, none: -1 } as const

/**
 * The code to hand OrbitControls for a button so `action` happens. OrbitControls
 * swaps rotate and pan when Shift, Control or Command is down, so this swaps first.
 */
export function orbitCodeFor(action: DragAction, mods: Modifiers): number {
  if (mods.shift || mods.ctrl) {
    if (action === 'rotate') return ORBIT_CODE.pan
    if (action === 'pan') return ORBIT_CODE.rotate
  }
  return ORBIT_CODE[action]
}

export interface WheelLike {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey: boolean
  shiftKey: boolean
}

/**
 * Trackpad or mouse. Browsers do not say, so this reads the event: pinch arrives
 * as a wheel with ctrlKey; a two-finger scroll is pixel based and either has a
 * horizontal part or a small fractional vertical step; a mouse wheel steps in
 * whole notches (100 pixels or lines).
 */
export function wheelKind(e: WheelLike): 'pinch' | 'scroll' | 'wheel' {
  if (e.ctrlKey) return 'pinch'
  if (e.deltaMode !== 0) return 'wheel'
  if (e.deltaX !== 0) return 'scroll'
  const a = Math.abs(e.deltaY)
  if (a === 0) return 'wheel'
  if (!Number.isInteger(e.deltaY) || a < 40) return 'scroll'
  return 'wheel'
}

/** Camera action for a wheel event. */
export function resolveWheel(map: ControlsMap, e: WheelLike): 'zoom' | 'pan' | 'rotate' {
  const kind = wheelKind(e)
  if (kind === 'scroll') return e.shiftKey ? map.trackpad.shiftScroll : map.trackpad.scroll
  return 'zoom'
}

/**
 * A user's per-button remap from Settings. Replaces what the plain (no modifier)
 * drag of each listed button does; modifier bindings stay. `null` clears it.
 */
export type ButtonRemap = Partial<Record<MouseButtonName, Exclude<DragAction, 'none'> | null>>

/** Gizmo bindings edited in Settings, applied to a map. */
export function withGizmo(map: ControlsMap, overrides: GizmoOverrides): ControlsMap {
  return { ...map, gizmo: withGizmoOverrides(map.gizmo, overrides) }
}

export function withRemap(map: ControlsMap, remap: ButtonRemap): ControlsMap {
  const drags = map.drags.filter((b) => !(b.button in remap && !hasMods(b)))
  for (const [button, action] of Object.entries(remap) as [MouseButtonName, ButtonRemap[MouseButtonName]][]) {
    if (action) drags.push({ button, action })
  }
  return { ...map, drags }
}

function hasMods(b: DragBinding): boolean {
  return !!b.mods && Object.values(b.mods).some(Boolean)
}

/**
 * True when a left press on a model should be handed to the model layer, given
 * the map, whether that model is already selected and the resolved camera action.
 * A drag that a modifier binds to a camera action never moves a model.
 */
export function dragStartsOnModel(map: ControlsMap, mods: Modifiers, action: DragAction, selected: boolean): boolean {
  if (mods.shift || mods.ctrl || mods.alt || mods.space) return false
  if (action !== 'rotate') return false
  return map.objectDrag === 'move-any' || selected
}
