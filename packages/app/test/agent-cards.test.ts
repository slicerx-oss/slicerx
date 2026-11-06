// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest } from '@slicerx/contracts'
import { BED_CLEAR, RECHECK_MS, describeCard, printerLabels, watchHubCards, type CardDone, type CardResolved, type HubCard, type HubCards } from '../src/link/agent-cards'
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

  it('words a Home Assistant call from the hub-checked work, and blocks one it cannot word', () => {
    const input = { domain: 'switch', service: 'turn_off', entityId: 'switch.bay_1_power' }
    const ha = (over: Partial<HubCard> = {}) =>
      card({
        tool: 'home-assistant.call_service',
        title: 'Turn on the lights',
        actions: [{ action: 'plugin.call', target: 'home-assistant', paramsHash: 'p' }],
        work: { kind: 'plugin', printerId: '', pluginId: 'home-assistant', tool: 'call_service', input },
        ...over,
      })
    const t = describeCard(ha(), names)
    expect(t.title).toBe('Turn off switch.bay_1_power in Home Assistant?')
    expect(t.lines).toContain('Change: Turn off switch.bay_1_power in Home Assistant')
    expect(t.blocked).toBeUndefined()
    // A service or a domain it does not know, or work aimed at another app, gets no Approve.
    for (const bad of [
      { kind: 'plugin', printerId: '', pluginId: 'home-assistant', tool: 'call_service', input: { ...input, service: 'unlock' } },
      { kind: 'plugin', printerId: '', pluginId: 'home-assistant', tool: 'call_service', input: { domain: 'lock', service: 'turn_off', entityId: 'lock.front_door' } },
      { kind: 'plugin', printerId: '', pluginId: 'spoolman', tool: 'call_service', input },
      { kind: 'plugin', printerId: '', pluginId: 'home-assistant', tool: 'restart', input },
      { kind: 'plugin', printerId: '', pluginId: 'obico', tool: 'call_service', input },
    ] as const) {
      expect(describeCard(ha({ work: bad as NonNullable<HubCard['work']> }), names).blocked, JSON.stringify(bad)).toBeTruthy()
    }
  })

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

  it('names a partner app by the name the hub sends, with no AI wording on its card', () => {
    const work = { kind: 'print' as const, printerId: 'bay-4', file: { name: 'keychain.gcode.3mf', sizeBytes: 1_000_000 } }
    const t = describeCard(card({ partner: 'LayerMate', work, lines: ['Asked by LayerMate, a partner app', 'Ready to go.'] }), names)
    expect(t.lines[0]).toBe('Asked by LayerMate, a partner app.')
    expect(t.lines.some((l) => l.startsWith('File (named by LayerMate): keychain.gcode.3mf'))).toBe(true)
    expect(t.lines.some((l) => l.startsWith('Note from LayerMate, not checked by SlicerX'))).toBe(true)
    expect(t.lines.join(' ')).not.toMatch(/\bAI\b|MCP|agent/)
    // The partner's own lines still never show.
    expect(t.lines.join(' ')).not.toContain('Ready to go')
    // A card with no hub-set partner is an AI agent's, whatever its lines claim.
    const plain = describeCard(card({ lines: ['Asked by LayerMate, a partner app'] }), names)
    expect(plain.lines[0]).toBe('Asked by an AI agent over MCP. It cannot approve this itself.')
  })

  it('shows the file, hash and options the hub sent, and ignores work for another printer', () => {
    const work = { kind: 'print' as const, printerId: 'bay-4', file: { name: 'bracket.gcode', sizeBytes: 2_500_000, sha256: 'ab'.repeat(32) }, opts: { timelapse: true, bedLeveling: false, plate: 2 } }
    const t = describeCard(card({ work }), names)
    expect(t.lines).toContain('File (named by the agent): bracket.gcode, 2.4 MB')
    expect(t.lines).toContain(`SHA-256: ${'ab'.repeat(8)}`)
    // Print options by their names on the Print sheet; anything else as the hub sent it.
    expect(t.lines).toContain('Options: Timelapse on, Bed leveling off, plate 2')
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

  // A home is its own action: the hub homes under its home rules (printer state and plate) when the person approves.
  it('words a home card from the hub-checked work, and never as a raw G-code line', () => {
    const home = card({ title: 'Send G28', actions: [{ action: 'printer.home', target: 'bay-4', paramsHash: 'c' }], work: { kind: 'home', printerId: 'bay-4' } })
    const t = describeCard(home, names)
    expect(t.title).toBe('Home all axes of Bay 4?')
    expect(t.blocked).toBeUndefined()
    expect(t.startsPrint).toBe(false)
    // Approving it says the plate is clear, as for a start: the hub homes on that answer, not on a standing record.
    expect(t.asksPlate).toBe(true)
    expect(t.lines.join(' ')).toMatch(/nozzle comes down to the plate/)
    expect(t.lines.join(' ')).not.toMatch(/G-code/)
    // Home work on a G-code action, or a G-code line on a home action, has nothing checked to show.
    expect(describeCard(card({ actions: [{ action: 'printer.gcode', target: 'bay-4', paramsHash: 'c' }], work: { kind: 'home', printerId: 'bay-4' } }), names).blocked).toMatch(/Deny/)
    expect(describeCard(card({ actions: [{ action: 'printer.home', target: 'bay-4', paramsHash: 'c' }], work: { kind: 'gcode', printerId: 'bay-4', line: 'G28' } }), names).blocked).toMatch(/Deny/)
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
    // A home card asks about the plate like a start, and its Approve carries the answer.
    emit(card({ id: 'req-3', actions: [{ action: 'printer.home', target: 'bay-4', paramsHash: 'c' }], work: { kind: 'home', printerId: 'bay-4' } }))
    const home = get().approval!
    expect(home.confirm).toBe(BED_CLEAR)
    expect(home.go).toBe('Plate is clear, approve')
    await home.approve()
    expect(calls.at(-1)).toBe('grant req-3 true')
    stop()
  })

  it('words a skip of one object from the hub-checked work, and blocks one it cannot show', () => {
    const skip = (id: string) => card({ title: 'Cancel the print', actions: [{ action: 'printer.skip', target: 'bay-4', paramsHash: 's' }], work: { kind: 'skip', printerId: 'bay-4', id, epoch: 3 } })
    const t = describeCard(skip('lid.stl_id_0_copy_0'), names)
    expect(t.title).toBe('Skip an object on Bay 4?')
    expect(t.startsPrint).toBe(false)
    expect(t.blocked).toBeUndefined()
    expect(t.lines.some((l) => l.startsWith('Object: lid.stl_id_0_copy_0.'))).toBe(true)
    expect(describeCard(skip('lid M112'), names).blocked).toMatch(/cannot show which object/)
  })

  it('words a partner app asking to set an AMS slot from the hub-checked setting, and blocks one it cannot show', () => {
    const setting = { slot: 'A2', filamentId: 'GFG99', material: 'PETG', color: '#1A2B3C', nozzleTempMin: 220, nozzleTempMax: 260 }
    const slot = (s: Record<string, unknown>) =>
      card({ title: 'Pause the print', partner: 'LayerMate', actions: [{ action: 'printer.adjust', target: 'bay-4', paramsHash: 'a' }], work: { kind: 'slot', printerId: 'bay-4', setting: s } })
    const t = describeCard(slot(setting), names)
    expect(t.title).toBe('Set slot A2 on Bay 4 to PETG?')
    expect(t.startsPrint).toBe(false)
    expect(t.blocked).toBeUndefined()
    expect(t.lines[0]).toBe('Asked by LayerMate, a partner app.')
    expect(t.lines).toContain('If you approve, the hub will set filament slot A2 on Bay 4.')
    expect(t.lines).toContain('Slot A2: PETG, color #1a2b3c, preset GFG99')
    expect(t.lines).toContain('Nozzle 220 to 260 °C')
    // It is never worded as a change to a running print.
    expect(t.lines.join('\n')).not.toMatch(/running print/)
    for (const bad of [{ ...setting, material: 'PLA\nM104 S300' }, { ...setting, color: 'red' }, { ...setting, slot: 'A2;M112' }, { ...setting, filamentId: 'G'.repeat(17) }, { ...setting, nozzleTempMin: 280 }, { ...setting, nozzleTempMax: 400 }]) {
      const b = describeCard(slot(bad), names)
      expect(b.blocked, JSON.stringify(bad)).toMatch(/cannot show this slot setting/)
    }
    // Slot work on any action but the slot write gets no Approve.
    const off = card({ actions: [{ action: 'printer.gcode', target: 'bay-4', paramsHash: 'g' }], work: { kind: 'slot', printerId: 'bay-4', setting } })
    expect(describeCard(off, names).blocked).toBeDefined()
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

describe('cards answered elsewhere', () => {
  beforeEach(() => set({ approval: null, toast: null }))
  afterEach(() => vi.useRealTimers())

  const pause = (id: string) => card({ id, actions: [{ action: 'printer.pause', target: 'bay-4', paramsHash: 'p' }], work: { kind: 'pause', printerId: 'bay-4' } })

  it('closes the open card when the hub says another client answered it, and shows the next one', () => {
    const calls: string[] = []
    let emit: (r: ApprovalRequest) => void = () => undefined
    let resolved: (r: CardResolved) => void = () => undefined
    const hub: HubCards = {
      onRequest: (cb) => ((emit = cb), () => undefined),
      onResolved: (cb) => ((resolved = cb), () => undefined),
      grantWith: async (id) => (calls.push(`grant ${id}`), { queued: true as const }),
      deny: async (id) => void calls.push(`deny ${id}`),
    }
    const stop = watchHubCards(hub, names)
    emit(pause('p-1'))
    emit(pause('p-2'))
    emit(pause('p-3'))
    expect(get().approval?.requests[0]?.id).toBe('p-1')
    resolved({ requestId: 'p-1', decision: 'granted', via: 'phone' })
    expect(get().toast?.text).toBe('Approved on your phone.')
    // The dialog is free again: the next card takes its place.
    expect(get().approval?.requests[0]?.id).toBe('p-2')
    // A waiting card answered elsewhere never shows.
    resolved({ requestId: 'p-3', decision: 'granted', via: 'partner', by: 'LayerMate' })
    expect(get().approval?.requests[0]?.id).toBe('p-2')
    resolved({ requestId: 'p-2', decision: 'denied', via: 'partner', by: 'LayerMate' })
    expect(get().approval).toBeNull()
    expect(get().toast?.text).toBe('LayerMate withdrew it.')
    expect(calls).toEqual([])
    stop()
  })

  it('takes no note for a card this app answered itself', async () => {
    let emit: (r: ApprovalRequest) => void = () => undefined
    let resolved: (r: CardResolved) => void = () => undefined
    const hub: HubCards = {
      onRequest: (cb) => ((emit = cb), () => undefined),
      onResolved: (cb) => ((resolved = cb), () => undefined),
      grantWith: async () => ({ queued: true as const }),
      deny: async () => undefined,
    }
    const stop = watchHubCards(hub, names)
    emit(pause('p-1'))
    await get().approval!.deny()
    resolved({ requestId: 'p-1', decision: 'denied', via: 'app' })
    expect(get().approval).toBeNull()
    expect(get().toast).toBeNull()
    stop()
  })

  it('drops an open card the hub no longer lists, so a missed answer does not hold the dialog', async () => {
    vi.useFakeTimers()
    let listed = [pause('p-1'), pause('p-2')]
    const hub: HubCards = {
      onRequest: () => () => undefined,
      pending: async () => listed,
      grantWith: async () => ({ queued: true as const }),
      deny: async () => undefined,
    }
    const stop = watchHubCards(hub, names)
    await vi.advanceTimersByTimeAsync(0)
    expect(get().approval?.requests[0]?.id).toBe('p-1')
    await vi.advanceTimersByTimeAsync(RECHECK_MS)
    expect(get().approval?.requests[0]?.id).toBe('p-1')
    listed = []
    await vi.advanceTimersByTimeAsync(RECHECK_MS)
    expect(get().approval).toBeNull()
    expect(get().toast?.text).toBe('This request was answered elsewhere.')
    stop()
  })
})

describe('cards the hub could not carry out', () => {
  beforeEach(() => set({ approval: null, toast: null }))

  const setting = { slot: 'A2', filamentId: 'GFG99', material: 'PETG', color: '#1A2B3C', nozzleTempMin: 220, nozzleTempMax: 260 }
  const slotCard = card({ id: 's-1', partner: 'LayerMate', actions: [{ action: 'printer.adjust', target: 'bay-4', paramsHash: 'a' }], work: { kind: 'slot', printerId: 'bay-4', setting } })
  const pauseCard = card({ id: 'p-1', actions: [{ action: 'printer.pause', target: 'bay-4', paramsHash: 'p' }], work: { kind: 'pause', printerId: 'bay-4' } })
  const printCard = card({ id: 'q-1', work: { kind: 'print', printerId: 'bay-4', file: { name: 'cube.gcode' } } })
  const token = { requestId: 'x', token: 't', expiresAt: new Date(Date.now() + 300_000).toISOString() }

  /** A hub whose grant answers when `release` is called, or at once. */
  function fakeHub(opts: { hold?: boolean } = {}) {
    let emit: (r: ApprovalRequest) => void = () => undefined
    let done: (d: CardDone) => void = () => undefined
    let release: () => void = () => undefined
    const hub: HubCards = {
      onRequest: (cb) => ((emit = cb), () => undefined),
      onDone: (cb) => ((done = cb), () => undefined),
      grantWith: () => (opts.hold ? new Promise((r) => (release = () => r(token))) : Promise.resolve(token)),
      deny: async () => undefined,
    }
    return { hub, emit: (r: ApprovalRequest) => emit(r), done: (d: CardDone) => done(d), release: () => release() }
  }

  it('says a slot was not set when the hub refuses it after the person approved', async () => {
    const h = fakeHub()
    const stop = watchHubCards(h.hub, names)
    h.emit(slotCard)
    await get().approval!.approve()
    expect(get().toast?.text).toBe('Approved. The hub is running it now.')
    h.done({ requestId: 's-1', printerId: 'bay-4', ok: false, code: 'bad_state', message: 'a slot is set while no print is running' })
    // A problem the person has to know about stays until dismissed.
    expect(get().toast).toMatchObject({ text: 'Bay 4 is printing, so slot A2 was not set.', tone: 'error', dismissible: true })
    stop()
  })

  it('says a pause or a print start did not happen when the hub refuses it the same way', async () => {
    const h = fakeHub()
    const stop = watchHubCards(h.hub, names)
    h.emit(pauseCard)
    await get().approval!.approve()
    h.done({ requestId: 'p-1', printerId: 'bay-4', ok: false, code: 'bad_state', message: 'not printing' })
    expect(get().toast?.text).toBe('Bay 4 is not printing, so the print was not paused.')
    h.emit(printCard)
    await get().approval!.approve()
    h.done({ requestId: 'q-1', printerId: 'bay-4', ok: false, code: 'offline', message: 'no answer' })
    expect(get().toast).toMatchObject({ text: 'Bay 4 did not answer, so the print did not start.', tone: 'error' })
    stop()
  })

  it('says the axes were not homed when the hub refuses a home card', async () => {
    const h = fakeHub()
    const stop = watchHubCards(h.hub, names)
    h.emit(card({ id: 'h-1', actions: [{ action: 'printer.home', target: 'bay-4', paramsHash: 'h' }], work: { kind: 'home', printerId: 'bay-4' } }))
    await get().approval!.approve()
    h.done({ requestId: 'h-1', printerId: 'bay-4', ok: false, code: 'bad_state', message: 'printing' })
    expect(get().toast?.text).toBe('Bay 4 is not idle, so the axes were not homed.')
    h.emit(card({ id: 'h-2', actions: [{ action: 'printer.home', target: 'bay-4', paramsHash: 'h' }], work: { kind: 'home', printerId: 'bay-4' } }))
    await get().approval!.approve()
    h.done({ requestId: 'h-2', printerId: 'bay-4', ok: false, code: 'plate_check', message: 'plate' })
    expect(get().toast?.text).toBe('Bay 4 has something on the plate, so the axes were not homed.')
    stop()
  })

  it('shows nothing beyond the approval when the hub carries it out', async () => {
    const h = fakeHub()
    const stop = watchHubCards(h.hub, names)
    h.emit(slotCard)
    await get().approval!.approve()
    const approved = get().toast
    h.done({ requestId: 's-1', printerId: 'bay-4', ok: true })
    expect(get().toast).toEqual(approved)
    stop()
  })

  it('says nothing about cards it did not approve', () => {
    const h = fakeHub()
    const stop = watchHubCards(h.hub, names)
    h.done({ requestId: 'other', printerId: 'bay-4', ok: false, code: 'bad_state' })
    expect(get().toast).toBeNull()
    stop()
  })

  it('keeps the refusal when it arrives before the grant answers', async () => {
    const h = fakeHub({ hold: true })
    const stop = watchHubCards(h.hub, names)
    h.emit(slotCard)
    const approving = get().approval!.approve()
    h.done({ requestId: 's-1', printerId: 'bay-4', ok: false, code: 'bad_state' })
    h.release()
    await approving
    expect(get().toast?.text).toBe('Bay 4 is printing, so slot A2 was not set.')
    stop()
  })
})

describe('a client reason on its card', () => {
  const setting = { slot: 'A2', filamentId: 'GFG99', material: 'PETG', color: '#1A2B3C', nozzleTempMin: 220, nozzleTempMax: 260 }
  // The hub puts its own "Asked by" line first; the client's lines follow, its reason as "Why: ..." (REASON_PREFIX).
  const slot = (lines: string[]) =>
    card({ partner: 'LayerMate', title: 'Set slot A2 on Bay 4 to PETG?', lines: ['Asked by LayerMate, a partner app', ...lines], actions: [{ action: 'printer.adjust', target: 'bay-4', paramsHash: 'a' }], work: { kind: 'slot', printerId: 'bay-4', setting } })
  const reasonOf = (lines: string[]) => describeCard(slot(lines), names).lines.find((l) => l.startsWith('Reason from'))

  it('shows the reason a partner sent as its own words', () => {
    const t = describeCard(slot(['Why: The spool tag says PETG', 'PETG, color #1a2b3c, preset GFG99']), names)
    expect(t.lines).toContain('Reason from LayerMate, not checked by SlicerX: "The spool tag says PETG"')
    // Above the note, below the hub's facts.
    expect(t.lines.findIndex((l) => l.startsWith('Reason from'))).toBeGreaterThan(t.lines.indexOf('Nozzle 220 to 260 °C'))
    expect(t.lines.findIndex((l) => l.startsWith('Reason from'))).toBe(t.lines.findIndex((l) => l.startsWith('Note from')) - 1)
    expect(t.blocked).toBeUndefined()
  })

  it('cuts an over-long reason', () => {
    const r = reasonOf([`Why: ${'spool '.repeat(80)}`])!
    expect(r.endsWith('..."')).toBe(true)
    expect(r.length).toBeLessThan(180)
  })

  it('shows a reason as plain text: no markup, one line', () => {
    expect(reasonOf(['Why: <b>Tag</b> says **PETG**\n\nsee [the tag](https://example.com/x) `now` <script>x()</script>'])).toBe('Reason from LayerMate, not checked by SlicerX: "Tag says PETG see the tag now x()"')
  })

  it('shows no reason line when none was sent, or only markup', () => {
    expect(reasonOf(['PETG, color #1a2b3c, preset GFG99'])).toBeUndefined()
    expect(reasonOf(['Why: <br/> ** **'])).toBeUndefined()
    // The hub's own line is never read as a reason.
    expect(reasonOf([])).toBeUndefined()
  })

  it('names the agent when no partner asked', () => {
    const t = describeCard(card({ lines: ['Why: The queue is empty'], work: { kind: 'print', printerId: 'bay-4', file: { name: 'cube.gcode' } } }), names)
    expect(t.lines).toContain('Reason from the agent, not checked by SlicerX: "The queue is empty"')
  })
})
