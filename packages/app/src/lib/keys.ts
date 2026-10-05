// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

/** The modifier label shown in hints: the Command sign on Apple platforms, Ctrl elsewhere. */
export function modKey(): string {
  return isMac() ? '⌘' : 'Ctrl+'
}

/** Renders a shortcut such as "Mod+Shift+K" for the current platform. */
export function formatShortcut(s: string): string {
  const mac = isMac()
  return s
    .split('+')
    .map((k) => {
      if (k === 'Mod') return mac ? '⌘' : 'Ctrl'
      if (k === 'Shift') return mac ? '⇧' : 'Shift'
      if (k === 'Alt') return mac ? '⌥' : 'Alt'
      if (k === 'Enter') return mac ? '↩' : 'Enter'
      return k
    })
    .join(mac ? '' : '+')
}

/** True when the event matches a shortcut such as "Mod+K" or "Mod+Shift+Enter". */
export function matchShortcut(e: KeyboardEvent, s: string): boolean {
  const parts = s.split('+')
  const key = parts[parts.length - 1] ?? ''
  const wantMod = parts.includes('Mod')
  const mod = isMac() ? e.metaKey : e.ctrlKey
  if (wantMod !== mod) return false
  if (parts.includes('Shift') !== e.shiftKey) return false
  if (parts.includes('Alt') !== e.altKey) return false
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key
  // Alt changes e.key on macOS, so fall back to the physical key for letters and digits. Named keys (Space) match by code.
  const code = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.code
  return k === key.toUpperCase() || k === key || code === key.toUpperCase() || e.code === key
}

/** Keystrokes inside text fields belong to the field, except the global command bar shortcut. */
export function inTextField(e: KeyboardEvent): boolean {
  return isTextField(e.target)
}

/** True for an element that takes typed text: a text input, a textarea or editable content. */
export function isTextField(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes((t as HTMLInputElement).type))
}
