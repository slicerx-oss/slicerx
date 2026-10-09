// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A step's menu in the Model tree, from a right click, a long press, Shift+F10 or its More button: the likeliest
// verbs as an icon row, then rename, the moves, the sketch and the way back to the latest. Delete asks first, since
// later steps that use the step may break.
import { formatShortcut } from '../../lib/keys'
import { Button, ContextMenu, Dialog, MenuIcon, MenuIconRow, MenuItem, type MenuPoint } from '@slicerx/ui'

export interface StepMenuProps {
  at: MenuPoint | null
  onClose: () => void
  name: string
  index: number
  last: boolean
  suppressed: boolean
  /** The step opens in a tool panel. */
  editable: boolean
  /** The part is rolled back to look at this step or an earlier one. */
  rolledBack: boolean
  viewing: boolean
  hasSketch: boolean
  onEdit: () => void
  onView: () => void
  onEnd: () => void
  onSuppress: () => void
  onMove: (to: number) => void
  onRename: () => void
  onDelete: () => void
}

export function StepMenu(p: StepMenuProps) {
  const run = (fn: () => void) => () => {
    p.onClose()
    fn()
  }
  return (
    <ContextMenu at={p.at} onClose={p.onClose} label={p.name} testId="model-ctx" target="step">
      <MenuIconRow>
        <MenuIcon icon="sliders" label="Edit" disabled={!p.editable} reason="This step has no tool to open; change its number in the list." onClick={run(p.onEdit)} data-testid="model-ctx-edit" />
        <MenuIcon icon="roll-to-here" label={p.viewing ? 'Back to the latest' : 'Roll to here'} pressed={p.viewing} onClick={run(p.onView)} data-testid="model-ctx-roll" />
        <MenuIcon icon={p.suppressed ? 'show' : 'hide'} label={p.suppressed ? 'Turn on' : 'Turn off'} pressed={p.suppressed} onClick={run(p.onSuppress)} data-testid="model-ctx-suppress" />
        <MenuIcon icon="delete" label="Delete" tone="danger" onClick={run(p.onDelete)} data-testid="danger-model-ctx-delete" />
      </MenuIconRow>
      <MenuItem icon="rename" aside="F2" data-testid="model-ctx-rename" onClick={run(p.onRename)}>
        Rename
      </MenuItem>
      <MenuItem icon="arrow-up" aside={formatShortcut('Alt+Up')} disabled={p.index === 0} data-testid="model-ctx-earlier" onClick={run(() => p.onMove(p.index - 1))}>
        Move earlier
      </MenuItem>
      <MenuItem icon="arrow-down" aside={formatShortcut('Alt+Down')} disabled={p.last} data-testid="model-ctx-later" onClick={run(() => p.onMove(p.index + 1))}>
        Move later
      </MenuItem>
      {p.hasSketch ? (
        <MenuItem icon="ruler" disabled={!p.editable} data-testid="model-ctx-sketch" onClick={run(p.onEdit)}>
          Show the sketch
        </MenuItem>
      ) : null}
      {p.rolledBack ? (
        <MenuItem icon="arrow-down" data-testid="model-ctx-end" onClick={run(p.onEnd)}>
          Roll to end
        </MenuItem>
      ) : null}
    </ContextMenu>
  )
}

/** Delete asks first: steps after it that build on it may break. */
export function DeleteStepDialog({ name, open, onCancel, onDelete }: { name: string; open: boolean; onCancel: () => void; onDelete: () => void }) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={`Delete ${name}?`}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" data-testid="danger-model-confirm-delete" onClick={onDelete}>
            Delete
          </Button>
        </>
      }
    >
      <p className="sx-small">Later steps that use it may break.</p>
    </Dialog>
  )
}
