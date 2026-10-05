// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '@slicerx/contracts'
import { BED_CLEAR, describeCard, printerLabels, watchHubCards, type HubCard, type HubCards } from '../src/link/agent-cards'
import { get, set } from '../src/state/store'

const card = (over: Partial<HubCard> = {}): HubCard => ({
  id: 'req-1',
  sessionId: 's',
  tool: 'printer_start',
  permission: 'print',
  title: 'Pause the print on Bay 1?',
  lines: ['Nothing will move.', 'Safe to approve.'],
  origin: 'mcp',
  paramsHash: 'h',
  actions: [
    { action: 'printer.upload', target: 'bay-4', paramsHash: 'a' },
    { action: 'printer.start', target: 'bay-4', paramsHash: 'b' },
  ],
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  ...over,
} as HubCard)

const names = (id: string) => (id === 'bay-4' ? 'Bay 4' : id)

describe('agent cards', () => {
  beforeEach(() => set({ approval: null }))

  it('takes the action from the hub-checked work, never from the title the agent wrote', () => {
    const t = describeCard(card(), names)
    expect(t.title).toBe('Start a print on Bay 4?')
    expect(t.startsPrint).toBe(true)
    expect(t.lines[1]).toBe('If you approve, the hub will upload a file, then start a print on Bay 4.')
    // The agent's words appear once, as a labeled note, and its lines not at all.
    const note = t.lines.filter((l) => l.includes('Pause the print'))
    expect(note).toEqual(['Note from the agent, not checked by SlicerX: "Pause the print on Bay 1?"'])
    expect(t.lines.join(' ')).not.toContain('Safe to approve')
  })

  it('shows the file, hash and options the hub sent, and ignores work for another printer', () => {
    const work = { kind: 'print' as const, printerId: 'bay-4', file: { name: 'bracket.gcode', sizeBytes: 2_500_000, sha256: 'ab'.repeat(32) }, opts: { timelapse: true } }
    const t = describeCard(card({ work }), names)
    expect(t.lines).toContain('File (named by the agent): bracket.gcode, 2.4 MB')
    expect(t.lines).toContain(`SHA-256: ${'ab'.repeat(8)}`)
    expect(t.lines).toContain('Options: timelapse true')
    expect(t.blocked).toBeUndefined()
    // Work for another printer is not shown, and the card cannot be approved.
    const elsewhere = describeCard(card({ work: { ...work, printerId: 'bay-9' } }), names)
    expect(elsewhere.lines.join(' ')).not.toContain('bracket.gcode')
    expect(elsewhere.blocked).toMatch(/Deny/)
  })

  it('gives no Approve to a card without the hub\'s work, or with work that differs from its actions', () => {
    expect(describeCard(card(), names).blocked).toMatch(/Deny/)
    const resume = { kind: 'resume' as const, printerId: 'bay-4' }
    // The actions say start, the work says resume.
    expect(describeCard(card({ work: resume }), names).blocked).toMatch(/Deny/)
    const resumeCard = card({ actions: [{ action: 'printer.resume', target: 'bay-4', paramsHash: 'r' }], work: resume })
    expect(describeCard(resumeCard, names).blocked).toBeUndefined()
    // A phone's pause card carries its work too.
    const pause = card({ origin: 'phone', actions: [{ action: 'printer.pause', target: 'bay-4', paramsHash: 'p' }], work: { kind: 'pause', printerId: 'bay-4' } } as Partial<HubCard>)
    expect(describeCard(pause, names).blocked).toBeUndefined()
    const { work: _dropped, ...bare } = pause
    expect(describeCard(bare, names).blocked).toMatch(/Deny/)
  })

  it('shows agent text so it cannot reorder or hide the facts, and lists every slot', () => {
    // A right-to-left override and a zero-width space in the file name, an override in the note.
    const work = { kind: 'print' as const, printerId: 'bay-4', file: { name: 'pause‮edoc.gcode​' }, opts: { slotMap: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i, `${'ABCD'[i % 4]}${(i % 4) + 1}`])) } }
    const t = describeCard(card({ title: 'Safe‮ evorppa', work }), names)
    const text = t.lines.join('\n')
    expect(text).not.toMatch(/[‪-‮⁦-⁩​-‏]/)
    expect(t.lines).toContain('File (named by the agent): pause�edoc.gcode�')
    expect(text).toContain('Note from the agent, not checked by SlicerX: "Safe� evorppa"')
    const slots = t.lines.find((l) => l.startsWith('Filament slots:'))!
    expect(slots).toContain('filament 1 from slot A1')
    expect(slots).toContain('filament 12 from slot D4')
  })

  it('words a change from the hub-checked work and blocks Approve on one it cannot word (N3)', () => {
    const adjust = (change: Record<string, unknown>) =>
      card({ title: 'Lower the fan a little', actions: [{ action: 'printer.adjust', target: 'bay-4', paramsHash: 'd' }], work: { kind: 'adjust', printerId: 'bay-4', change } })
    const t = describeCard(adjust({ kind: 'nozzle', celsius: 285 }), names)
    expect(t.title).toBe('Change the running print on Bay 4?')
    expect(t.lines).toContain('If you approve, the hub will change the running print on Bay 4.')
    expect(t.lines).toContain('Change: Set the nozzle to 285 °C on Bay 4')
    expect(t.lines.join(' ')).not.toContain('kind nozzle')
    expect(t.blocked).toBeUndefined()
    expect(describeCard(adjust({ kind: 'fan', fan: 'part', percent: 40 }), names).lines).toContain('Change: Set the part cooling fan to 40% on Bay 4')
    // No work summary, or a change this app does not know: no Approve, and the agent's words never stand in.
    expect(describeCard(adjust({ kind: 'laser', percent: 100 }), names).blocked).toMatch(/Deny/)
    const bare = describeCard(card({ title: 'Lower the fan a little', actions: [{ action: 'printer.adjust', target: 'bay-4', paramsHash: 'd' }] }), names)
    expect(bare.blocked).toMatch(/Deny/)
    expect(bare.lines.filter((l) => l.includes('Lower the fan'))).toEqual(['Note from the agent, not checked by SlicerX: "Lower the fan a little"'])
  })

  it('shows the filament slot map the hub holds for a start', () => {
    const work = { kind: 'print' as const, printerId: 'bay-4', file: { name: 'two-color.gcode' }, opts: { slotMap: { 0: 'A1', 2: 'A3' } } }
    const t = describeCard(card({ work }), names)
    expect(t.lines).toContain('Filament slots: filament 1 from slot A1, filament 3 from slot A3')
    expect(t.lines.join(' ')).not.toContain('Options:')
  })

  it('names a G-code card by its action and cuts a long note', () => {
    const t = describeCard(card({ title: `Cool down ${'x'.repeat(400)}`, actions: [{ action: 'printer.gcode', target: 'bay-4', paramsHash: 'c' }] }), names)
    expect(t.title).toBe('Send a G-code line to Bay 4?')
    expect(t.startsPrint).toBe(false)
    expect(t.lines.at(-1)!.length).toBeLessThan(230)
  })

  it('shows the whole G-code line and blocks Approve on one that hides a second command (N1)', () => {
    const gcode = (line: string) => card({ id: `g-${line.length}`, actions: [{ action: 'printer.gcode', target: 'bay-4', paramsHash: 'c' }], work: { kind: 'gcode', printerId: 'bay-4', line } })
    const long = `M117 ${'x'.repeat(91)}`
    const t = describeCard(gcode(long), names)
    expect(t.lines).toContain(`G-code: ${long}`)
    expect(t.blocked).toBeUndefined()
    const hidden = `M117 Checking the nozzle ${'x'.repeat(120)}\nM104 S290`
    const bad = describeCard(gcode(hidden), names)
    expect(bad.lines.join(' ')).not.toContain('M117 Checking')
    expect(bad.blocked).toMatch(/Deny/)
    // In the dialog the card arrives with an error, which keeps Approve off.
    let emit: (r: ApprovalRequest) => void = () => undefined
    const stop = watchHubCards({ onRequest: (cb) => ((emit = cb), () => undefined), grantWith: async () => ({ queued: true as const }), deny: async () => undefined }, names)
    emit(gcode(hidden))
    expect(get().approval?.checks?.errors).toEqual([bad.blocked])
    stop()
  })

  it('tells printers with names that read the same apart by id (R8)', () => {
    const labels = printerLabels([
      { id: 'bay-1', name: 'Bay 1' },
      { id: 'bay-2', name: ' bay\u00a01\u200b ' },
      { id: 'bay-3', name: '\uff22\uff41\uff59\u3000\uff11' },
      { id: 'bay-4', name: 'Voron' },
      { id: 'bay-5', name: '' },
    ])
    expect(labels.get('bay-1')).toBe('Bay 1 (bay-1)')
    expect(labels.get('bay-2')).toMatch(/\(bay-2\)$/)
    expect(labels.get('bay-3')).toMatch(/\(bay-3\)$/)
    expect(labels.get('bay-4')).toBe('Voron')
    expect(labels.get('bay-5')).toBe('bay-5')
  })

  it('reads printer names again for each card, so a rename shows (R8)', async () => {
    let names = new Map([['bay-4', 'Bay 4']])
    let emit: (r: ApprovalRequest) => void = () => undefined
    const refresh = async () => void (names = printerLabels([{ id: 'bay-4', name: 'Garage' }]))
    const stop = watchHubCards({ onRequest: (cb) => ((emit = cb), () => undefined), grantWith: async () => ({ queued: true as const }), deny: async () => undefined }, (id) => names.get(id) ?? id, refresh)
    emit(card({ work: { kind: 'print' as const, printerId: 'bay-4', file: { name: 'cube.gcode' } } }))
    await new Promise((r) => setTimeout(r, 0))
    expect(get().approval?.requests[0]?.title).toBe('Start a print on Garage?')
    stop()
  })

  it('keeps the hub\'s own text on cards the hub wrote', () => {
    const t = describeCard(card({ origin: 'queue', title: 'Start the next plate on Bay 4?', lines: ['Plate 2 of 3'] }), names)
    expect(t).toMatchObject({ title: 'Start the next plate on Bay 4?', lines: ['Plate 2 of 3'] })
  })

  it('shows one card at a time and answers only through Approve and Deny', async () => {
    const calls: string[] = []
    let emit: (r: ApprovalRequest) => void = () => undefined
    const hub: HubCards = {
      onRequest: (cb) => ((emit = cb), () => undefined),
      pending: async () => [],
      grantWith: async (id, o) => (calls.push(`grant ${id} ${o.bedClear}`), { queued: true as const }),
      deny: async (id) => void calls.push(`deny ${id}`),
    }
    const stop = watchHubCards(hub, names)
    const print = { kind: 'print' as const, printerId: 'bay-4', file: { name: 'cube.gcode' } }
    emit(card({ work: print }))
    emit(card({ id: 'req-2', actions: [{ action: 'printer.gcode', target: 'bay-4', paramsHash: 'c' }], work: { kind: 'gcode', printerId: 'bay-4', line: 'G28' } }))
    emit(card({ work: print }))
    const first = get().approval!
    expect(first.requests[0]!.title).toBe('Start a print on Bay 4?')
    expect(first.confirm).toBe(BED_CLEAR)
    expect(calls).toEqual([])
    await first.approve()
    expect(calls).toEqual(['grant req-1 true'])
    const second = get().approval!
    expect(second.requests[0]!.title).toBe('Send a G-code line to Bay 4?')
    expect(second.confirm).toBeUndefined()
    await second.deny()
    expect(calls).toEqual(['grant req-1 true', 'deny req-2'])
    expect(get().approval).toBeNull()
    stop()
  })

  it('describes a pause or cancel a paired phone asked for from the hub-verified action', () => {
    const pause = describeCard(card({ origin: 'phone', title: 'Start a print?', actions: [{ action: 'printer.pause', target: 'bay-4', paramsHash: 'p' }] } as Partial<HubCard>), names)
    expect(pause.title).toBe('Pause the print on Bay 4?')
    expect(pause.lines[0]).toMatch(/paired phone/)
    expect(pause.startsPrint).toBe(false)
    const cancel = describeCard(card({ origin: 'phone', actions: [{ action: 'printer.cancel', target: 'bay-4', paramsHash: 'c' }] } as Partial<HubCard>), names)
    expect(cancel.title).toBe('Cancel the print on Bay 4?')
  })
})
