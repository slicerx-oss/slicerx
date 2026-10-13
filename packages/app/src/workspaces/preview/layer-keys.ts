// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The layer actions behind the look's preview keys (legend, one layer mode, layer up and down), as commands for the
// command bar and app tools, and `layerView`, which reads back what they and the jump to a layer field changed.
import type { CommandSpec } from '@slicerx/contracts'
import type { KeyAction } from '@slicerx/ui'
import { get, set } from '../../state/store'
import { layerCountNow, oneLayerOn, stepLayer } from './layer-step'

/** What the layer actions act on, as a client reads it back. */
export interface LayerView {
  /** Slice has a slice whose layers can be stepped. */
  showing: boolean
  /** Slice shows the toolpaths (the legend and the layer slider are drawn). */
  toolpaths: boolean
  /** The top drawn layer, 1 based (0 with no sliced layers). */
  layer: number
  layerCount: number
  /** The bottom drawn layer, 1 based. */
  lowest: number
  oneLayer: boolean
  legend: boolean
  /** The jump to a layer field is open in the playback bar. */
  jumpOpen: boolean
}

export function layerView(): LayerView {
  const s = get()
  const n = layerCountNow()
  const layer = n ? Math.max(1, Math.min(s.layerHi, n)) : 0
  return {
    showing: s.modelMode === 'slice' && n > 0,
    toolpaths: s.sliceLook === 'toolpaths',
    layer,
    layerCount: n,
    lowest: n ? Math.max(1, Math.min(s.layerLo, layer)) : 0,
    oneLayer: oneLayerOn(),
    legend: !s.legendHidden,
    jumpOpen: s.layerJump,
  }
}

export function toggleLegend(): void {
  set((s) => ({ legendHidden: !s.legendHidden }))
}

/** One layer: the bottom handle joins the top one; again, it goes back to the first layer. Shows the toolpaths. */
export function toggleOneLayer(): void {
  set((s) => {
    const hi = Math.max(1, Math.min(s.layerHi, layerCountNow()))
    return { layerLo: s.layerLo >= hi ? 1 : hi, sliceLook: 'toolpaths' }
  })
}

function layerStep(by: number): void {
  if (get().sliceLook !== 'toolpaths') set({ sliceLook: 'toolpaths' })
  stepLayer(by)
}

/** The layer actions as commands for the command bar and app tools, with the look's keys as their shortcuts. */
export function layerCommands(key: (a: KeyAction) => string | undefined): CommandSpec[] {
  const live = () => layerView().showing
  const withKey = (spec: CommandSpec, a: KeyAction): CommandSpec => {
    const k = key(a)
    return k ? { ...spec, shortcut: k } : spec
  }
  return [
    withKey({ id: 'layer-up', title: 'Layer up', section: 'view', keywords: ['layer', 'slider', 'next', 'higher'], workspace: 'prepare', tool: { permission: 'read' }, enabled: live, run: () => layerStep(1) }, 'preview.layerUp'),
    withKey({ id: 'layer-down', title: 'Layer down', section: 'view', keywords: ['layer', 'slider', 'previous', 'lower'], workspace: 'prepare', tool: { permission: 'read' }, enabled: live, run: () => layerStep(-1) }, 'preview.layerDown'),
    withKey({ id: 'layer-one', title: 'One layer mode', section: 'view', keywords: ['single', 'layer', 'only'], workspace: 'prepare', tool: { permission: 'read' }, enabled: live, run: toggleOneLayer }, 'preview.singleLayer'),
    withKey({ id: 'layer-legend', title: 'Show or hide the legend', section: 'view', keywords: ['legend', 'colors', 'key'], workspace: 'prepare', tool: { permission: 'read' }, enabled: live, run: toggleLegend }, 'preview.legend'),
  ]
}
