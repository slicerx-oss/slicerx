// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slice's panes and view switches as a client reads them back: whether the right pane (objects and the slice summary)
// and the playback bar's sliders are open, the Show toolhead and Show gantry switches, and the plate toolbar's size and
// whether it was dragged from its place. The panes are read from the page, so they say what is on screen.
import { get, type AppState } from '../state/store'

export interface SlicePanes {
  /** Slice's right pane: open, shut, or null when Slice is not on screen. */
  rightPane: 'open' | 'shut' | null
  /** The person shut the right pane by hand for this project: a finished slice leaves it shut. */
  rightPaneHeldShut: boolean
  /** The playback bar under the view: open with its sliders, shut to its transport row, or null with no slice shown. */
  drawer: 'open' | 'shut' | null
  showToolhead: boolean
  showGantry: boolean
  /** The plate toolbar with the view switch under it, in px, and whether it was dragged; null when it is not shown. */
  toolbar: { widthPx: number; heightPx: number; moved: boolean } | null
}

export function slicePanes(s: Pick<AppState, 'showToolhead' | 'showGantry' | 'rightShut' | 'jobSeq'> = get(), doc: Document = document): SlicePanes {
  const tab = doc.querySelector('.sx-edge-tab[data-panel="slice-summary"]')
  const dock = doc.querySelector('[data-testid="preview-drawer"]')
  const bar = doc.querySelector('[data-testid="plate-tools-group"]')
  const box = bar?.querySelector('.plate-tools')?.getBoundingClientRect()
  return {
    rightPane: tab ? (tab.getAttribute('aria-expanded') === 'true' ? 'open' : 'shut') : null,
    rightPaneHeldShut: s.rightShut !== null && s.rightShut === s.jobSeq,
    drawer: dock ? (dock.getAttribute('data-mode') === 'slim' ? 'shut' : 'open') : null,
    showToolhead: s.showToolhead,
    showGantry: s.showGantry,
    toolbar: bar && box ? { widthPx: Math.round(box.width), heightPx: Math.round(box.height), moved: bar.hasAttribute('data-moved') } : null,
  }
}
