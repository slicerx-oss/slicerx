// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The required dialogs on screen. While one is open it holds the keyboard. The listener is the first on the window in
// the capture phase (added at startup by the theme provider, before any shortcut handler), so no handler sees a key: Tab,
// Enter and Space still move between and press the dialog's own buttons, since their default actions stay.
export const holding = new Set<HTMLDialogElement>()
let installed = false

/** Adds the window listeners, once. */
export function holdKeysForDialogs(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const hold = (e: KeyboardEvent) => {
    if (holding.size === 0) return
    e.stopImmediatePropagation()
    const inside = [...holding].some((d) => e.target instanceof Node && d.contains(e.target))
    // Escape would ask the browser to close the dialog, and Chromium closes it anyway on a second press.
    if (e.key === 'Escape' || !inside) e.preventDefault()
  }
  window.addEventListener('keydown', hold, true)
  window.addEventListener('keyup', hold, true)
}
