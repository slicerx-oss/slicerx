// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A finished sketch's menu, in the timeline strip and the Model tree: change it, or extrude or revolve it.
import { ContextMenu, MenuItem, type MenuPoint } from '@slicerx/ui'
import { openSketch } from './sketches'

const LATER = 'Rolled back: move the timeline marker past it first.'

export function SketchMenu({ at, onClose, id, name, later }: { at: MenuPoint | null; onClose: () => void; id: string; name: string; later: boolean }) {
  const tip = later ? { 'data-tip-title': LATER } : {}
  const run = (mode: 'edit' | 'extrude' | 'revolve') => () => {
    onClose()
    openSketch({ id, mode })
  }
  return (
    <ContextMenu at={at} onClose={onClose} label={name} testId="sketch-ctx" target="sketch">
      <MenuItem icon="sketch" disabled={later} {...tip} data-testid="sketch-ctx-edit" onClick={run('edit')}>
        Edit sketch
      </MenuItem>
      <MenuItem icon="extrude" disabled={later} {...tip} data-testid="sketch-ctx-extrude" onClick={run('extrude')}>
        Extrude
      </MenuItem>
      <MenuItem icon="revolve" disabled={later} {...tip} data-testid="sketch-ctx-revolve" onClick={run('revolve')}>
        Revolve
      </MenuItem>
    </ContextMenu>
  )
}
