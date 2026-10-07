// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Feature tooltip copy, one entry per stable id. Titles match the control's name in the UI; a body
// is one sentence that starts with a verb, at most 90 characters. `key` names a keymap action (so the
// chip follows the look preset and the person's remaps) or a fixed chord.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import type { KeyAction } from '@slicerx/ui'
import { appName } from '../edition'
import { get } from '../state/store'

export interface TipEntry {
  title: string
  body: string
  key?: KeyAction | string
  /** Whether `key` is a keymap action. Fixed chords are written as "Mod+Z". */
  action?: boolean
  /** Shown when the control is unavailable. */
  reason?: string
}

const a = (title: string, body: string, key: KeyAction, reason?: string): TipEntry => ({ title, body, key, action: true, ...(reason ? { reason } : {}) })
const f = (title: string, body: string, key?: string, reason?: string): TipEntry => ({ title, body, ...(key ? { key } : {}), ...(reason ? { reason } : {}) })

export const TIPS = {
  'tool.move': a('Move', 'Drag the model across the plate.', 'tool.move', 'Select an object first.'),
  'tool.rotate': a('Rotate', 'Drag a ring to turn the model around that axis. Hold Shift to turn in 15° steps.', 'tool.rotate', 'Select an object first.'),
  'tool.scale': a('Scale', 'Resize the model, uniformly or per axis.', 'tool.scale', 'Select an object first.'),
  'tool.placeOnFace': a('Lay on face', 'Pick a face to put flat on the bed.', 'tool.placeOnFace', 'Select an object first.'),
  'tool.paint': a('Paint', 'Paint supports, seams or colors onto the surface.', 'tool.supports', 'Select an object first.'),
  'tool.brim': f('Brim ears', 'Click the model to put a brim ear under it, right click an ear to remove it.', undefined, 'Select an object first.'),
  'plate.arrange': a('Arrange all', 'Nest every object on the plate by its real outline, so parts tuck into each other.', 'plate.arrange', 'Add an object first.'),
  'plate.arrangeOptions': f('Arrange options', 'Set the gap, the turns and how long to search for a fuller plate.'),
  'plate.drop': f('Drop to bed', 'Lower the model until it touches the bed.', undefined, 'Select an object first.'),
  'plate.add': f('Add a plate', 'Start another plate for a separate print.'),
  'plate.settings': f('Plate settings', 'Set the bed type and print order for this plate.'),
  'edit.undo': f('Undo', 'Take back the last change.', 'Mod+Z', 'Nothing to undo.'),
  'edit.redo': f('Redo', 'Bring back the change you took back.', 'Mod+Shift+Z', 'Nothing to redo.'),
  'view.fit': a('Fit', 'Frame the whole plate in view.', 'view.plate'),
  slice: a('Slice plate', 'Turn this plate into printable toolpaths.', 'slice'),
  smartLayer: f('sleipnir', 'Change layer height with the shape for smoother surfaces.'),
  'cad.push': f('Push and pull', 'Drag a flat face in or out to cut or add material. Hold Shift for 1 mm steps.'),
  'sketch.enter': f('Sketch', 'Draw a 2D shape on the bed or a flat face.'),
  'cad.svgFace': f('SVG on a face', 'Place an SVG outline on a face or the bed, then join, cut or add it.'),
  'cad.fillet': f('Fillet and chamfer', 'Round or bevel straight edges between flat faces; Shift and click adds edges.'),
  'cad.edgeLoop': f('Whole loop', 'Add every edge around the face the last pick was on.'),
  'sketch.corners': f('Round corners', 'Round or bevel corners between two straight lines of the picked loop.'),
  'history.edit': f('Edit this step', 'Open the step in its tool on the part as it was then; later steps run again on apply.'),
  'history.suppress': f('Suppress', 'Leave this step out and run the rest without it; click again to bring it back.'),
  'history.delete': f('Delete this step', 'Remove the step and run the later ones again; undo brings it back.'),
  'history.view': f('Show the part after this step', 'See the part as it was right after this step; click again to return to the latest.'),
  'history.earlier': f('Move earlier', 'Run this step before the one above it; the steps run again and say if one no longer works.'),
  'history.later': f('Move later', 'Run this step after the one below it; the steps run again and say if one no longer works.'),
  'cad.keepDimension': f('Keep this dimension', 'Keep the measurement on the model, so it updates after each edit.'),
  'sketch.look': f('Look at the sketch', 'Turn the view square onto the sketch plane.'),
  'sketch.extrude': f('Extrude', 'Pull a sketch profile into a solid.'),
  'nav.printers': f('Printers', 'Open your printers and their status.'),
  // A tool left open in Design says so on its tab.
  get 'mode.design'() {
    const p = get().parked
    return a('Design', p?.tool ? `${p.label ?? 'A tool'} in progress. Open Design to finish it.` : 'Model parts: sketches, features and their history, on the same plate.', 'model.mode')
  },
  'mode.slice': a('Slice', 'Set up the plate, printer and settings, then slice.', 'model.mode'),
  get 'nav.settings'() {
    return f('Settings', `Change how ${appName()} looks, behaves and connects.`)
  },
  'account.open': f('Account', 'Open your account settings.'),
  'volume.copy': f('Copy part', 'Copy this part, then paste it into another object.'),
  'pilot.ask': f(`Ask ${ASSISTANT_NAME}`, 'Ask a question about your print.', 'Mod+/'),
  'pilot.expand': f(`Expand ${ASSISTANT_NAME}`, 'Open the panel.'),
  'pilot.collapse': f(`Collapse ${ASSISTANT_NAME}`, 'Shrink the panel to a button.'),
  'pilot.close': f(`Close ${ASSISTANT_NAME}`, 'Hide the panel until you ask again.', 'Mod+/'),
  'preset.update': f('Update preset', 'Replace this preset with your current changes.'),
  'pane.resize': f('Resize', 'Drag to resize. Double-click to collapse.'),
  'theme.import': f('Import theme', 'Add a theme from a JSON file.'),
  'theme.export': f('Export theme', 'Save the current theme as a JSON file to share.'),
  'theme.folder': f('Open themes folder', 'Drop theme files here and they appear in the list.'),
  'theme.remove': f('Remove theme', 'Delete this imported theme from the list.'),
  'preset.export': f('Export preset', 'Save a profile that OrcaSlicer and Bambu Studio can open.'),
} as const satisfies Record<string, TipEntry>

export type TipId = keyof typeof TIPS

/** Tip ids of the form `setting:<key>` show that setting's label, note and figure. */
export const SETTING_TIP = 'setting:'

/**
 * Marks a settings row so hovering or focusing anything in it shows the setting's note. The tip sits
 * beside the row (`avoid` names the row's selector), so it never covers the control being edited.
 */
export function settingTipAttrs(key: string, avoid = '.field'): Record<string, string> {
  return { 'data-tip': `${SETTING_TIP}${key}`, 'data-tip-avoid': avoid }
}

/** Longer copy for one value of an enum setting, keyed `<setting key>.<value>`. Shown on the picker while that value is chosen. */
export const OPTION_TIPS: Readonly<Record<string, { title: string; body: string }>> = {
  'wall_generator.aegis': {
    title: 'aegis',
    body: 'aegis varies wall width to fit the part, so thin features print solid and walls stay even, with fewer width changes than Arachne on the shapes we measured.',
  },
  'prime_tower.atlas': {
    title: 'atlas',
    body: "atlas places and sizes the prime tower for you: clear of your objects and the printer's no-go zones, and reshaped when the plate leaves little room. Turn it off to drag the tower in the view or type a spot.",
  },
  'smart_layer.sleipnir': {
    title: 'sleipnir',
    body: 'sleipnir changes the layer height as the part goes up: thinner layers on curves and slopes where steps would show, and your layer height everywhere else. On multi-color plates it keeps layers fixed where colors change, so it adds no filament changes.',
  },
}
