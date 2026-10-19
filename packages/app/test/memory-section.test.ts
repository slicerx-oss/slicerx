// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What mimir remembers, as the person sees it: the chip that asks before a note is saved (in place of the approval
// card), and Settings > Memory, which lists the notes by kind, edits and deletes one, clears them all after asking, and
// exports every one. All of it goes through the app's one handle on the edition's notes.
import { DEFAULT_POLICY, type Host, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG, type MemoryFact, type ScriptStep } from '@slicerx/pilot'
import { foldEvents, TranscriptView } from '@slicerx/pilot/ui'
import { ToastProvider } from '@slicerx/ui'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditionContext, NEUTRAL } from '../src/edition'
import { MEMORY_CARDS } from '../src/features/pilot/remember-chip'
import { HostContext } from '../src/host'
import { MemorySection } from '../src/pilot-connect/memory-section'
import { memoryFor, pilotMemory } from '../src/pilot-connect/memory-store'
import { set } from '../src/state/store'

const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => false, stream: () => { throw new Error('scripted') } }

const saved: { name: string; text: string }[] = []
const HOST = {
  kind: 'web',
  capabilities: { secureStorage: false },
  files: { save: async (name: string, data: Blob) => (saved.push({ name, text: await data.text() }), { name }) },
} as unknown as Host
const mount = (el: ReactElement) => render(createElement(HostContext.Provider, { value: HOST }, createElement(EditionContext.Provider, { value: NEUTRAL }, createElement(ToastProvider, null, el))))

const store = memoryFor(NEUTRAL.id)
const fact = (id: string, kind: MemoryFact['kind'], text: string, updatedAt: number): MemoryFact => ({ id, kind, text, updatedAt })
const SEED = [
  fact('a1', 'printer', 'Has a Bambu Lab A1 with the 0.4 mm nozzle', 40),
  fact('pla', 'filament', 'Mostly prints Polymaker PLA', 30),
  fact('shelf', 'size', 'The desk shelf is 300 mm deep', 20),
  fact('petg', 'outcome', 'PETG on the A1 worked at 240 C with the fan at 30 percent', 10),
]

beforeEach(async () => {
  saved.length = 0
  set({ mimirRememberWithoutAsking: false })
  await store.clear()
})
afterEach(() => cleanup())

/** A run of mimir on the app's handle up to its first card, with the rest to drain once it is answered. */
async function untilCard(steps: ScriptStep[], ask: string) {
  const pilot = createPilot({ host: { printers, llm: noLlm, approvals: createApprovalBroker() }, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), memory: pilotMemory(NEUTRAL, store) })
  const run = pilot.run('s', ask)[Symbol.asyncIterator]()
  const events: PilotEvent[] = []
  for (let n = await run.next(); !n.done; n = await run.next()) {
    events.push(n.value)
    if (n.value.type === 'approval_request') break
  }
  const view = mount(
    createElement(TranscriptView, {
      transcript: foldEvents(events),
      showThinking: false,
      approvals: {
        cards: MEMORY_CARDS,
        onApprove: (r) => pilot.resolveApproval(r.id, { kind: 'approve' }),
        onCancel: (r) => pilot.resolveApproval(r.id, { kind: 'deny', reason: 'canceled' }),
      },
    }),
  )
  const drain = async () => {
    for (let n = await run.next(); !n.done; n = await run.next()) events.push(n.value)
  }
  return { view, events, drain }
}

const A1: ScriptStep[] = [{ calls: [{ name: 'memory.remember', args: { kind: 'printer', text: 'Has a Bambu Lab A1', data: { model: 'A1' } } }] }, { text: 'Saved.' }]

describe('the chip', () => {
  it('the chip saves on Remember and drops on Not now', async () => {
    const yes = await untilCard(A1, 'Remember that I have an A1')
    const chip = screen.getByRole('group', { name: 'Remember this?' })
    // the chip stands in for the approval card, and shows the note in the person's words
    expect(screen.queryByText(/needs your approval/)).toBeNull()
    expect(chip.textContent).toContain('Has a Bambu Lab A1')
    // its values in plain words, never the keys mimir sent
    expect(chip.textContent).toContain('Model: A1')
    expect(chip.textContent).not.toMatch(/\bmodel:|printers?\b|profiles?\b/)
    expect(await store.list()).toEqual([])
    fireEvent.click(within(chip).getByRole('button', { name: 'Remember' }))
    await yes.drain()
    expect(await store.list()).toMatchObject([{ kind: 'printer', text: 'Has a Bambu Lab A1' }])
    yes.view.unmount()

    await store.clear()
    const no = await untilCard(A1, 'Remember that I have an A1')
    fireEvent.click(within(screen.getByRole('group', { name: 'Remember this?' })).getByRole('button', { name: 'Not now' }))
    await no.drain()
    expect(await store.list()).toEqual([])
    expect(no.events).toContainEqual(expect.objectContaining({ type: 'approval_resolved', decision: expect.objectContaining({ kind: 'deny' }) }))
  })

  it('Save notes without asking saves with no chip', async () => {
    set({ mimirRememberWithoutAsking: true })
    const run = await untilCard(A1, 'Remember that I have an A1')
    await run.drain()
    expect(run.events.some((e) => e.type === 'approval_request')).toBe(false)
    expect(await store.list()).toMatchObject([{ text: 'Has a Bambu Lab A1' }])
  })
})

describe('Settings > Memory', () => {
  beforeEach(async () => {
    for (const f of SEED) await store.put(f)
  })

  it('Settings lists facts and deletes one', async () => {
    mount(createElement(MemorySection))
    await screen.findByText('Mostly prints Polymaker PLA')
    // grouped by kind in plain words, in a fixed order, and only the kinds with notes
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['Printers', 'Filaments', 'What worked', 'Sizes'])
    expect(screen.getByRole('list', { name: 'Printers' }).textContent).toContain('Has a Bambu Lab A1 with the 0.4 mm nozzle')
    expect(document.body.textContent).not.toMatch(/\b(printer|filament|outcome|size|preference)\b/)

    fireEvent.click(screen.getByRole('button', { name: 'Delete "Mostly prints Polymaker PLA"' }))
    await waitFor(() => expect(screen.queryByText('Mostly prints Polymaker PLA')).toBeNull())
    expect((await store.list()).map((f) => f.id).sort()).toEqual(['a1', 'petg', 'shelf'])
    // a kind with no notes left drops its heading
    expect(screen.queryByRole('heading', { name: 'Filaments' })).toBeNull()

    // edit changes the words in place; Cancel keeps them
    fireEvent.click(screen.getByRole('button', { name: 'Edit "The desk shelf is 300 mm deep"' }))
    const box = screen.getByRole('textbox', { name: 'Note' })
    fireEvent.change(box, { target: { value: 'The desk shelf is 320 mm deep' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('The desk shelf is 320 mm deep')
    expect((await store.list()).find((f) => f.id === 'shelf')).toMatchObject({ kind: 'size', text: 'The desk shelf is 320 mm deep' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit "The desk shelf is 320 mm deep"' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'gone' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('The desk shelf is 320 mm deep')).toBeTruthy()

    // a note mimir saves in the meantime shows at once
    await act(() => store.put(fact('ams', 'preference', 'Likes 0.2 mm layers for most prints', 50)))
    await screen.findByText('Likes 0.2 mm layers for most prints')
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['Printers', 'Preferences', 'What worked', 'Sizes'])
  })

  it('Clear all asks first', async () => {
    mount(createElement(MemorySection))
    await screen.findByText('Mostly prints Polymaker PLA')
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    const ask = screen.getByRole('dialog', { name: 'Clear all notes' })
    expect(ask.textContent).toContain("Clear all 4 notes? This can't be undone.")
    expect(await store.list()).toHaveLength(4)
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Clear all notes' })).toBeNull()
    expect(await store.list()).toHaveLength(4)

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Clear all notes' })).getByRole('button', { name: 'Clear all' }))
    await screen.findByText(/No notes yet/)
    expect(await store.list()).toEqual([])
    expect(screen.queryByRole('dialog', { name: 'Clear all notes' })).toBeNull()
  })

  it('export downloads every fact', async () => {
    mount(createElement(MemorySection))
    await screen.findByText('Mostly prints Polymaker PLA')
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0]!.name).toMatch(/\.json$/)
    const out = JSON.parse(saved[0]!.text) as { version: number; facts: MemoryFact[] }
    expect(out.version).toBe(1)
    expect(out.facts.map((f) => f.id).sort()).toEqual(['a1', 'petg', 'pla', 'shelf'])
    expect(out.facts.find((f) => f.id === 'a1')).toEqual(SEED[0])
  })
})
