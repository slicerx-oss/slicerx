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
  it('shows a count given in mm with no unit and an angle in degrees, waiting and confirmed', () => {
    const gear: PilotSheet = {
      id: 'sheet_gear',
      title: 'Gear sizes',
      views: ['iso'],
      dims: [
        { key: 'teeth', label: 'Teeth', value: 20, unit: 'mm', source: 'asked' },
        { key: 'draft_angle', label: 'Draft', value: 2, unit: 'mm', source: 'asked' },
        { key: 'width', label: 'Width', value: 40, unit: 'mm', source: 'asked' },
      ],
    }
    render(<SheetRecord sheet={gear} answer={{ confirmed: true, values: { teeth: 20, draft_angle: 2, width: 40 }, changed: [] }} />)
    expect(['teeth', 'draft_angle', 'width'].map((k) => row(k).querySelector('.sheet-rec-v')!.textContent)).toEqual(['20', '2°', '40 mm'])
    cleanup()
    render(<SheetRecord sheet={gear} answer={null} onEdit={() => undefined} />)
    expect(screen.getByRole('textbox', { name: 'Teeth' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Draft, degrees' })).toBeTruthy()
    expect([...document.querySelectorAll('.sheet-rec-unit')].map((u) => u.textContent)).toEqual(['°', 'mm'])
  })

  it('shows a fractional count that came on the sheet with its own decimals, live and confirmed', () => {
    const coil: PilotSheet = { id: 'sheet_coil', title: 'Spring sizes', views: ['iso'], dims: [{ key: 'segments', label: 'Segments', value: 7.5, unit: 'mm', source: 'asked' }] }
    render(<SheetRecord sheet={coil} answer={null} onEdit={() => undefined} />)
    expect((screen.getByRole('textbox', { name: 'Segments' }) as HTMLInputElement).value).toBe('7.5')
    cleanup()
    render(<SheetRecord sheet={coil} answer={{ confirmed: true, values: { segments: 7.5 }, changed: [] }} />)
    expect(row('segments').querySelector('.sheet-rec-v')!.textContent).toBe('7.5')
  })

  it('keeps a typed count inside the row\'s own bounds, so a row that allows none keeps 0', () => {
    const box: PilotSheet = { id: 'sheet_box', title: 'Box sizes', views: ['iso'], dims: [{ key: 'magnets', label: 'Magnets', value: 2, unit: 'mm', min: 0, max: 8, source: 'asked' }] }
    const edits: [string, number][] = []
    render(<SheetRecord sheet={box} answer={null} actionable onEdit={(_id, k, v) => edits.push([k, v])} />)
    const magnets = screen.getByRole('textbox', { name: 'Magnets' })
    fireEvent.change(magnets, { target: { value: '0.3' } })
    fireEvent.keyDown(magnets, { key: 'Enter' })
    expect(edits).toEqual([['magnets', 0]])
  })

  it('rounds a fraction typed into a count row to a whole number of at least one', () => {
    const gear: PilotSheet = { id: 'sheet_gear', title: 'Gear sizes', views: ['iso'], dims: [{ key: 'teeth', label: 'Teeth', value: 18, unit: 'mm', source: 'asked' }, { key: 'width', label: 'Width', value: 40, unit: 'mm', source: 'asked' }] }
    const edits: [string, number][] = []
    render(<SheetRecord sheet={gear} answer={null} actionable onEdit={(_id, k, v) => edits.push([k, v])} />)
    for (const typed of ['20.4', '0.3']) {
      const teeth = screen.getByRole('textbox', { name: 'Teeth' })
      fireEvent.change(teeth, { target: { value: typed } })
      fireEvent.keyDown(teeth, { key: 'Enter' })
    }
    const width = screen.getByRole('textbox', { name: 'Width, millimeters' })
    fireEvent.change(width, { target: { value: '40.4' } })
    fireEvent.keyDown(width, { key: 'Enter' })
    expect(edits).toEqual([['teeth', 20], ['teeth', 1], ['width', 40.4]])
  })

  it('numbers each row as its callout, names the source once in the header, and marks guesses while it waits', () => {
    render(<SheetRecord sheet={SHEET} answer={null} />)
    expect(row('phone_width').textContent).toContain('71.5 mm')
    expect([...document.querySelectorAll('.sheet-rec-n')].map((n) => n.textContent)).toEqual(['1', '2', '3'])
    const source = screen.getByRole('link', { name: 'Source: apple.com' })
    expect(source.getAttribute('href')).toBe('https://www.apple.com/iphone/compare/')
    expect(screen.getAllByTestId('mimir-sheet-source')).toHaveLength(1)
    expect(row('phone_width').querySelector('a')).toBeNull()
    expect(row('lean').textContent).toContain('70°')
    expect(row('lean').textContent).toContain('guess')
    expect(row('lean').hasAttribute('data-guess')).toBe(true)
    expect(row('stand_width').textContent).toContain('you said')
    expect(screen.getByTestId('mimir-sheet-status').textContent).toBe('1 assumed value: lean angle 70°')
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
    const lean = screen.getByRole('textbox', { name: 'Lean angle, degrees' })
    // empty, partial or not a number: refused, so the guess stays assumed
    for (const typed of ['', ' ', '-', '.', '7o', 'abc']) {
      fireEvent.change(lean, { target: { value: typed } })
      fireEvent.keyDown(lean, { key: 'Enter' })
      fireEvent.blur(lean)
    }
    expect(edits).toEqual([])
    expect(row('lean').hasAttribute('data-guess')).toBe(true)
    fireEvent.change(lean, { target: { value: '70' } })
    fireEvent.keyDown(lean, { key: 'Enter' })
    expect(edits).toEqual([['lean', 70]])
    rerender(<SheetRecord sheet={SHEET} answer={null} actionable values={{ lean: 70 }} onEdit={(_id, k, v) => edits.push([k, v])} onConfirm={async () => undefined} />)
    expect(row('lean').hasAttribute('data-guess')).toBe(false)
    expect(row('lean').textContent).toContain('kept')
    expect(screen.getByTestId('mimir-sheet-status').textContent).toBe('Waiting for you to confirm')
  })

  it('cancels from a quiet Cancel beside the primary, and stops taking either button', async () => {
    const canceled: string[] = []
    render(<SheetRecord sheet={SHEET} answer={null} actionable onEdit={() => undefined} onConfirm={async () => undefined} onCancel={async (id) => void canceled.push(id)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(canceled).toEqual([SHEET.id])
    expect((screen.getByTestId('mimir-sheet-confirm') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the values used once confirmed, and which the person changed', () => {
    render(<SheetRecord sheet={SHEET} answer={{ confirmed: true, values: { phone_width: 71.5, lean: 65, stand_width: 70 }, changed: ['lean'] }} />)
    expect(row('lean').textContent).toContain('65°')
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

  it('says a sheet set aside for a message built nothing, and how many typed sizes went with it', () => {
    const values = { phone_width: 71.5, lean: 70, stand_width: 70 }
    const { rerender } = render(<SheetRecord sheet={SHEET} answer={{ confirmed: false, values, changed: [], said: 'x' }} />)
    expect(screen.getByText('Set aside for your message, nothing built')).toBeTruthy()
    rerender(<SheetRecord sheet={SHEET} answer={{ confirmed: false, values, changed: ['lean'], said: 'x' }} />)
    expect(screen.getByText('Set aside for your message with 1 size changed, nothing built')).toBeTruthy()
    rerender(<SheetRecord sheet={SHEET} answer={{ confirmed: false, values, changed: ['lean', 'stand_width'], said: 'x' }} />)
    expect(screen.getByText('Set aside for your message with 2 sizes changed, nothing built')).toBeTruthy()
  })

  it('drops the guess tag once the sheet is confirmed as shown', () => {
    render(<SheetRecord sheet={SHEET} answer={{ confirmed: true, values: { phone_width: 71.5, lean: 70, stand_width: 70 }, changed: [] }} />)
    expect(row('lean').textContent).not.toContain('guess')
    expect(row('lean').textContent).toContain('kept')
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
