// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The two layouts below a desktop window. Compact: 900 px wide or less, where the side panes become sheets, a narrow
// desktop window included. Phone: compact on a touch screen, where the studio goes slim, view and print
// (docs/redesign/mobile-plan.md, P1); a narrow desktop window or a big tablet keeps the full layout.
import { useEffect } from 'react'
import { useMediaQuery } from './media'

export const COMPACT_QUERY = '(max-width: 900px)'
export const PHONE_QUERY = '(pointer: coarse) and (max-width: 900px)'

/** True at 900 px wide or less, on any pointer: the panes are sheets. */
export function useCompactLayout(): boolean {
  return useMediaQuery(COMPACT_QUERY)
}

/** True on a phone: a touch screen 900 px wide or less. */
export function usePhoneLayout(): boolean {
  return useMediaQuery(PHONE_QUERY)
}

/** Marks the document root with `data-phone` while the phone layout applies, so styles key off one attribute. */
export function usePhoneRoot(): void {
  const phone = usePhoneLayout()
  useEffect(() => {
    const root = document.documentElement
    if (phone) root.setAttribute('data-phone', '')
    else root.removeAttribute('data-phone')
    return () => root.removeAttribute('data-phone')
  }, [phone])
}
