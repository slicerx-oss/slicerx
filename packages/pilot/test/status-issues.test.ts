// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// printer.status and printer.list carry what the printer reports wrong now (an HMS code, a print error) in their
// summary, display and output, so a client sees why a print stopped without the printer's own screen or app.
import type { PilotEvent, PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createEvalEnv, type EvalObject } from '../evals/harness'
import { createScriptedClient } from '../src/provider/scripted'
import { issuesLine, type PrinterIssue } from '../src/tools/printers'

const MACHINE: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }
const CLIP: EvalObject = { id: 'clip', name: 'Clip', bboxMm: [30, 12, 8] }

type ToolResult = Extract<PilotEvent, { type: 'tool_result' }>

const AMS: PrinterIssue = {
  code: '0700_2000_0002_0001',
  severity: 'serious',
  module: 'AMS',
  text: 'AMS slot A1 could not feed the filament. Check the spool and the feeder, then resume.',
  helpUrl: 'https://wiki.bambulab.com/en/x1/troubleshooting/hmscode/0700_2000_0002_0001',
}
const OLD: PrinterIssue = { code: '0300_0100_0001_0001', severity: 'common', module: 'motion controller', text: 'Left over from the last job.', stale: true }

/** Runs one tool call with `device.issues` on the host answering `issues` (or throwing, or missing). */
async function call(name: string, args: Record<string, unknown>, issues: ((id: string) => Promise<PrinterIssue[]>) | null) {
  const asked: string[] = []
  const device = issues
    ? {
        issues: (id: string) => {
          asked.push(id)
          return issues(id)
        },
      }
    : undefined
  const env = createEvalEnv({ client: createScriptedClient([{ calls: [{ name, args }] }, { text: 'done' }]), machine: MACHINE, objects: [CLIP], ...(device ? { device } : {}) })
  const events: PilotEvent[] = []
  for await (const ev of env.pilot.run('t', 'test', { context: { machine: MACHINE } })) events.push(ev)
  const result = events.filter((e): e is ToolResult => e.type === 'tool_result').at(-1)
  return { result, asked }
}

const rowsOf = (r: ToolResult | undefined): [string, unknown][] => {
  const d = (r?.display ?? []) as { kind: string; rows?: [string, unknown][] }[]
  return d.find((x) => x.kind === 'kv')?.rows ?? []
}

describe('printer issues in status reads', () => {
  it('printer.status puts a current problem in the summary, the display and the output, and leaves stale ones out', async () => {
    const { result, asked } = await call('printer.status', { printerId: 'bay-2' }, async () => [AMS, OLD])
    expect(asked).toEqual(['bay-2'])
    expect(result?.summary).toContain('AMS slot A1 could not feed the filament')
    expect(result?.summary).not.toContain('Left over')
    expect(rowsOf(result)).toContainEqual(['problem', { text: `${AMS.text} (code ${AMS.code})`, tone: 'bad' }])
    expect((result?.output as { issues?: PrinterIssue[] }).issues).toEqual([AMS])
  })

  it('printer.status reads as before when the printer reports nothing, the read fails, or the host cannot read issues', async () => {
    for (const read of [async () => [], async () => [OLD], () => Promise.reject(new Error('offline')), null]) {
      const { result } = await call('printer.status', { printerId: 'bay-2' }, read)
      expect(result?.ok).not.toBe(false)
      expect(rowsOf(result).some(([k]) => k === 'problem')).toBe(false)
      expect((result?.output as { issues?: unknown }).issues).toBeUndefined()
    }
  })

  it('printer.list names the printer with a problem in its summary and output', async () => {
    const { result } = await call('printer.list', {}, async (id) => (id === 'bay-2' ? [AMS] : []))
    expect(result?.summary).toMatch(/: AMS slot A1 could not feed the filament/)
    const out = result?.output as { id: string; issues?: PrinterIssue[] }[]
    expect(out.find((p) => p.id === 'bay-2')?.issues).toEqual([AMS])
    expect(out.filter((p) => p.id !== 'bay-2').every((p) => p.issues === undefined)).toBe(true)
  })

  it('says how many more problems there are after the first', () => {
    expect(issuesLine([])).toBeNull()
    expect(issuesLine([AMS])).toBe(AMS.text)
    expect(issuesLine([AMS, { ...AMS, text: 'Second.' }, { ...AMS, text: 'Third.' }])).toBe(`${AMS.text} (and 2 more)`)
  })
})
