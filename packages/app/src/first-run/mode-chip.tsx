// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The settings mode chip in the Slice pane title: the mode in one word, and a menu that says what each one shows.
// A look with two modes keeps its Advanced switch in the same place. It loads with the plate tab, not at startup.
import type { LayoutSpec } from '@slicerx/contracts'
import { ChipButton, Menu, MenuAnchor, MenuItem } from '@slicerx/ui'
import { useState } from 'react'
import { set, useApp, type SettingsMode } from '../state/store'
import { effectiveMode } from './look'
import { ModeSelector } from './mode-selector'
import './mode-chip.css'

export const MODE_LABEL: Record<SettingsMode, string> = { simple: 'Simple', advanced: 'Advanced', expert: 'Expert', developer: 'Developer' }

/** One line per mode in the chip's menu. */
export const MODE_LINE: Record<SettingsMode, string> = {
  simple: 'The few settings most prints need.',
  advanced: 'Grouped settings by what they do.',
  expert: 'Every process setting, with search.',
  developer: 'Expert plus setting keys and developer tools.',
}

export function ModeChip({ layout }: { layout: LayoutSpec }) {
  const mode = effectiveMode(useApp((s) => s.settingsMode), layout)
  const [open, setOpen] = useState(false)
  if (layout.modes.length <= 2) return <span className="mode-chip mode-chip-switch"><ModeSelector layout={layout} id="mode-head" /></span>
  return (
    <MenuAnchor className="mode-chip">
      <ChipButton menu aria-expanded={open} aria-label={`Settings mode: ${MODE_LABEL[mode]}`} data-testid="slice-mode-chip" tip={{ title: 'Settings mode', body: MODE_LINE[mode] }} onClick={() => setOpen(!open)}>
        {MODE_LABEL[mode]}
      </ChipButton>
      <Menu open={open} onClose={() => setOpen(false)} label="Settings mode" align="end" className="mode-chip-menu">
        {layout.modes.map((m) => (
          <MenuItem
            key={m}
            checked={m === mode}
            data-testid={`slice-mode-chip-${m}`}
            onClick={() => {
              set({ settingsMode: m })
              setOpen(false)
            }}
          >
            <b>{MODE_LABEL[m]}</b>
            <small>{MODE_LINE[m]}</small>
          </MenuItem>
        ))}
      </Menu>
    </MenuAnchor>
  )
}
