// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a person sees of the app's own state, beyond the plate, as the agent bridge reads it back: the selection with
// its picked faces and edges, the active tool, the panels and windows open, and where the camera is. A client checks
// with it that a click or a key did what it meant (selected the object, opened the tool, turned the view).
import { cameraBus, toolStore } from '../plate/tools'
import { viewRing } from '../plate/view-ring'
import { selectedIds, type AppState } from '../state/store'

/** The store's open flags that are a panel or window on screen, by the name a client reads. */
export const OPEN_PANELS = {
  settings: 'settingsOpen',
  command: 'commandOpen',
  about: 'aboutOpen',
  shortcuts: 'shortcutsOpen',
  expert: 'expertOpen',
  agreement: 'agreementOpen',
  bugReport: 'bugReportOpen',
  flush: 'flushOpen',
  calibration: 'calibrationOpen',
  printerChooser: 'printerChooserOpen',
  printerSettings: 'printerSettingsOpen',
} as const satisfies Record<string, keyof AppState>

/** Open flags that are not a panel: the open of a file running, which the plate's state reads already. */
export const NOT_PANELS: readonly (keyof AppState)[] = ['sliceDuringOpen']

type UiSource = Pick<AppState, 'selection' | 'selectedIds' | 'subPicks' | 'pickFilter' | 'plate' | 'objectTool' | 'parked' | 'setup' | 'workspace'> & Pick<AppState, (typeof OPEN_PANELS)[keyof typeof OPEN_PANELS]>

const round = (v: number, digits = 2): number => {
  const k = 10 ** digits
  const r = Math.round(v * k) / k
  return r === 0 ? 0 : r
}

/** The selection: the primary object, every selected one in order, and the faces and edges picked on them. */
export function selectionState(s: Pick<UiSource, 'selection' | 'selectedIds' | 'subPicks' | 'pickFilter' | 'plate'>): Record<string, unknown> {
  const ids = selectedIds(s)
  const name = (id: string): string | null => s.plate.find((p) => p.id === id)?.name ?? null
  return {
    primary: s.selection,
    objects: ids.map((id) => ({ id, name: name(id) })),
    // What a click picks in Model: objects, faces or edges.
    pickFilter: [...s.pickFilter],
    picks: s.subPicks.map((p) => ({ kind: p.kind, objectId: p.objectId, part: p.partIndex, triangle: p.triangle, pointMm: p.point.map((v) => round(v)), ...(p.round ? { round: true } : {}) })),
  }
}

/**
 * The active tool: the 3D view's (select, move, rotate, scale, face, paint, brim, probe), with the rotate rings' space
 * and whether Move shows its arrows, and the object tool open in its panel (Cut, a modeling tool), or the one parked
 * while Design is shut.
 */
export function toolState(s: Pick<UiSource, 'objectTool' | 'parked'>): Record<string, unknown> {
  const t = toolStore.getState()
  return {
    view: t.tool,
    rotateSpace: t.rotateSpace,
    moveArrows: t.moveArrows,
    object: s.objectTool,
    parked: s.parked ? (s.parked.tool ?? 'step') : null,
  }
}

/**
 * The panels open: each side and bottom panel with a tab on its edge (read from the page, so it says what is on
 * screen), the windows and sheets open (Settings, the command bar and the rest), first-run setup, and Model's ring menu
 * or its full list with what it is for.
 */
export function panelState(s: UiSource, doc: Document): Record<string, unknown> {
  const panes = [...doc.querySelectorAll('.sx-edge-tab')].map((tab) => ({
    panel: tab.getAttribute('data-panel') ?? tab.getAttribute('data-side') ?? 'panel',
    side: tab.getAttribute('data-side'),
    open: tab.getAttribute('aria-expanded') === 'true',
  }))
  const open: string[] = (Object.keys(OPEN_PANELS) as (keyof typeof OPEN_PANELS)[]).filter((k) => s[OPEN_PANELS[k]] === true)
  if (s.setup !== null) open.push('setup')
  const ring = viewRing.getState()
  return {
    panes,
    open,
    ring: ring.at ? { target: ring.target.kind, ...(ring.target.kind === 'empty' ? {} : { objectId: ring.target.objectId }), list: ring.list } : null,
  }
}

/**
 * Where the 3D view's camera is: the orbit center on the bed (mm), the angle round it (0 from the front, 90 from the
 * right) and above the bed, the distance, the projection, and the view preset it is at (iso, top, front and the rest,
 * whichever key, button or command chose it; null once it was turned by hand). Null while there is no 3D view (another
 * tab, or the 2D fallback).
 */
export function cameraState(): Record<string, unknown> | null {
  const pose = cameraBus()?.pose?.()
  if (!pose) return null
  return {
    targetMm: pose.target.map((v) => round(v)),
    azimuthDeg: round(pose.azimuthDeg, 1),
    elevationDeg: round(pose.elevationDeg, 1),
    distanceMm: round(pose.distanceMm, 1),
    ...(pose.projection ? { projection: pose.projection } : {}),
    preset: pose.preset ?? null,
  }
}

/** The four together, as app_state carries them. */
export function uiState(s: UiSource, doc: Document = document): Record<string, unknown> {
  return { selection: selectionState(s), tool: toolState(s), panels: panelState(s, doc), camera: cameraState() }
}
