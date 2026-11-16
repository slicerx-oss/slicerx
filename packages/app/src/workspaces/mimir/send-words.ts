// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every line the send card shows a person, in one place, so the card, its tests and the wording review read the same
// words.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'

/** The card's question, with the part and the printer by the names the person knows them by. */
export const SEND_TITLE = (part: string, printer: string): string => `${part} ready. Send it to ${printer}?`
/** The strip's header line, right side, before a spool is picked. */
export const CHOOSE_MATERIAL = 'Choose material'
/** The strip's header line, right side, once a spool is picked: "White PETG · Slot A4". */
export const PICKED_SPOOL = (color: string, material: string, slot: string): string => `${[color, material].filter(Boolean).join(' ')} · ${slot}`
/** A slot as the strip and the picked line name it. */
export const SLOT_LABEL = (id: string): string => `Slot ${id}`
/** The external spool, as the strip and the picked line name it. */
export const EXTERNAL_SPOOL = 'External spool'
/** The external spool's short mark on its chip, where an AMS slot shows its number. */
export const EXTERNAL_MARK = 'Ext'
/** A slot the printer reports with no spool in it. */
export const EMPTY_SLOT = 'Empty'
/** Why a loaded spool of another material can't be picked: the plate was sliced for this one. */
export const OTHER_MATERIAL = (material: string): string => `Sliced for ${material}. Ask ${ASSISTANT_NAME} to slice again for this spool.`
/** The strip's header line, right side, for a plate on two or more filaments, which feed from the slots it was sliced with. */
export const SLOTS_IN_USE = (slots: readonly string[]): string => `Slots ${slots.join(', ')}`
/** A chip's spoken name: "Slot A2: PLA Blue", "Slot A3: Empty". */
export const CHIP_NAME = (slot: string, words: string): string => `${slot}: ${words}`

/** The slide's own words while it waits. */
export const SLIDE_TO_PRINT = 'Slide to print'
/** The slide's spoken name and the click target's: "Slide to print on Bay 6". */
export const SLIDE_NAME = (printer: string): string => `Slide to print on ${printer}`
/** The click target at the slide's end, for a person who can't drag. */
export const PRINT_NOW = (printer: string): string => `Print on ${printer}`
/** The slide once the person let go at its end, until the printer took the job. */
export const SENDING = (printer: string): string => `Sending to ${printer}...`
/** The slide once the printer took the job. */
export const SENT = (printer: string): string => `Sent to ${printer}`
/** The slide when the send did not go through after the person's answer. */
export const NOT_SENT_TO = (printer: string): string => `Not sent to ${printer}`

/** The status line before the person has picked a spool or ticked the bed. */
export const PICK_AND_TICK = 'Pick a spool and tick the bed check to print.'
/** The status line once the bed is ticked, before a spool is picked. */
export const PICK_TO_PRINT = 'Pick a spool to print.'
/** The status line once a spool is picked, before the bed is ticked (unchanged from the Print card). */
export const TICK_TO_PRINT = 'Tick the bed check to print.'
/** The status line while a problem keeps the slide off. */
export const SLIDE_STAYS_OFF = 'Print stays off.'
/** A send record that does not hash to the request. */
export const FILE_UNMATCHED = 'The file for this request could not be matched, so Print stays off.'
/** The title's tooltip, with the assistant's name as the edition sets it. */
export const ONLY_YOU = (): { title: string; body: string } => ({ title: `${ASSISTANT_NAME} asks to print`, body: `Only you can start this print. ${ASSISTANT_NAME} can't pick the spool, tick the bed check or slide to print.` })
