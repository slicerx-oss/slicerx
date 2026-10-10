// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The selection bar under the object list: how many are selected and what to do with them. Its menu, the rows' context
// menu and the view's share one list of items, so a verb is the same wherever it is asked for.
import { Button, ContextMenu, Menu, MenuAnchor, MenuItems, Popover, SelectionBar, type MenuEntry, type MenuPoint } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { createStore, useStore } from 'zustand'
import { runCommand } from '../../commands/registry'
import { effectiveMode, useLayout } from '../../first-run/look'
import { formatShortcut } from '../../lib/keys'
import { clearSelection } from '../../plate/edit'
import { history } from '../../plate/history'
import { toggleLock, togglePrintable } from '../../plate/object-list'
import { moveSelectedToPlate } from '../../plate/plates'
import { selectionSummary } from '../../plate/selection'
import { closeViewMenu, viewMenuStore } from '../../plate/view-menu'
import { removeSelected } from '../../state/actions'
import { get, selectedIds, set, toast, useApp } from '../../state/store'
import { ObjectTransform } from './object-transform'
import './selection.css'

/** The Transform popover, which the bar, its menu and the context menus all open. */
const transformStore = createStore<{ open: boolean; bars: number }>()(() => ({ open: false, bars: 0 }))
const setTransform = (open: boolean) => transformStore.setState({ open })

/** Deletes the selection; it is one undo step, so the toast offers Undo instead of a confirm first. */
export function deleteSelection(): void {
  const s = get()
  const names = selectionSummary(s.plate, selectedIds(s)).names
  if (!names.length) return
  removeSelected()
  toast(names.length === 1 ? `Deleted ${names[0]}.` : `Deleted ${names.length} objects.`, 'info', { label: 'Undo', run: () => void history().undo() })
}

/** Every verb for the selection, by id, in the order the menus list them. */
function useSelectionVerbs() {
  // Read apart: selectedIds() makes a new array when the primary is not in the list, which would loop a selector.
  const selection = useApp((s) => s.selection)
  const multi = useApp((s) => s.selectedIds)
  const ids = selectedIds({ selection, selectedIds: multi })
  const plate = useApp((s) => s.plate)
  const plates = useApp((s) => s.plates)
  const active = useApp((s) => s.activePlate)
  const sum = selectionSummary(plate, ids)
  const others = plates.filter((p) => p.id !== active)
  const moreOpen = useApp((s) => s.moreOpen['object'] === true)
  const verbs: Record<'arrange' | 'transform' | 'move' | 'skip' | 'lock' | 'center' | 'drop' | 'duplicate' | 'delete' | 'more', MenuEntry> = {
    arrange: { id: 'arrange', label: 'Arrange', icon: 'arrange', testId: 'slice-ctx-arrange', run: () => void runCommand('arrange-selection') },
    transform: { id: 'transform', label: 'Transform', icon: 'move', testId: 'slice-ctx-transform', run: () => setTransform(true) },
    move: {
      id: 'move',
      label: 'Move to plate',
      icon: 'plates',
      testId: 'slice-ctx-move-plate',
      children: others.map((p) => ({ id: `plate-${p.id}`, label: p.name, testId: `slice-ctx-plate-${plates.indexOf(p) + 1}`, run: () => void moveSelectedToPlate(p.id) })),
    },
    skip: sum.allSkipped
      ? { id: 'skip', label: 'Print', icon: 'show', testId: 'slice-ctx-skip', run: () => void togglePrintable(ids) }
      : { id: 'skip', label: 'Skip', icon: 'hide', testId: 'slice-ctx-skip', run: () => void togglePrintable(ids) },
    lock: sum.allLocked
      ? { id: 'lock', label: 'Unlock', icon: 'unlock', testId: 'slice-ctx-lock', run: () => void toggleLock(ids) }
      : { id: 'lock', label: 'Lock', icon: 'lock', testId: 'slice-ctx-lock', run: () => void toggleLock(ids) },
    center: { id: 'center', label: 'Center', icon: 'fit', testId: 'slice-ctx-center', run: () => void runCommand('center-object') },
    drop: { id: 'drop', label: 'Drop to bed', icon: 'arrow-down', testId: 'slice-ctx-drop', run: () => void runCommand('drop-to-bed') },
    duplicate: { id: 'duplicate', label: 'Duplicate', icon: 'duplicate', shortcut: formatShortcut('Mod+D'), testId: 'slice-ctx-duplicate', run: () => void runCommand('duplicate') },
    delete: { id: 'delete', label: 'Delete', icon: 'delete', shortcut: 'Delete', danger: true, testId: 'danger-slice-ctx-delete', run: deleteSelection },
    // Simple's More for the object (its volumes), which has no button of its own there.
    more: { id: 'more', label: moreOpen ? 'Hide volumes' : 'Volumes', icon: 'sliders', testId: 'slice-ctx-more', run: () => set((s) => ({ moreOpen: { ...s.moreOpen, object: !moreOpen } })) },
  }
  return { ids, sum, verbs, hasPlates: others.length > 0 }
}

/** The context menu for the selection, on a row or in the view: every verb. */
export function SelectionMenu({ at, onClose, label }: { at: MenuPoint | null; onClose: () => void; label: string }) {
  const { verbs, hasPlates } = useSelectionVerbs()
  // Transform opens from the bar; with its pane shut there is nowhere to show it.
  const bar = useStore(transformStore, (s) => s.bars > 0)
  const items = [verbs.arrange, ...(bar ? [verbs.transform] : []), ...(hasPlates ? [verbs.move] : []), verbs.skip, verbs.lock, verbs.center, verbs.drop, verbs.duplicate, verbs.delete]
  return (
    <ContextMenu at={at} onClose={onClose} label={label} testId="slice-ctx" target="selection">
      <MenuItems items={items} onClose={onClose} />
    </ContextMenu>
  )
}

/** The selection's menu at a right click in the view. */
export function ViewSelectionMenu() {
  const at = useStore(viewMenuStore, (s) => s.at)
  const label = useApp((s) => s.plate.find((p) => p.id === s.selection)?.name ?? 'Selection')
  return <SelectionMenu at={at} onClose={closeViewMenu} label={label} />
}

/** The bar itself: shown while one or more objects are selected. */
export function SelectionActions() {
  const { ids, sum, verbs, hasPlates } = useSelectionVerbs()
  const simple = effectiveMode(useApp((s) => s.settingsMode), useLayout()) === 'simple'
  const [menu, setMenu] = useState<'more' | 'move' | null>(null)
  const transform = useStore(transformStore, (s) => s.open)
  const shown = ids.length > 0
  useEffect(() => {
    if (!shown) return
    transformStore.setState((s) => ({ bars: s.bars + 1 }))
    return () => transformStore.setState((s) => ({ bars: s.bars - 1, open: s.bars > 1 && s.open }))
  }, [shown])
  if (!shown) return null
  const close = () => setMenu(null)
  // Simple keeps the bar to its count, the menu and the way out (the rows have their own lock and print toggles).
  const more = simple ? [verbs.skip, verbs.lock, verbs.arrange, verbs.transform, verbs.center, verbs.drop, verbs.duplicate, verbs.more, verbs.delete] : [verbs.center, verbs.drop, verbs.duplicate, verbs.delete]
  const popover = (
    <Popover open={transform} onClose={() => setTransform(false)} label="Transform" align="end" className="selbar-transform">
      <ObjectTransform full />
    </Popover>
  )
  const run = (v: MenuEntry) => () => v.run?.()
  return (
    <SelectionBar
      className="slice-selbar"
      data-testid="slice-selection-bar"
      count={<span data-testid="slice-selection-count">{sum.count} selected</span>}
      onClear={clearSelection}
      clearTestId="slice-selection-clear"
    >
      {simple ? null : (
        <>
          <Button size="sm" variant="ghost" icon="arrange" data-testid="slice-selection-arrange" aria-label="Arrange" onClick={run(verbs.arrange)} tip={{ title: 'Arrange', body: 'Pack the selected objects on the plate.' }} />
          <MenuAnchor>
            <Button size="sm" variant="ghost" icon="move" data-testid="slice-selection-transform" aria-label="Transform" aria-haspopup="dialog" aria-expanded={transform} onClick={() => setTransform(!transform)} tip={{ title: 'Transform', body: 'Position, rotation, scale and size in numbers.' }} />
            {popover}
          </MenuAnchor>
        </>
      )}
      {hasPlates ? (
        <MenuAnchor>
          <Button size="sm" variant="ghost" icon="plates" data-testid="slice-selection-move-plate" aria-label="Move to plate" aria-haspopup="menu" aria-expanded={menu === 'move'} onClick={() => setMenu(menu === 'move' ? null : 'move')} tip={{ title: 'Move to plate', body: 'Send the selected objects to another plate.' }} />
          <Menu open={menu === 'move'} onClose={close} label="Move to plate" align="end">
            <MenuItems items={verbs.move.children ?? []} onClose={close} />
          </Menu>
        </MenuAnchor>
      ) : null}
      {simple ? null : (
        <>
        <Button size="sm" variant="ghost" icon={verbs.skip.icon!} data-testid="slice-selection-skip" aria-label={verbs.skip.label} aria-pressed={sum.allSkipped} onClick={run(verbs.skip)} tip={{ title: verbs.skip.label, body: sum.allSkipped ? 'Print the selected objects again.' : 'Leave the selected objects out of the print.' }} />
        <Button size="sm" variant="ghost" icon={verbs.lock.icon!} data-testid="slice-selection-lock" aria-label={verbs.lock.label} aria-pressed={sum.allLocked} onClick={run(verbs.lock)} tip={{ title: verbs.lock.label, body: sum.allLocked ? 'Let the selected objects move again.' : 'Keep the selected objects where they are.' }} />
        </>
      )}
      <MenuAnchor>
        {/* In Simple the menu holds every verb, so it says so; on the fuller bar it is the overflow. */}
        {simple ? (
          <Button size="sm" variant="ghost" data-testid="slice-selection-more" aria-haspopup="menu" aria-expanded={menu === 'more'} onClick={() => setMenu(menu === 'more' ? null : 'more')} tip={{ title: 'Actions', body: 'Skip, lock, arrange, transform and more for the selected objects.' }}>
            Actions
          </Button>
        ) : (
          <Button size="sm" variant="ghost" icon="more" data-testid="slice-selection-more" aria-label="More actions" aria-haspopup="menu" aria-expanded={menu === 'more'} onClick={() => setMenu(menu === 'more' ? null : 'more')} tip="More actions" />
        )}
        <Menu open={menu === 'more'} onClose={close} label="Selection actions" align="end" testId="slice-selection-menu">
          <MenuItems items={more} onClose={close} />
        </Menu>
        {simple ? popover : null}
      </MenuAnchor>
    </SelectionBar>
  )
}
