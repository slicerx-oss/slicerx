// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An engine refusal reaches the person in plain words. The headphone stand's cut hit "the result is unsafe at mesh
// storage precision", and the chat showed that text as it was. The step's row now says what happened plainly, and the
// model gets the engine's text with how to try again, so it can retry without quoting the engine.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool, type ScriptStep } from '../src/index'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }
const RAW = 'boolean: the result is unsafe at mesh storage precision (collapsed triangles); change the cut or placement'

const cut = defineTool<Record<string, never>>({
  name: 'geom.boolean',
  version: '1',
  description: 'Cut',
  source: 'command',
  permission: 'read',
  input: z.object({}),
  async run() {
    throw new Error(RAW)
  },
})

describe('an engine refusal in plain words', () => {
  it('shows the person a plain line and gives the model the engine text with how to retry', async () => {
    let read = ''
    const steps: ScriptStep[] = [
      { calls: [{ name: 'geom.boolean', args: {} }] },
      (messages) => {
        read = messages.at(-1)?.content ?? ''
        return { text: 'Done.' }
      },
    ]
    const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: [cut as never] })
    const events: PilotEvent[] = []
    for await (const e of p.run('s', 'Cut the slot')) events.push(e)
    const row = events.find((e) => e.type === 'tool_result')
    expect(row).toMatchObject({ ok: false })
    const shown = row?.type === 'tool_result' ? row.summary : ''
    expect(shown).not.toMatch(/storage precision|collapsed triangles|boolean:/)
    expect(shown).toMatch(/too thin/)
    expect(read).toContain('storage precision')
    expect(read).toMatch(/0\.05 mm/)
  })
})
