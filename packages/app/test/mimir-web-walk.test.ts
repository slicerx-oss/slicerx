// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The docked mimir on a host that only models (the browser build) offers parts, not printers; the save switch's caption
// reads its state; a reload keeps the conversation and setup where they were.
import type { CommandSpec, Host, PrinterHost } from '@slicerx/contracts'
import { createApprovalBroker, DEFAULT_CONFIG } from '@slicerx/pilot'
import { emptyTranscript, reduceTranscript, startTurn } from '@slicerx/pilot/ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bundledKb } from '../src/features/pilot/kb'
import { CAD_CHIPS, chips, emptyNote } from '../src/features/pilot/dock'
import { clearDockChat, saveDockChat, savedDockChat } from '../src/features/pilot/dock-chat'
import { dockPilotOptions, modelingCommands } from '../src/features/pilot/use-pilot'
import { noteSetupOpen, setupOpenAtReload } from '../src/first-run/onboarding'
import { shareCaption } from '../src/pilot-connect/settings-section'
import { setHostSlices } from '../src/state/model-mode'

afterEach(() => {
  setHostSlices(true)
  sessionStorage.clear()
})

const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => true, stream: () => { throw new Error('scripted') } }
const host = { kind: 'web', slicer: {}, printers, capabilities: { threads: 1 } } as unknown as Host
const cmd = (id: string, section: CommandSpec['section']): CommandSpec => ({ id, title: id, section, run: () => undefined, tool: { permission: 'read' } }) as CommandSpec

describe('mimir where the host only models', () => {
  it('runs in the modeling scope, without the slicing, printer and settings commands', async () => {
    setHostSlices(false)
    const options = dockPilotOptions(host, { printers, llm: noLlm, approvals: createApprovalBroker(), config: DEFAULT_CONFIG, kb: await bundledKb() })
    expect(options.scope).toBe('cad')
    expect(options.commands?.some((c) => c.section === 'slice' || c.section === 'printers' || c.section === 'settings')).toBe(false)
    expect(modelingCommands([cmd('slice', 'slice'), cmd('pause-bay', 'printers'), cmd('brim-toggle', 'settings'), cmd('mode-slice', 'navigate'), cmd('layer-up', 'view'), cmd('mode-design', 'navigate')]).map((c) => c.id)).toEqual(['mode-design'])
  })

  it('keeps the full scope and every command where the host slices', async () => {
    const options = dockPilotOptions(host, { printers, llm: noLlm, approvals: createApprovalBroker(), config: DEFAULT_CONFIG, kb: await bundledKb() })
    expect(options.scope).toBeUndefined()
  })

  it('offers part chips and a parts note there, and the skill chips on the desktop', () => {
    const sent: string[] = []
    const cad = chips((m) => sent.push(m), false)
    expect(cad.map((c) => c.label)).toEqual(CAD_CHIPS.map((c) => c.label))
    expect(cad.map((c) => c.label).join(' ')).not.toMatch(/print|failure|layer|profile/i)
    cad[0]?.onSelect()
    expect(sent).toEqual([CAD_CHIPS[0]?.prompt])
    expect(chips(() => undefined, true).map((c) => c.label)).toContain('Check on a print')
    expect(emptyNote({ names: [], attention: false }, false)).toMatch(/Describe a part/)
    expect(emptyNote({ names: [], attention: false }, true)).toMatch(/Ask about a print/)
  })
})

describe('the save switch caption', () => {
  it('says what the switch does now, on and off', () => {
    expect(shareCaption(true)).toMatch(/^On: free mimir chats are saved for 30 days/)
    expect(shareCaption(false)).toMatch(/^Off: nothing new is saved/)
  })
})

describe('a reload keeps the conversation', () => {
  const finished = () => reduceTranscript(reduceTranscript(startTurn(emptyTranscript(), { user: 'a 20 mm cube' }, 0), { type: 'text', delta: 'Done.' }, 0), { type: 'done', stopReason: 'end', ms: 5 }, 0)

  it('keeps a finished run for the tab, not one still running, and forgets it on New conversation', () => {
    saveDockChat('s_1', startTurn(emptyTranscript(), { user: 'hi' }, 0))
    expect(savedDockChat()).toBeNull()
    saveDockChat('s_1', finished())
    expect(savedDockChat()?.sessionId).toBe('s_1')
    expect(savedDockChat()?.transcript.turns[0]?.user).toBe('a 20 mm cube')
    clearDockChat()
    expect(savedDockChat()).toBeNull()
  })

  it('drops a conversation too big to keep', () => {
    saveDockChat('s_1', finished())
    const big = reduceTranscript(finished(), { type: 'text', delta: 'x'.repeat(500_000) }, 0)
    saveDockChat('s_1', { ...big, status: 'done' })
    expect(savedDockChat()).toBeNull()
  })
})

describe('a reload in the middle of setup', () => {
  it('notes the step for the tab and forgets it when setup closes', () => {
    noteSetupOpen('printer')
    expect(setupOpenAtReload()).toBe('printer')
    noteSetupOpen(null)
    expect(setupOpenAtReload()).toBeNull()
    noteSetupOpen('nonsense')
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
