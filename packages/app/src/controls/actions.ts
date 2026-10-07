// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Labels and groups for the keyboard shortcuts in Settings > Controls, and the keys every look shares.
// The list follows the shortcut dialogs of OrcaSlicer (KBShortcutsDialog.cpp, v2.4.2), Bambu Studio and
// PrusaSlicer: Global, Prepare (plater and toolbar), Preview.
import { KEY_ACTIONS, keymapFor, KEYMAPS, type KeyAction } from '@slicerx/ui'
import { matchShortcut } from '../lib/keys'

export type ActionGroup = 'Global' | 'Prepare' | 'Views' | 'Preview'

export const ACTION_LABEL: Record<KeyAction, { label: string; group: ActionGroup }> = {
  'view.plate': { label: 'View the whole plate', group: 'Views' },
  'view.top': { label: 'Top view', group: 'Views' },
  'view.bottom': { label: 'Bottom view', group: 'Views' },
  'view.front': { label: 'Front view', group: 'Views' },
  'view.back': { label: 'Back view', group: 'Views' },
  'view.left': { label: 'Left view', group: 'Views' },
  'view.right': { label: 'Right view', group: 'Views' },
  'view.iso': { label: 'Isometric view', group: 'Views' },
  'view.zoomSelection': { label: 'Zoom to the selection', group: 'Views' },
  'view.zoomBed': { label: 'Zoom to the bed', group: 'Views' },
  'view.projection': { label: 'Switch perspective and orthographic', group: 'Views' },
  'tool.move': { label: 'Move tool', group: 'Prepare' },
  'tool.rotate': { label: 'Rotate tool', group: 'Prepare' },
  'tool.scale': { label: 'Scale tool', group: 'Prepare' },
  'tool.cut': { label: 'Cut tool', group: 'Prepare' },
  'tool.placeOnFace': { label: 'Lay on face tool', group: 'Prepare' },
  'tool.supports': { label: 'Support painting tool', group: 'Prepare' },
  'tool.orient': { label: 'Auto orient', group: 'Prepare' },
  'plate.arrange': { label: 'Arrange all objects', group: 'Prepare' },
  'plate.arrangeSelected': { label: 'Arrange the selected objects', group: 'Prepare' },
  'edit.copy': { label: 'Copy', group: 'Prepare' },
  'edit.cut': { label: 'Cut', group: 'Prepare' },
  'edit.paste': { label: 'Paste', group: 'Prepare' },
  'edit.duplicate': { label: 'Duplicate', group: 'Prepare' },
  'object.printable': { label: 'Toggle printable for the selected objects', group: 'Prepare' },
  'workspace.toggle': { label: 'Switch between the plate and Preview', group: 'Global' },
  'model.mode': { label: 'Switch between Design and Slice', group: 'Global' },
  slice: { label: 'Slice the plate', group: 'Global' },
  export: { label: 'Export the sliced plate', group: 'Global' },
  palette: { label: 'Open the command bar', group: 'Global' },
  'preview.legend': { label: 'Show or hide the legend', group: 'Preview' },
  'preview.singleLayer': { label: 'One layer mode', group: 'Preview' },
  'preview.jumpToLayer': { label: 'Jump to a layer', group: 'Preview' },
  'preview.layerUp': { label: 'Layer slider up', group: 'Preview' },
  'preview.layerDown': { label: 'Layer slider down', group: 'Preview' },
  'help.shortcuts': { label: 'Show this list', group: 'Global' },
}

/** An action's name as shown: the plate tab is called what the active look calls it. `tab` is that name. */
export function actionLabel(action: KeyAction, tab: string): string {
  return action === 'workspace.toggle' ? `Switch between ${tab} and Preview` : ACTION_LABEL[action].label
}

/** A group's heading as shown. The group keys stay as they are; the Prepare group takes the tab's name. */
export function groupLabel(group: ActionGroup, tab: string): string {
  return group === 'Prepare' ? tab : group
}

export const GROUPS: readonly ActionGroup[] = ['Global', 'Prepare', 'Views', 'Preview']

/** Keys that are the same in every look and cannot be changed here. */
export const FIXED_KEYS: readonly { chord: string; label: string }[] = [
  { chord: 'Mod+Z', label: 'Undo' },
  { chord: 'Mod+Shift+Z', label: 'Redo' },
  { chord: 'Mod+Y', label: 'Redo' },
  { chord: 'Mod+A', label: 'Select all objects' },
  { chord: 'Mod+S', label: 'Save the project' },
]

export { KEY_ACTIONS, keymapFor, KEYMAPS, matchShortcut }

/** The chord an event makes, in the keymap's own format: "Mod+Shift+A", "Up", "Shift+?". Null for a bare modifier key. */
export function chordOf(e: { key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, mac: boolean): string | null {
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return null
  const parts: string[] = []
  if (mac ? e.metaKey : e.ctrlKey) parts.push('Mod')
  if (e.altKey) parts.push('Alt')
  const named: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space' }
  // Letters and digits by the physical key: Alt and Shift change e.key.
  const physical = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : null
  const key = named[e.key] ?? physical ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key)
  // matchShortcut wants Shift present exactly when the event has it, so "?" is written "Shift+?".
  if (e.shiftKey) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}
