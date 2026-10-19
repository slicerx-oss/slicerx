// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir in the tab on a host that only models (the browser build) offers parts, not printers; the save switch's caption
// reads its state; a reload keeps setup where it was.
import type { CommandSpec, Host, PrinterHost } from '@slicerx/contracts'
import { createApprovalBroker, DEFAULT_CONFIG } from '@slicerx/pilot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bundledKb } from '../src/workspaces/mimir/kb'
import { emptyNote } from '../src/workspaces/mimir/mimir-panes'
import { modelingCommands, tabPilotOptions } from '../src/workspaces/mimir/session'
import { noteSetupOpen, setupOpenAtReload } from '../src/first-run/onboarding'
import { shareCaption } from '../src/pilot-connect/settings-section'
import { setHostSlices } from '../src/state/model-mode'

afterEach(() => {
  setHostSlices(true)
  sessionStorage.clear()
})

const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => true, stream: () => { throw new Error('scripted') } }
const host = { kind: 'web', slicer: {}, printers, approvals: createApprovalBroker(), capabilities: { threads: 1 } } as unknown as Host
const cmd = (id: string, section: CommandSpec['section']): CommandSpec => ({ id, title: id, section, run: () => undefined, tool: { permission: 'read' } }) as CommandSpec
const COMMANDS = [cmd('slice', 'slice'), cmd('pause-bay', 'printers'), cmd('brim-toggle', 'settings'), cmd('mode-slice', 'navigate'), cmd('layer-up', 'view'), cmd('mode-design', 'navigate'), cmd('project-new', 'plate')]

describe('mimir where the host only models', () => {
  it('runs in the modeling scope, without the slicing, printer and settings commands', async () => {
    setHostSlices(false)
    const options = tabPilotOptions(host, { llm: noLlm, config: DEFAULT_CONFIG, kb: await bundledKb(), tools: [], commands: COMMANDS })
    expect(options.scope).toBe('cad')
    expect(options.commands?.some((c) => c.section === 'slice' || c.section === 'printers' || c.section === 'settings')).toBe(false)
    expect(modelingCommands(COMMANDS).map((c) => c.id)).toEqual(['mode-design', 'project-new'])
  })

  it('keeps the full scope and every command where the host slices', async () => {
    const options = tabPilotOptions(host, { llm: noLlm, config: DEFAULT_CONFIG, kb: await bundledKb(), tools: [], commands: COMMANDS })
    expect(options.scope).toBeUndefined()
    expect(options.commands?.map((c) => c.id)).toEqual(COMMANDS.map((c) => c.id))
  })

  it('says parts there, and parts with slicing and printers on the desktop', () => {
    expect(emptyNote(false)).toMatch(/^Describe a part/)
    expect(emptyNote(false)).not.toMatch(/slice|printer/i)
    expect(emptyNote(true)).toMatch(/slice, tune settings or check a printer/)
  })
})

describe('the save switch caption', () => {
  it('says what the switch does now, on and off', () => {
    expect(shareCaption(true)).toMatch(/^On: free mimir chats are saved for 30 days/)
    expect(shareCaption(false)).toMatch(/^Off: nothing new is saved/)
  })
})

describe('a reload in the middle of setup', () => {
  it('notes the step for the tab and forgets it when setup closes', () => {
    noteSetupOpen('welcome', true)
    noteSetupOpen('printer')
    expect(setupOpenAtReload()).toBe('printer')
    noteSetupOpen(null)
    expect(setupOpenAtReload()).toBeNull()
    noteSetupOpen('nonsense')
    expect(setupOpenAtReload()).toBeNull()
  })

  it('keeps no printer setup opened from the printer picker', () => {
    noteSetupOpen(null)
    noteSetupOpen('printer')
    expect(setupOpenAtReload()).toBeNull()
  })

  it('opens setup again on that step', async () => {
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare' }))
    sessionStorage.setItem('sx-setup-open', 'look')
    vi.resetModules()
    const { get } = await import('../src/state/store')
    expect(get().setup).toEqual({ step: 'look' })
    localStorage.removeItem('slicerx.prefs.v1')
  })
})
