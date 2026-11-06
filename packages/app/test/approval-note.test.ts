// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { ApprovalRequest, PermissionClass, SideEffectAction } from '@slicerx/contracts'
import { watchHubCards, type HubCard, type HubCards } from '../src/link/agent-cards'
import { allowsNote } from '../src/shell/approval-note'
import { get, set } from '../src/state/store'

const request = (permission: string, over: Partial<HubCard> = {}): HubCard =>
  ({
    id: 'req-1',
    sessionId: 's',
    tool: 't',
    permission: permission as PermissionClass,
    title: 'T',
    lines: [],
    origin: 'mcp',
    paramsHash: 'h',
    actions: [],
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    ...over,
  }) as HubCard

const footer = (what: string) => `Allows SlicerX to ${what}, once. The approval expires in 5 min.`

describe('the approval footer', () => {
  beforeEach(() => set({ approval: null, toast: null }))

  it('keeps the wording of each permission class', () => {
    const words: [string, string][] = [
      ['queue', 'send a file to the printer'],
      ['start', 'heat and move the printer'],
      ['profile', 'change a saved profile'],
      ['slice', 'slice in this project'],
      ['read', 'read data'],
    ]
    for (const [kind, what] of words) expect(allowsNote({ requests: [request(kind)] }), kind).toBe(footer(what))
    expect(allowsNote({ requests: [request('queue'), request('start'), request('queue')] })).toBe(footer('send a file to the printer and heat and move the printer'))
  })

  it('keeps the wording of every hub card kind, and words a slot card as the slot it changes', async () => {
    const t = (action: SideEffectAction) => [{ action, target: 'bay-4', paramsHash: action }]
    const setting = { slot: 'A2', filamentId: 'GFG99', material: 'PETG', color: '#1A2B3C', nozzleTempMin: 220, nozzleTempMax: 260 }
    const kinds: [string, Partial<HubCard>, string][] = [
      ['print', { actions: [...t('printer.upload'), ...t('printer.start')], work: { kind: 'print', printerId: 'bay-4', file: { name: 'cube.gcode' } } }, footer('heat and move the printer')],
      ['resume', { actions: t('printer.resume'), work: { kind: 'resume', printerId: 'bay-4' } }, footer('heat and move the printer')],
      ['gcode', { actions: t('printer.gcode'), work: { kind: 'gcode', printerId: 'bay-4', line: 'G28' } }, footer('heat and move the printer')],
      ['home', { actions: t('printer.home'), work: { kind: 'home', printerId: 'bay-4' } }, footer('heat and move the printer')],
      ['adjust', { actions: t('printer.adjust'), work: { kind: 'adjust', printerId: 'bay-4', change: { speedPct: 120 } } }, footer('heat and move the printer')],
      ['pause', { actions: t('printer.pause'), work: { kind: 'pause', printerId: 'bay-4' } }, footer('heat and move the printer')],
      ['cancel', { actions: t('printer.cancel'), work: { kind: 'cancel', printerId: 'bay-4' } }, footer('heat and move the printer')],
      ['skip', { actions: t('printer.skip'), work: { kind: 'skip', printerId: 'bay-4', id: 'lid', epoch: 1 } }, footer('heat and move the printer')],
      ['plugin', { actions: [{ action: 'plugin.call' as const, target: 'home-assistant', paramsHash: 'p' }], work: { kind: 'plugin', printerId: '', pluginId: 'home-assistant', tool: 'call_service', input: {} } }, footer('heat and move the printer')],
      ['slot', { partner: 'LayerMate', actions: t('printer.adjust'), work: { kind: 'slot', printerId: 'bay-4', setting } }, footer('change one filament slot')],
    ]
    let emit: (r: ApprovalRequest) => void = () => undefined
    const hub: HubCards = { onRequest: (cb) => ((emit = cb), () => undefined), grantWith: async () => ({ queued: true as const }), deny: async () => undefined }
    const stop = watchHubCards(hub, (id) => (id === 'bay-4' ? 'Bay 4' : id))
    for (const [kind, over, want] of kinds) {
      emit(request('start', { id: `req-${kind}`, ...over }))
      const open = get().approval!
      expect(open.requests[0]!.id).toBe(`req-${kind}`)
      expect(allowsNote(open), kind).toBe(want)
      await open.deny()
    }
    stop()
  })
})
