// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opens Settings at Account with the Usage section in view, for "See usage" on a limit refusal in the chat. Kept apart
// from usage.tsx so the chat doesn't load the section to link to it.
import { openSettings } from '../state/store'

// when "See usage" was pressed; a section that draws long after (it was hidden then) doesn't jump
let pressed = 0

export function openUsage(): void {
  pressed = Date.now()
  openSettings('account')
}

/** True once, shortly after openUsage, for the section to bring itself into view. */
export function takeUsageFocus(): boolean {
  const fresh = Date.now() - pressed < 5000
  pressed = 0
  return fresh
}
