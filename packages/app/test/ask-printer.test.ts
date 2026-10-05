// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { shouldAskForPrinter } from '../src/first-run/ask-printer'
import { normalizePrefs } from '../src/state/prefs'

const none = { kind: 'desktop', printers: 0, bridgeSettled: true, setupOpen: false, agreementOpen: false, noPrinter: false, offered: false }

describe('opening printer setup at launch', () => {
  it('opens it on the desktop when there are no printers', () => {
    expect(shouldAskForPrinter(none)).toBe(true)
  })

  it('waits for the printers and the bridge, the agreement and any setup already showing', () => {
    expect(shouldAskForPrinter({ ...none, printers: null })).toBe(false)
    expect(shouldAskForPrinter({ ...none, bridgeSettled: false })).toBe(false)
    expect(shouldAskForPrinter({ ...none, agreementOpen: true })).toBe(false)
    expect(shouldAskForPrinter({ ...none, setupOpen: true })).toBe(false)
  })

  it('asks once a launch, never with a printer, and not after Slice without a printer', () => {
    expect(shouldAskForPrinter({ ...none, offered: true })).toBe(false)
    expect(shouldAskForPrinter({ ...none, printers: 1 })).toBe(false)
    expect(shouldAskForPrinter({ ...none, noPrinter: true })).toBe(false)
    expect(shouldAskForPrinter({ ...none, kind: 'web' })).toBe(false)
  })

  it('remembers Slice without a printer', () => {
    expect(normalizePrefs({ noPrinter: true }).noPrinter).toBe(true)
    expect(normalizePrefs({}).noPrinter).toBe(false)
  })
})
