// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PilotEvent, PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createEvalEnv, evalKb, noteApprovals } from '../evals/harness'
import { FRAMES } from '../evals/frames/index'
import { runScenario } from '../evals/runner'
import { SCENARIOS } from '../evals/skills/g'
import { AdjustRefused, materialLimits, planAdjustment, type Adjustment, type MaterialLimits } from '../skills/check_print/limits'
import { createAnthropicAdapter } from '../src/provider/anthropic'
import { createOpenAiAdapter } from '../src/provider/openai'
import { createOpenAiCompatibleAdapter } from '../src/provider/openai-compatible'
import { createScriptedClient } from '../src/provider/scripted'
import type { LlmRequest } from '../src/provider/types'

const kb = evalKb()
const info = (plugin: PrinterInfo['plugin']): PrinterInfo => ({ id: 'p', name: 'Bay 9', vendor: 'V', model: 'M', plugin, nozzleCount: 1 })
const status = (over: Partial<PrinterStatus> = {}): PrinterStatus => ({
  printerId: 'p',
  state: 'printing',
  nozzles: [{ current: 210, target: 210 }],
  bed: { current: 60, target: 60 },
  slots: [{ id: '1', material: 'PLA' }],
  cameraAvailable: true,
  updatedAt: '',
  ...over,
})
const pla = materialLimits(status(), kb)
const plan = (change: Adjustment, s = status(), plugin: PrinterInfo['plugin'] = 'moonraker', m: MaterialLimits | null = pla) => planAdjustment(change, s, info(plugin), m)
const refused = (f: () => unknown): string => {
  try {
    f()
  } catch (e) {
    if (e instanceof AdjustRefused) return e.message
    throw e
  }
  throw new Error('not refused')
}

describe('check_print limits', () => {
  it('knows the material only when every loaded slot holds it', () => {
    expect(pla?.name).toBe('PLA')
    expect(pla?.nozzle?.min).toBeGreaterThan(150)
    expect(materialLimits(status({ slots: [{ id: 'A1', material: 'PLA' }, { id: 'A2', material: 'PETG' }] }), kb)).toBeNull()
    expect(materialLimits(status({ slots: [] }), kb)).toBeNull()
  })

  it('plans fan G-code per firmware', () => {
    expect(plan({ kind: 'part_fan', percent: 40 }).gcode).toEqual(['M106 S102'])
    expect(plan({ kind: 'part_fan', percent: 40 }, status(), 'bambu-lan').gcode).toEqual(['M106 P1 S102'])
  })

  it('caps the fan for materials that crack with cooling', () => {
    const abs = materialLimits(status({ slots: [{ id: '1', material: 'ABS' }], nozzles: [{ current: 255, target: 255 }], bed: { current: 100, target: 100 } }), kb)
    expect(abs?.fanMaxPct).toBeLessThan(100)
    expect(refused(() => plan({ kind: 'part_fan', percent: 100 }, status(), 'moonraker', abs))).toMatch(/ABS tolerates at most/)
  })

  it('bounds the speed factor and refuses it on Bambu Lab printers', () => {
    expect(plan({ kind: 'speed', percent: 80 }).gcode).toEqual(['M220 S80'])
    expect(refused(() => plan({ kind: 'speed', percent: 200 }))).toMatch(/50 to 150/)
    expect(refused(() => plan({ kind: 'speed', percent: 80 }, status(), 'bambu-lan'))).toMatch(/speed level/)
  })

  it('moves temperatures in small steps inside the material range', () => {
    expect(plan({ kind: 'nozzle_temp', celsius: 215 }).gcode).toEqual(['M104 S215'])
    expect(refused(() => plan({ kind: 'nozzle_temp', celsius: 240 }))).toMatch(/at most 15 C/)
    expect(refused(() => plan({ kind: 'nozzle_temp', celsius: 245 }, status({ nozzles: [{ current: 235, target: 235 }] })))).toMatch(/PLA prints between/)
    expect(plan({ kind: 'bed_temp', celsius: 65 }).gcode).toEqual(['M140 S65'])
    expect(refused(() => plan({ kind: 'bed_temp', celsius: 75 }))).toMatch(/at most 10 C/)
  })

  it('takes smaller steps when the material is unknown', () => {
    expect(refused(() => plan({ kind: 'nozzle_temp', celsius: 222 }, status(), 'moonraker', null))).toMatch(/at most 10 C/)
    expect(refused(() => plan({ kind: 'bed_temp', celsius: 66 }, status(), 'moonraker', null))).toMatch(/at most 5 C/)
  })

  it('never turns on a heater that is off, and changes nothing unless printing', () => {
    expect(refused(() => plan({ kind: 'nozzle_temp', celsius: 200 }, status({ nozzles: [{ current: 30, target: 0 }] })))).toMatch(/heater .* is off/)
    expect(refused(() => plan({ kind: 'part_fan', percent: 50 }, status({ state: 'paused' })))).toMatch(/only made while it is printing/)
    expect(refused(() => plan({ kind: 'pause' }, status({ state: 'idle' })))).toMatch(/nothing to pause/)
    expect(plan({ kind: 'pause' }).gcode).toEqual([])
  })
})

describe('images to the model', () => {
  const req: LlmRequest = {
    model: 'm',
    tools: [],
    messages: [
      { role: 'user', content: 'how is it going' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'check_print', arguments: '{}' }] },
      { role: 'tool', callId: 'c1', content: '{"ok":true}', images: [{ mime: 'image/png', data: 'AAAA' }] },
    ],
  }

  it('sends the frame as input_image in a Responses function call output', () => {
    const body = JSON.parse(createOpenAiAdapter().build(req).body) as { input: { type?: string; output?: unknown }[] }
    const out = body.input.find((x) => x.type === 'function_call_output')?.output as { type: string; image_url?: string }[]
    expect(out.map((p) => p.type)).toEqual(['input_text', 'input_image'])
    expect(out[1]?.image_url).toBe('data:image/png;base64,AAAA')
  })

  it('sends the frame as an image block in an Anthropic tool result', () => {
    const body = JSON.parse(createAnthropicAdapter().build(req).body) as { messages: { content: unknown }[] }
    const result = (body.messages.at(-1)?.content as { type: string; content: { type: string; source?: { data: string } }[] }[])[0]
    expect(result?.type).toBe('tool_result')
    expect(result?.content.map((b) => b.type)).toEqual(['text', 'image'])
    expect(result?.content[1]?.source?.data).toBe('AAAA')
  })

  it('sends the frame in a user message after the tool messages for chat completions', () => {
    const body = JSON.parse(createOpenAiCompatibleAdapter().build(req).body) as { messages: { role: string; content: unknown }[] }
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(JSON.stringify(body.messages.at(-1)?.content)).toContain('data:image/png;base64,AAAA')
  })
})

describe('check_print in a run', () => {
  it.each(SCENARIOS.map((s) => [s.id, s] as const))('%s passes', async (_id, s) => {
    const rec = await runScenario(s, { mode: 'replay', model: 'scripted', run: 1 })
    expect(rec.score.notes).toEqual(rec.score.notes.filter((n) => /failed calls/.test(n)))
    expect(rec.score.pass).toBe(true)
    expect(rec.score.unapprovedSideEffects).toBe(0)
  })

  it('shows the frame in the transcript and sends the approved fan line to the printer', async () => {
    const s = SCENARIOS.find((x) => x.id === 'check-print-peeling')
    if (!s) throw new Error('scenario missing')
    const client = createScriptedClient(s.script, { chunk: false })
    const env = createEvalEnv({ client, machine: s.machine, objects: [], frames: { 'bay-1': FRAMES['corner-lifting'] } })
    const events: PilotEvent[] = []
    for await (const ev of env.pilot.run('t', s.prompt, { context: { project: 'eval', machine: s.machine, objects: [] } })) {
      events.push(ev)
      noteApprovals(env.audit, ev)
      if (ev.type === 'approval_request') {
        expect(ev.request.lines.join('\n')).toMatch(/Why: The bottom left corner/)
        void env.pilot.resolveApproval(ev.request.id, { kind: 'approve' })
      }
    }
    const frame = events.flatMap((e) => (e.type === 'tool_result' ? (e.display ?? []) : [])).find((d) => d.kind === 'image')
    expect(frame?.kind === 'image' && frame.src.startsWith('data:image/png;base64,')).toBe(true)
    expect(JSON.stringify(events.filter((e) => e.type === 'tool_result'))).not.toContain('"images"')
    expect(env.audit.sideEffects.filter((x) => x.ok && x.verified).map((x) => `${x.method}:${x.target}`)).toEqual(['callTool:bambu-lan'])
  })

  it('keeps only the newest frame in the model history', async () => {
    const check = { calls: [{ name: 'check_print', args: { printerId: 'bay-1' } }] }
    const client = createScriptedClient([check, check, check, { text: 'Still fine.' }], { chunk: false })
    const env = createEvalEnv({ client, machine: { printer: 'bambu_x1c', material: 'pla', nozzle: 0.4 }, objects: [], frames: { 'bay-1': FRAMES['midprint-clean'] } })
    for await (const _ of env.pilot.run('t', 'watch it', { context: { project: 'eval', machine: { printer: 'bambu_x1c', material: 'pla', nozzle: 0.4 }, objects: [] } })) void _
    const last = client.requests.at(-1)
    const images = last?.messages.reduce((a, m) => a + (m.role === 'tool' ? (m.images?.length ?? 0) : 0), 0)
    expect(images).toBe(1)
  })
})
