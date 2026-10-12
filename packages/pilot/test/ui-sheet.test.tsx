// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// A sheet in the conversation: every size with its unit and where it came from, guesses marked until confirmed, a
// looked-up size linked to its page, and once confirmed the values used and which the person changed.
import { cleanup, render, screen } from '@testing-library/react'
import type { PilotSheet } from '@slicerx/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { SheetRecord } from '../ui/index'

afterEach(cleanup)

const SHEET: PilotSheet = {
  id: 'sheet_1',
  title: 'Phone stand sizes',
  views: ['iso'],
  dims: [
    { key: 'phone_width', label: 'Phone width', value: 71.5, unit: 'mm', source: 'lookup', sourceTitle: 'apple.com', sourceUrl: 'https://www.apple.com/iphone/compare/' },
    { key: 'lean', label: 'Lean angle', value: 70, unit: 'deg', source: 'guess' },
    { key: 'stand_width', label: 'Stand width', value: 70, unit: 'mm', source: 'asked' },
  ],
}

const row = (key: string) => document.querySelector(`[data-dim="${key}"]`)!

describe('the sheet record', () => {
  it('shows each size, its unit and source, with guesses marked while it waits', () => {
    render(<SheetRecord sheet={SHEET} answer={null} />)
    expect(row('phone_width').textContent).toContain('71.5 mm')
    expect(screen.getByRole('link', { name: 'apple.com' }).getAttribute('href')).toBe('https://www.apple.com/iphone/compare/')
    expect(row('lean').textContent).toContain('70 °')
    expect(row('lean').hasAttribute('data-guess')).toBe(true)
    expect(row('stand_width').textContent).toContain('you said')
    expect(screen.getByTestId('mimir-sheet-record').textContent).toContain('Waiting for you to confirm')
  })

  it('shows the values used once confirmed, and which the person changed', () => {
    render(<SheetRecord sheet={SHEET} answer={{ confirmed: true, values: { phone_width: 71.5, lean: 65, stand_width: 70 }, changed: ['lean'] }} />)
    expect(row('lean').textContent).toContain('65 °')
    expect(row('lean').textContent).toContain('you changed it')
    expect(row('lean').hasAttribute('data-guess')).toBe(false)
    expect(screen.getByTestId('mimir-sheet-record').textContent).toContain('Confirmed with 1 change')
  })
})
