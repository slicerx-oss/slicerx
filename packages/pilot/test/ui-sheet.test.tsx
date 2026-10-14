// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// A sheet in the conversation: a numbered row per size with its unit, the pages the looked-up sizes came from once in
// the header, guesses marked until confirmed, and once confirmed the values used and which the person changed.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  it('numbers each row as its callout, names the source once in the header, and marks guesses while it waits', () => {
    render(<SheetRecord sheet={SHEET} answer={null} />)
    expect(row('phone_width').textContent).toContain('71.5 mm')
    expect([...document.querySelectorAll('.sheet-rec-n')].map((n) => n.textContent)).toEqual(['1', '2', '3'])
    const source = screen.getByRole('link', { name: 'Source: apple.com' })
    expect(source.getAttribute('href')).toBe('https://www.apple.com/iphone/compare/')
    expect(screen.getAllByTestId('mimir-sheet-source')).toHaveLength(1)
    expect(row('phone_width').querySelector('a')).toBeNull()
    expect(row('lean').textContent).toContain('70 °')
    expect(row('lean').textContent).toContain('guess')
    expect(row('lean').hasAttribute('data-guess')).toBe(true)
    expect(row('stand_width').textContent).toContain('you said')
    expect(screen.getByTestId('mimir-sheet-status').textContent).toBe('1 assumed value: lean angle 70 °')
    expect(screen.getByTestId('mimir-sheet-status').hasAttribute('data-assumed')).toBe(true)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('takes typed sizes while it waits, and builds with them from its button', async () => {
    const edits: [string, number][] = []
    const built: Record<string, number>[] = []
    const { rerender } = render(<SheetRecord sheet={SHEET} answer={null} actionable onEdit={(_id, k, v) => edits.push([k, v])} onConfirm={async (_id, v) => void built.push(v)} onOpen={() => undefined} />)
    const lean = screen.getByRole('textbox', { name: 'Lean angle, degrees' })
    fireEvent.change(lean, { target: { value: '65' } })
    fireEvent.keyDown(lean, { key: 'Enter' })
    expect(edits).toEqual([['lean', 65]])
    rerender(<SheetRecord sheet={SHEET} answer={null} actionable values={{ lean: 65 }} onEdit={(_id, k, v) => edits.push([k, v])} onConfirm={async (_id, v) => void built.push(v)} onOpen={() => undefined} />)
    expect(row('lean').hasAttribute('data-guess')).toBe(false)
    expect(row('lean').textContent).toContain('yours')
    expect(screen.getByTestId('mimir-sheet-status').textContent).toBe('Waiting for you to confirm')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm sizes and build' }))
    expect(built).toEqual([{ phone_width: 71.5, lean: 65, stand_width: 70 }])
  })

  it('keeps a guess left as it is with Enter, and stops calling it assumed', () => {
    const edits: [string, number][] = []
    const { rerender } = render(<SheetRecord sheet={SHEET} answer={null} actionable onEdit={(_id, k, v) => edits.push([k, v])} onConfirm={async () => undefined} />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Lean angle, degrees' }), { key: 'Enter' })
    expect(edits).toEqual([['lean', 70]])
    rerender(<SheetRecord sheet={SHEET} answer={null} actionable values={{ lean: 70 }} onEdit={(_id, k, v) => edits.push([k, v])} onConfirm={async () => undefined} />)
    expect(row('lean').hasAttribute('data-guess')).toBe(false)
    expect(row('lean').textContent).toContain('kept')
    expect(screen.getByTestId('mimir-sheet-status').textContent).toBe('Waiting for you to confirm')
  })

  it('shows the values used once confirmed, and which the person changed', () => {
    render(<SheetRecord sheet={SHEET} answer={{ confirmed: true, values: { phone_width: 71.5, lean: 65, stand_width: 70 }, changed: ['lean'] }} />)
    expect(row('lean').textContent).toContain('65 °')
    expect(row('lean').textContent).toContain('yours')
    expect(row('lean').hasAttribute('data-guess')).toBe(false)
    expect(screen.getByTestId('mimir-sheet-record').textContent).toContain('Confirmed with 1 change')
  })

  it('says a canceled sheet built nothing, and keeps its guesses marked', () => {
    render(<SheetRecord sheet={SHEET} answer={{ confirmed: false, values: { phone_width: 71.5, lean: 70, stand_width: 70 }, changed: [] }} actionable onOpen={() => undefined} />)
    expect(screen.getByTestId('mimir-sheet-record').textContent).toContain('Canceled, nothing built')
    expect(row('lean').hasAttribute('data-guess')).toBe(true)
    expect(screen.queryByTestId('mimir-sheet-open')).toBeNull()
  })

  it('brings the panel back with Edit sizes once its rows drive the steps', () => {
    const opened: string[] = []
    const done = { confirmed: true, values: { phone_width: 71.5, lean: 70, stand_width: 70 }, changed: [] }
    const { rerender } = render(<SheetRecord sheet={SHEET} answer={done} actionable onOpen={(id) => opened.push(id)} />)
    expect(screen.queryByTestId('mimir-sheet-open')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    rerender(<SheetRecord sheet={SHEET} answer={done} bound actionable onOpen={(id) => opened.push(id)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit sizes' }))
    expect(opened).toEqual(['sheet_1'])
  })
})
