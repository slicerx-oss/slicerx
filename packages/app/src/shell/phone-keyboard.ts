// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A phone's on-screen keyboard. Safari, and Chrome on Android, leave the page its full height when the keyboard opens
// and shrink the visual viewport instead, panning it down when the focused field would sit under the keys; a WebView
// that resizes for the keyboard gives the page less height. Either way the root says what is left in view, read from
// the viewport (and the VirtualKeyboard API where a browser has it), never from an assumed keyboard height:
// --phone-kb is how far the keys reach up over the page's bottom, --phone-vv-top and --phone-vv-h are where the visible
// part starts and how tall it is, and data-phone-kb is set while the keyboard is up. The mimir tab fits itself to them.
import { useEffect, useSyncExternalStore } from 'react'

/** How far an on-screen keyboard covers the bottom of the window, px: the layout height below the visible part. */
export function keyboardLift(innerHeight: number, vv: { height: number; offsetTop: number }): number {
  return Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop))
}

/** One reading of the window: the visual viewport, the VirtualKeyboard API's height (0 without it), the tallest the
 * window has been at its width, and whether a text field has focus. */
export interface KeyboardInput {
  innerHeight: number
  vv: { height: number; offsetTop: number; scale: number }
  keys: number
  tallest: number
  typing: boolean
}

/** What the root carries for a reading: how far the keys cover the bottom, where the visible part starts and how tall
 * it is, and whether the keyboard is up. A pinch zoom also shrinks the visual viewport, so a zoomed view is no keyboard. */
export function keyboardState(r: KeyboardInput): { covered: number; top: number; shown: number; up: boolean } {
  if (r.vv.scale > 1.01) return { covered: 0, top: 0, shown: r.innerHeight, up: false }
  const covered = Math.max(keyboardLift(r.innerHeight, r.vv), Math.round(r.keys))
  const top = Math.max(0, Math.round(r.vv.offsetTop))
  const shown = Math.max(0, r.innerHeight - top - covered)
  // a window the keyboard made shorter rather than covered: shorter than it has been at this width, while typing
  const shrunk = r.typing && r.innerHeight < r.tallest
  return { covered, top, shown, up: covered > 0 || shrunk }
}

/** Fields that take typing, so focusing one opens the keyboard. */
const TEXT = 'textarea, [contenteditable=""], [contenteditable="true"], input:not([type]), input:is([type="text"], [type="search"], [type="email"], [type="number"], [type="password"], [type="tel"], [type="url"])'

type VirtualKeyboard = EventTarget & { boundingRect: DOMRectReadOnly }

// whether the keyboard is up, for components that change with it (the mimir drawing folds while a size is typed in)
let keyboardUp = false
const listeners = new Set<() => void>()
function setKeyboardUp(up: boolean): void {
  if (up === keyboardUp) return
  keyboardUp = up
  for (const l of listeners) l()
}

/** True while a phone's on-screen keyboard is up (html[data-phone-kb]). */
export function usePhoneKeyboardUp(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => keyboardUp,
    () => false,
  )
}

/** Keeps the root's keyboard properties current while the phone layout applies. */
export function usePhoneKeyboard(phone: boolean): void {
  useEffect(() => {
    const vv = typeof window === 'undefined' ? undefined : window.visualViewport
    if (!phone || !vv) return
    const root = document.documentElement
    const vk = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboard }).virtualKeyboard
    let width = window.innerWidth
    let tallest = window.innerHeight
    const read = () => {
      // turned, or another width: the tallest starts again
      if (window.innerWidth !== width) [width, tallest] = [window.innerWidth, window.innerHeight]
      tallest = Math.max(tallest, window.innerHeight)
      const s = keyboardState({
        innerHeight: window.innerHeight,
        vv: { height: vv.height, offsetTop: vv.offsetTop, scale: vv.scale },
        keys: vk?.boundingRect.height ?? 0,
        tallest,
        typing: document.activeElement?.matches(TEXT) ?? false,
      })
      root.style.setProperty('--phone-kb', `${s.covered}px`)
      root.style.setProperty('--phone-vv-top', `${s.top}px`)
      root.style.setProperty('--phone-vv-h', `${s.shown}px`)
      root.toggleAttribute('data-phone-kb', s.up)
      setKeyboardUp(s.up)
    }
    // focus moving from one field to the next passes through the page: read once it has landed
    let frame = 0
    const later = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(read)
    }
    read()
    vv.addEventListener('resize', read)
    vv.addEventListener('scroll', read)
    window.addEventListener('resize', read)
    vk?.addEventListener('geometrychange', read)
    document.addEventListener('focusin', later)
    document.addEventListener('focusout', later)
    return () => {
      cancelAnimationFrame(frame)
      vv.removeEventListener('resize', read)
      vv.removeEventListener('scroll', read)
      window.removeEventListener('resize', read)
      vk?.removeEventListener('geometrychange', read)
      document.removeEventListener('focusin', later)
      document.removeEventListener('focusout', later)
      for (const p of ['--phone-kb', '--phone-vv-top', '--phone-vv-h']) root.style.removeProperty(p)
      root.removeAttribute('data-phone-kb')
      setKeyboardUp(false)
    }
  }, [phone])
}
