// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectPanel } from '../src/pilot-connect/connect-panel'
import { registerLocalAi, type LocalNet } from '../src/pilot-connect/local-ai'
import { HostContext } from '../src/host'
import { set } from '../src/state/store'

const host = { kind: 'web', capabilities: { secureStorage: false } } as never

function mount(running: boolean) {
  const net: LocalNet = {
    get: async (url) => (running && url.endsWith('/api/tags') ? JSON.stringify({ models: [{ name: 'llama3' }] }) : null),
    post: () => (async function* () {})(),
  }
  registerLocalAi(() => ({ hardware: async () => ({ gpu: null, ramMb: 16384, cores: 8, source: 'browser' }), net }))
  set({ pilot: { mode: 'on', provider: 'local' } })
  render(createElement(HostContext.Provider, { value: host }, createElement(ConnectPanel)))
}

afterEach(() => {
  cleanup()
  registerLocalAi(null)
  set({ pilot: null })
})

const button = () => screen.getByRole('button', { name: /Use a model server on another computer/ })

describe('manual local model server', () => {
  it('shows the address fields by default when no server is detected', async () => {
    mount(false)
    await act(async () => {})
    expect(button().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText('Server address')).toBeTruthy()
  })

  it('stays collapsed when a local server is running, and the button toggles the fields', async () => {
    mount(true)
    await act(async () => {})
    expect(button().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText('Server address')).toBeNull()
    fireEvent.click(button())
    expect(button().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText('Server address')).toBeTruthy()
    fireEvent.click(button())
    expect(button().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText('Server address')).toBeNull()
  })

  it('does not reopen after the person collapses it', async () => {
    mount(false)
    await act(async () => {})
    fireEvent.click(button())
    expect(button().getAttribute('aria-expanded')).toBe('false')
  })
})
