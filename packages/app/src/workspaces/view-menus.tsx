// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The viewport's own controls: render look and view angle as icon buttons, and the toolpath colors as the legend's
// labeled Color by menu.
import { Button, Menu, MenuAnchor, MenuItem, type IconName } from '@slicerx/ui'
import { useState } from 'react'
import { pickColorMode, setCamera, useApp, type CameraView, type ColorMode, type PrepareLook } from '../state/store'
import { set } from '../state/store'

const LOOKS: { value: PrepareLook; label: string; icon: IconName }[] = [
  { value: 'studio', label: 'Studio', icon: 'cube' },
  { value: 'clay', label: 'Clay', icon: 'clay' },
  { value: 'xray', label: 'X-ray', icon: 'x-ray' },
  { value: 'overhang', label: 'Overhang', icon: 'overhang' },
  { value: 'filament', label: 'Filament', icon: 'spool' },
]

const VIEWS: { value: Exclude<CameraView, 'fit'>; label: string; icon: IconName; key: string }[] = [
  { value: 'iso', label: 'Isometric', icon: 'iso-view', key: '7' },
  { value: 'top', label: 'Top', icon: 'top-view', key: '1' },
  { value: 'front', label: 'Front', icon: 'front-view', key: '3' },
]

const COLORS: { value: ColorMode; label: string; id: string }[] = [
  { value: 'feature', label: 'Feature type', id: 'feature' },
  { value: 'tool', label: 'Filament', id: 'tool' },
  { value: 'speed', label: 'Speed', id: 'speed' },
  { value: 'flow', label: 'Flow', id: 'flow' },
  { value: 'layerTime', label: 'Layer time', id: 'layer-time' },
]

export function RenderMenu() {
  const look = useApp((s) => s.look)
  const [open, setOpen] = useState(false)
  const cur = LOOKS.find((l) => l.value === look) ?? LOOKS[0]!
  return (
    <MenuAnchor>
      <Button variant="ghost" size="sm" icon={cur.icon} aria-haspopup="menu" aria-expanded={open} aria-label={`Render look: ${cur.label}`} tip={{ title: 'Render look', body: 'Change how the model is drawn.' }} onClick={() => setOpen(!open)} />
      <Menu open={open} onClose={() => setOpen(false)} label="Render look">
        {LOOKS.map((l) => (
          <MenuItem key={l.value} icon={l.icon} aria-checked={l.value === look} onClick={() => { set({ look: l.value }); setOpen(false) }}>
            {l.label}
          </MenuItem>
        ))}
      </Menu>
    </MenuAnchor>
  )
}

export function ViewMenu() {
  const camera = useApp((s) => s.camera)
  const [open, setOpen] = useState(false)
  const cur = VIEWS.find((v) => v.value === camera)
  return (
    <>
      <MenuAnchor>
        <Button variant="ghost" size="sm" icon={cur?.icon ?? 'iso-view'} aria-haspopup="menu" aria-expanded={open} aria-label="View" tip={{ title: 'View', body: 'Look at the plate from the top, the front or an angle.' }} onClick={() => setOpen(!open)} />
        <Menu open={open} onClose={() => setOpen(false)} label="View" align="end">
          {VIEWS.map((v) => (
            <MenuItem key={v.value} icon={v.icon} aside={v.key} aria-checked={v.value === camera} onClick={() => { setCamera(v.value); setOpen(false) }}>
              {v.label}
            </MenuItem>
          ))}
        </Menu>
      </MenuAnchor>
      <Button variant="ghost" size="sm" icon="fit" aria-label="Fit" tip="view.fit" onClick={() => setCamera('fit')} />
    </>
  )
}

/** The legend's Color by menu: what the toolpath colors show. A pick stays through later slices. */
export function ColorBy() {
  const mode = useApp((s) => s.colorMode)
  const [open, setOpen] = useState(false)
  const cur = COLORS.find((c) => c.value === mode) ?? COLORS[0]!
  const pick = (m: ColorMode) => {
    pickColorMode(m)
    setOpen(false)
  }
  return (
    <div className="legend-color-by">
      <span id="legend-color-by-label">Color by</span>
      <MenuAnchor>
        <Button variant="ghost" size="sm" iconEnd="chevron-down" data-testid="legend-color-by" aria-haspopup="menu" aria-expanded={open} aria-labelledby="legend-color-by-label legend-color-by-value" tip={{ title: 'Toolpath colors', body: 'Color the toolpaths by feature, filament, speed, flow or layer time.' }} onClick={() => setOpen(!open)}>
          <span id="legend-color-by-value">{cur.label}</span>
        </Button>
        <Menu open={open} onClose={() => setOpen(false)} label="Color toolpaths by">
          {COLORS.map((c) => (
            <MenuItem key={c.value} data-testid={`legend-color-${c.id}`} aria-checked={c.value === mode} onClick={() => pick(c.value)}>
              {c.label}
            </MenuItem>
          ))}
        </Menu>
      </MenuAnchor>
    </div>
  )
}
