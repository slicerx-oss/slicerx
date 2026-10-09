// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An object's menu in the Model tree. The icon row has the likeliest verbs; the items are the ones the palette and the
// Slice tools run, through the same commands, on the selection the right click made. A step's menu is in
// cad/history/step-menu.tsx.
import { ContextMenu, MenuIcon, MenuIconRow, MenuItem, type MenuPoint } from '@slicerx/ui'
import { runCommand } from '../../commands/registry'
import { formatShortcut } from '../../lib/keys'
import { toggleLock, togglePrintable } from '../../plate/object-list'
import { setModelMode, useApp, type PlateEntry } from '../../state/store'

export function ObjectMenu({ at, onClose, entry, onRename }: { at: MenuPoint | null; onClose: () => void; entry: PlateEntry; onRename: () => void }) {
  const count = useApp((s) => s.selectedIds.length)
  const run = (fn: () => void) => () => {
    onClose()
    fn()
  }
  const cmd = (id: string) => run(() => void runCommand(id))
  return (
    <ContextMenu at={at} onClose={onClose} label={entry.name} testId="model-ctx" target="object">
      <MenuIconRow>
        <MenuIcon icon="rename" label="Rename" shortcut="F2" onClick={run(onRename)} data-testid="model-ctx-rename" />
        <MenuIcon icon={entry.locked ? 'lock' : 'unlock'} label={entry.locked ? 'Unlock' : 'Lock'} pressed={Boolean(entry.locked)} onClick={run(() => void toggleLock([entry.id]))} data-testid="model-ctx-lock" />
        <MenuIcon icon={entry.printable === false ? 'hide' : 'show'} label={entry.printable === false ? 'Print it' : 'Leave out of the print'} pressed={entry.printable === false} onClick={run(() => void togglePrintable([entry.id]))} data-testid="model-ctx-printable" />
        <MenuIcon icon="delete" label="Delete" tone="danger" shortcut="Delete" onClick={cmd('plate-remove')} data-testid="danger-model-ctx-delete" />
      </MenuIconRow>
      <MenuItem icon="split" data-testid="model-ctx-split-objects" onClick={cmd('split-objects')}>
        Split to objects
      </MenuItem>
      <MenuItem icon="split" data-testid="model-ctx-split-parts" onClick={cmd('split-parts')}>
        Split to parts
      </MenuItem>
      <MenuItem icon="merge" disabled={count < 2} {...(count < 2 ? { 'data-tip-title': 'Select two objects to merge.' } : {})} data-testid="model-ctx-merge" onClick={cmd('merge-objects')}>
        Merge selected objects
      </MenuItem>
      <MenuItem icon="duplicate" aside={formatShortcut('Mod+D')} data-testid="model-ctx-duplicate" onClick={cmd('duplicate')}>
        Duplicate
      </MenuItem>
      <MenuItem icon="fit" data-testid="model-ctx-center" onClick={cmd('center-object')}>
        Center on the bed
      </MenuItem>
      <MenuItem icon="arrow-down" data-testid="model-ctx-drop" onClick={cmd('drop-to-bed')}>
        Drop to the bed
      </MenuItem>
      <MenuItem icon="slice" data-testid="model-ctx-slice" onClick={run(() => setModelMode('slice'))}>
        Go to Slice with it selected
      </MenuItem>
    </ContextMenu>
  )
}
