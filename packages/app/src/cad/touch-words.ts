// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A tool hint in a finger's words on a phone: tap for click, press and hold for a right click. Keys a phone has no
// way to press (Shift, Alt, Esc, Delete) stay out of the touch words; the hint drops a sentence that needs one.
const KEYS = /\b(Shift|Alt|Ctrl|Cmd|Esc|Escape|Delete|Enter|Tab)\b/

export function touchWords(text: string): string {
  const swapped = text
    .replace(/\bRight click\b/g, 'Press and hold')
    .replace(/\bright click\b/g, 'press and hold')
    .replace(/\bDouble-click\b/g, 'Double-tap')
    .replace(/\bdouble-click\b/g, 'double-tap')
    .replace(/\bClick\b/g, 'Tap')
    .replace(/\bclick\b/g, 'tap')
    .replace(/\bClicks\b/g, 'Taps')
    .replace(/\bclicks\b/g, 'taps')
    // a typed size needs a keyboard at the pointer, which a phone does not have there
    .replace(/\s*Type a number to give exact sizes\./g, '')
  // sentences that ask for a key the phone has no key for
  const sentences = swapped.match(/[^.!?]+[.!?]*\s*/g) ?? [swapped]
  return sentences.filter((s) => !KEYS.test(s)).join('').trim()
}
