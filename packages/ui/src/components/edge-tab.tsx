'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tab on a panel's inner edge that shuts it and opens it again: left, right or bottom. One look for all three,
// the bottom panel's tab: a small lifted tab, rounded on the side that faces the view, with a grip mark along the
// panel's edge and a chevron that points where the panel will go. The parent owns the open state.
import type { MouseEvent } from 'react'
import { Icon } from '../icons/icon'
import { tipAttrs } from './tooltip'

export type EdgeSide = 'left' | 'right' | 'bottom'

export interface EdgeTabProps {
  side: EdgeSide
  open: boolean
  onToggle: () => void
  /** The panel's name, read out and shown in the tip: "Model tree", "Timeline". */
  label: string
  /** The key that does the same, for the tip. */
  shortcut?: string
  /** The panel's id. */
  controls?: string
  /** Which panel, as data-panel, for tests that tell two left panels apart ("model-tree", "slice-sidebar"). */
  panel?: string
  /** A second line for the tip. */
  tip?: string
  onContextMenu?: (e: MouseEvent<HTMLButtonElement>) => void
  className?: string
}

/** Which way the chevron points: toward where the panel goes when the tab is pressed. */
export function edgeChevron(side: EdgeSide, open: boolean): 'left' | 'right' | 'up' | 'down' {
  if (side === 'bottom') return open ? 'down' : 'up'
  if (side === 'left') return open ? 'left' : 'right'
  return open ? 'right' : 'left'
}

export function EdgeTab({ side, open, onToggle, label, shortcut, controls, panel, tip, onContextMenu, className }: EdgeTabProps) {
  return (
    <button
      type="button"
      className={className ? `sx-edge-tab sx-overlay ${className}` : 'sx-edge-tab sx-overlay'}
      data-side={side}
      data-panel={panel}
      data-testid={`edge-tab-${side}`}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={open ? `Close ${label}` : `Open ${label}`}
      {...tipAttrs({ title: label, ...(tip ? { body: tip } : {}), ...(shortcut ? { key: shortcut } : {}) })}
      onClick={onToggle}
      onContextMenu={onContextMenu}
    >
      {/* chevron-right turned by CSS: it ships with the shell, so the tab draws at first paint */}
      <Icon name="chevron-right" size={14} data-dir={edgeChevron(side, open)} />
    </button>
  )
}
