// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// printer.list gives each printer's own web page (Mainsail, Fluidd, OctoPrint...) as webUi, the link the Printers
// tab opens, so a client can hand it to the person. A printer with no page, or one off the local network, has null.
import type { PilotEvent, PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createEvalEnv } from '../evals/harness'
import { createScriptedClient } from '../src/provider/scripted'

const MACHINE: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }

type ToolResult = Extract<PilotEvent, { type: 'tool_result' }>

async function list(): Promise<{ id: string; webUi: string | null }[]> {
  const env = createEvalEnv({
    client: createScriptedClient([{ calls: [{ name: 'printer.list', args: {} }] }, { text: 'done' }]),
    machine: MACHINE,
    objects: [],
    // The demo fleet sits on a documentation range; move the Voron and the Creality onto a home network.
    fleet: (f) => ({ ...f, printers: f.printers.map((p) => (p.id === 'bay-4' ? { ...p, host: '192.168.1.14' } : p.id === 'bay-5' ? { ...p, host: 'k1max.local' } : p)) }),
  })
  const events: PilotEvent[] = []
  for await (const ev of env.pilot.run('t', 'test', { context: { machine: MACHINE } })) events.push(ev)
  const r = events.filter((e): e is ToolResult => e.type === 'tool_result').at(-1)
  return r?.output as { id: string; webUi: string | null }[]
}

describe('printer.list', () => {
  it('names the web page of each printer that serves one on the local network', async () => {
    const out = Object.fromEntries((await list()).map((p) => [p.id, p.webUi]))
    // A Voron on Moonraker: Mainsail or Fluidd on port 80.
    expect(out['bay-4']).toBe('http://192.168.1.14/')
    // A stock K1 Max on its own connection serves no page; Bambu Lab printers serve none.
    expect(out['bay-5']).toBeNull()
    expect(out['bay-1']).toBeNull()
    // PrusaLink serves one, but this printer's saved host is not on a local network.
    expect(out['bay-3']).toBeNull()
  })
})
