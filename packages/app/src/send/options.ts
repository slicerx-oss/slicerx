// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print options a send offers per printer live in the printer catalog (send-options), which printer.queue reads
// too, so the Print sheet and a client's send offer the same options with the same defaults.
import { EXTERNAL_SLOT, pluginHas, type FilamentSlot, type MapSlot, type StartOptions } from '@slicerx/contracts'

export { chosenOptions, defaultOptions, mergeOptions, optionLabel, optionLines, optionTip, SEND_OPTION_IDS, supportedOptions, unsupportedOptions, type SendOptionChoices, type SendOptionId, type SendOptionSpec } from '@slicerx/printer-catalog/send-options'

// The slot match is shared with printer.queue, so a client's send starts from the same slots as the Print sheet's.
export { backupSlots, colorDistance, duplicateTargets, EXTERNAL_SLOT, matchSlots, type MapFilament, type MapSlot } from '@slicerx/contracts'

export type SendOptions = StartOptions

/**
 * Filament number (1 based, as the app and the Print sheet count them) to the printer's slot id, for the
 * filaments the print uses, in the printer's own slot order. Empty without an AMS or MMU. This is the
 * sheet's map; `startSlotMap` turns it into the start options' 0 based keys.
 */
export function slotMapFor(used: Iterable<number>, printerSlots: readonly FilamentSlot[]): Record<number, string> {
  const out: Record<number, string> = {}
  for (const n of used) {
    const slot = printerSlots[n - 1]
    if (slot) out[n] = slot.id
  }
  return out
}

/**
 * The one place the app turns its 1 based filament numbers into `StartOptions.slotMap`, whose keys are 0 based
 * filament indexes (filament 1 is key 0, the G-code's T0). Numbers below 1 are not filaments and are left out.
 */
export function startSlotMap(map: Record<number, string>): Record<number, string> {
  const out: Record<number, string> = {}
  for (const [k, id] of Object.entries(map)) {
    const n = Number(k)
    if (Number.isInteger(n) && n >= 1) out[n - 1] = id
  }
  return out
}

/** The start options without a slot map, for a printer that would not follow one. */
export function withoutSlotMap(o: SendOptions): SendOptions {
  const { slotMap: _gone, ...rest } = o
  return rest
}

/** What the send step returns: the print options, whether to start after the upload, and the file's name on the printer. */
export interface SendChoice {
  /** Zero-based logical tools mapped to the U1's physical toolheads. */
  toolheadMap?: Record<number, number>
  options: SendOptions
  start: boolean
  name: string
  /** Upload now and keep the file in the queue for a start later. */
  queue?: { startAfter?: string }
  /**
   * Filament number (1 based, as the sheet shows it) to printer slot id, as the person set it. Absent when there is
   * nothing to map or the printer would not follow a map for this file.
   */
  slotMap?: Record<number, string>
  /**
   * The person chose "Send as plain G-code" after the printer refused the .gcode.3mf: the file goes as .gcode,
   * which the printer feeds as filament 1 from slot 1 and so on. Only ever set by that button.
   */
  plainGcode?: true
  /**
   * The print goes through Bambu Connect (send/bambu-connect.ts): the .gcode.3mf opens there and the person presses
   * Print in it. Set on a Bambu Lab printer with Developer Mode off, or by the sheet's button after a refusal.
   */
  bambuConnect?: true
}

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/

/** The rules Orca's send dialog applies to the name of a file sent to a printer (SendToPrinter.cpp): not empty, no space at either end, no illegal characters, not too long. Null when fine. */
export function jobNameProblem(name: string): string | null {
  if (name.length === 0) return 'The name cannot be empty.'
  if (name.startsWith(' ')) return 'The name cannot start with a space.'
  if (name.endsWith(' ')) return 'The name cannot end with a space.'
  if (ILLEGAL.test(name)) return 'The name cannot contain < > : " / \\ | ? * or control characters.'
  if (name.length > 100) return 'The name is too long.'
  return null
}

/** The name made fit for the printer by the same rules, so the sheet never has to ask for another one. */
export function safeJobName(name: string): string {
  const out = name.replace(new RegExp(ILLEGAL.source, 'g'), '-').trim().slice(0, 100).trim()
  return out || 'plate'
}

/** The name with a .gcode ending, the way the printer expects it. */
export function withGcodeEnding(name: string): string {
  return /\.(gcode|bgcode)$/i.test(name) ? name : `${name}.gcode`
}

/** The ending of the file a printer gets from the Print sheet. */
export type PrintEnding = '.gcode' | '.gcode.3mf'

/**
 * What the Print sheet sends: a .gcode.3mf when the plugin declares `project_file`, so the start
 * follows the slot choice; plain .gcode otherwise.
 */
export function printEnding(plugin: string | undefined): PrintEnding {
  return pluginHas(plugin, 'project_file') ? '.gcode.3mf' : '.gcode'
}

/** The name without any print file ending. */
export function bareName(name: string): string {
  return name.replace(/\.(gcode\.3mf|3mf|gcode|bgcode)$/i, '')
}

/** The name with this ending, replacing any print file ending it had. */
export function withEnding(name: string, ending: PrintEnding): string {
  return ending === '.gcode' ? withGcodeEnding(name.replace(/\.(gcode\.3mf|3mf)$/i, '')) : `${bareName(name)}${ending}`
}

/** A Bambu Lab H2 printer's second external spool, on its right nozzle: slot "2" (Bambu tray 255). Its status lists it only while it holds a spool. */
export const SECOND_EXTERNAL_SLOT = '2'

/**
 * The external spools a printer offers in the slot picker, by slot id and name. A Bambu Lab printer whose status lists
 * slot 2 is an H2 with a spool on each side: slot 1 is the left nozzle's, slot 2 the right's. Anywhere else slot 2 is an
 * ordinary slot (an MMU's second), and slot 1 is the one external spool.
 */
export function externalSlots(plugin: string, slots: readonly MapSlot[]): { id: string; label: string }[] {
  if (plugin === 'bambu-lan' && slots.some((s) => s.id === SECOND_EXTERNAL_SLOT)) {
    return [
      { id: EXTERNAL_SLOT, label: 'Left external spool' },
      { id: SECOND_EXTERNAL_SLOT, label: 'Right external spool' },
    ]
  }
  return [{ id: EXTERNAL_SLOT, label: 'External spool' }]
}
