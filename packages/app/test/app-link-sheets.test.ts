// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client's dimension sheet over the app link: asked, shown to the person, confirmed or set aside, and read back only
// by the client that asked; one waiting per client and three at most.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { LinkError, runCall } from '../src/app-link/methods'
import { AppLinkPrompt, ARM_MS } from '../src/app-link/prompt'
import { clientSheets } from '../src/app-link/sheets'

const A = { id: 'c1', name: 'Print Helper' }
const B = { id: 'c2', name: 'Other' }
const SHEET = {
  title: 'Clip sizes',
  dims: [
    { key: 'bore', label: 'Cable bore', value: 6.2, unit: 'mm', source: 'asked' },
    { key: 'wall', label: 'Wall', value: 1.6, unit: 'mm', min: 0.8, max: 4, source: 'guess' },
  ],
}

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal: () => void }
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  clientSheets.setState({ sheets: [] })
})

const code = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as LinkError).code

describe('client sheets over the app link', () => {
  it('are asked, wait for the person, and are read back only by their client', async () => {
    const asked = (await runCall('sheet.ask', SHEET, A)) as { sheetId: string; state: string }
    expect(asked.state).toBe('waiting')
    expect(await runCall('sheet.get', { sheetId: asked.sheetId }, A)).toMatchObject({ state: 'waiting' })
    expect(await code(runCall('sheet.get', { sheetId: asked.sheetId }, B))).toBe('not_found')
  })

  it('refuse a bad sheet, a second one from the same client, and a fourth waiting', async () => {
    expect(await code(runCall('sheet.ask', { title: 'x', dims: [] }, A))).toBe('invalid_input')
    expect(await code(runCall('sheet.ask', { ...SHEET, dims: [{ ...SHEET.dims[0], source: 'lookup' }] }, A))).toBe('invalid_input')
    await runCall('sheet.ask', SHEET, A)
    expect(await code(runCall('sheet.ask', SHEET, A))).toBe('busy')
    await runCall('sheet.ask', SHEET, B)
    await runCall('sheet.ask', SHEET, { id: 'c3', name: 'Third' })
    expect(await code(runCall('sheet.ask', SHEET, { id: 'c4', name: 'Fourth' }))).toBe('busy')
  })

  it('are confirmed or set aside by the person in the app, never by an agent', async () => {
    vi.useFakeTimers()
    const asked = (await runCall('sheet.ask', SHEET, A)) as { sheetId: string }
    render(createElement(AppLinkPrompt))
    expect(screen.getByTestId('app-link-sheet').textContent).toContain('which calls itself Print Helper')
    for (const id of ['app-link-sheet-confirm', 'app-link-sheet-decline']) {
      expect(screen.getByTestId(id).hasAttribute('data-agent-refuse'), id).toBe(true)
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled, id).toBe(true)
    }
    act(() => void vi.advanceTimersByTime(ARM_MS))
    fireEvent.click(screen.getByTestId('app-link-sheet-confirm'))
    await vi.waitFor(async () => expect(((await runCall('sheet.get', { sheetId: asked.sheetId }, A)) as { state: string }).state).toBe('confirmed'))
    expect(await runCall('sheet.get', { sheetId: asked.sheetId }, A)).toMatchObject({ state: 'confirmed', answer: { values: { bore: 6.2, wall: 1.6 }, changed: [] } })
    await act(async () => undefined)
    expect(screen.queryByTestId('app-link-sheet')).toBeNull()

    cleanup()
    const second = (await runCall('sheet.ask', SHEET, A)) as { sheetId: string }
    render(createElement(AppLinkPrompt))
    act(() => void vi.advanceTimersByTime(ARM_MS))
    fireEvent.click(screen.getByTestId('app-link-sheet-decline'))
    await vi.waitFor(async () => expect(((await runCall('sheet.get', { sheetId: second.sheetId }, A)) as { state: string }).state).toBe('declined'))
    expect(await runCall('sheet.get', { sheetId: second.sheetId }, A)).toMatchObject({ state: 'declined' })
  })
})
