// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// printer.status and printer.list say when the camera guard can't watch a printer because it has no camera, the same
// fact the Printers tab shows under "No camera", so a client can tell the person before a print.
import type { PilotEvent, PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createEvalEnv, type EvalObject } from '../evals/harness'
import { createScriptedClient } from '../src/provider/scripted'

const MACHINE: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }
const CLIP: EvalObject = { id: 'clip', name: 'Clip', bboxMm: [30, 12, 8] }

type ToolResult = Extract<PilotEvent, { type: 'tool_result' }>

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult | undefined> {
  const env = createEvalEnv({ client: createScriptedClient([{ calls: [{ name, args }] }, { text: 'done' }]), machine: MACHINE, objects: [CLIP] })
  const events: PilotEvent[] = []
  for await (const ev of env.pilot.run('t', 'test', { context: { machine: MACHINE } })) events.push(ev)
  return events.filter((e): e is ToolResult => e.type === 'tool_result').at(-1)
}

const rowsOf = (r: ToolResult | undefined): [string, unknown][] => {
  const d = (r?.display ?? []) as { kind: string; rows?: [string, unknown][] }[]
  return d.find((x) => x.kind === 'kv')?.rows ?? []
}

describe('camera guard reach in printer reads', () => {
  // In the demo fleet bay-3 has no camera and bay-2 has one.
  it('printer.status says the camera guard cannot watch a printer with no camera', async () => {
    const r = await call('printer.status', { printerId: 'bay-3' })
    expect((r?.output as { cameraGuard?: string }).cameraGuard).toBe('no_camera')
    expect(r?.summary).toContain("no camera, so the camera guard can't watch it")
    expect(rowsOf(r)).toContainEqual(['camera guard', { text: "no camera, so the camera guard can't watch it", tone: 'warn' }])
  })

  it('printer.status reads can_watch for a printer with a camera, and says nothing more', async () => {
    const r = await call('printer.status', { printerId: 'bay-2' })
    expect((r?.output as { cameraGuard?: string }).cameraGuard).toBe('can_watch')
    expect(r?.summary).not.toContain('camera guard')
    expect(rowsOf(r).some(([k]) => k === 'camera guard')).toBe(false)
  })

  it('printer.list carries cameraGuard on each printer that answers', async () => {
    const r = await call('printer.list', {})
    const out = r?.output as { id: string; cameraGuard?: string }[]
    expect(out.find((p) => p.id === 'bay-3')?.cameraGuard).toBe('no_camera')
    expect(out.find((p) => p.id === 'bay-2')?.cameraGuard).toBe('can_watch')
  })
})
