// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where the open sketch shows its drawing tools on a phone: the Model bar along the bottom of the view gives the sketch
// panel a place (`el`), and the panel puts its tool picker there instead of at the top of its sheet, so the tools stay
// under the thumb while the sheet is low or shut. Off a phone nothing registers and the picker stays in the panel.
import { createStore, useStore } from 'zustand'

export const phoneSketchSlot = createStore<{ el: HTMLElement | null; used: boolean }>()(() => ({ el: null, used: false }))

/** The bar's place for the picker, or null off a phone. */
export function usePhoneSketchSlot(): HTMLElement | null {
  return useStore(phoneSketchSlot, (s) => s.el)
}

/** Whether a sketch has its picker in the bar now, so the bar shows it in place of the Model slots. */
export function usePhoneSketchUsed(): boolean {
  return useStore(phoneSketchSlot, (s) => s.used && s.el !== null)
}

/** Called by the bar with its element, and with null when it goes. */
export function setPhoneSketchSlot(el: HTMLElement | null): void {
  phoneSketchSlot.setState({ el })
}

/** Called by the sketch panel while its picker is in the bar; returns the release. */
export function claimPhoneSketchSlot(): () => void {
  phoneSketchSlot.setState({ used: true })
  return () => phoneSketchSlot.setState({ used: false })
}
