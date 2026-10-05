// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { hashParams, type ApprovalRequest } from '@slicerx/contracts'
import { checkWork } from './work-card'

const sha = 'f'.repeat(64)
const name = (id: string) => (id === 'bay-2' ? 'Bay 2' : id)

async function printRequest(overrides: Partial<ApprovalRequest> = {}): Promise<ApprovalRequest & { work: unknown }> {
  return {
    id: 'r1',
    sessionId: 's',
    tool: 'sx_start_print',
    permission: 'queue',
    title: 'Cleaning the nozzle',
    lines: [],
    paramsHash: 'x',
    origin: 'mcp',
    printerId: 'bay-2',
    actions: [
      { action: 'printer.upload', target: 'bay-2', paramsHash: await hashParams({ printerId: 'bay-2', name: 'clip.gcode', sha256: sha }) },
      { action: 'printer.start', target: 'bay-2', paramsHash: await hashParams({ printerId: 'bay-2', name: 'clip.gcode', opts: {}, sha256: sha }) },
    ],
    expiresAt: '2026-10-02T00:05:00Z',
    work: { kind: 'print', printerId: 'bay-2', file: { name: 'clip.gcode', sizeBytes: 20480, sha256: sha }, opts: {} },
    ...overrides,
  }
}

it('words the card from the hub summary when the hashes match', async () => {
  const r = await checkWork(await printRequest(), name)
  expect(r).toMatchObject({ state: 'verified', title: 'Print clip.gcode on Bay 2?' })
  if (r.state === 'verified') expect(r.lines).toEqual(['File clip.gcode, 20 KB', `SHA-256 ${'f'.repeat(16)}`, 'Printer Bay 2'])
})

it('flags a summary that names another file than the card unlocks', async () => {
  const req = await printRequest()
  const r = await checkWork({ ...req, work: { ...(req.work as object), file: { name: 'other.gcode', sizeBytes: 1, sha256: sha } } } as never, name)
  expect(r).toEqual({ state: 'mismatch' })
})

it('flags a summary for another printer, and one it cannot read', async () => {
  const req = await printRequest()
  expect(await checkWork({ ...req, printerId: 'bay-9' }, name)).toEqual({ state: 'mismatch' })
  expect(await checkWork({ ...req, work: { kind: 'teleport', printerId: 'bay-2' } } as never, name)).toEqual({ state: 'mismatch' })
})

it('checks a G-code line and has nothing to say without a summary', async () => {
  const req = await printRequest()
  const g = { ...req, actions: [{ action: 'printer.gcode', target: 'bay-2', paramsHash: await hashParams({ printerId: 'bay-2', line: 'M104 S250' }) }], work: { kind: 'gcode', printerId: 'bay-2', line: 'M104 S250' } }
  expect(await checkWork(g as never, name)).toMatchObject({ state: 'verified', title: 'Send G-code to Bay 2?', code: 'M104 S250' })
  const { work: _w, ...plain } = req
  expect(await checkWork(plain as ApprovalRequest, name)).toEqual({ state: 'none' })
})

it('shows a long G-code line whole and refuses one that hides a second command (N1)', async () => {
  const req = await printRequest()
  const gcode = async (line: string) =>
    checkWork({ ...req, actions: [{ action: 'printer.gcode', target: 'bay-2', paramsHash: await hashParams({ printerId: 'bay-2', line }) }], work: { kind: 'gcode', printerId: 'bay-2', line } } as never, name)
  const long = `M117 ${'x'.repeat(91)}`
  const r = await gcode(long)
  expect(r).toMatchObject({ state: 'verified', code: long })
  if (r.state === 'verified') expect(r.lines.join(' ')).not.toContain('...')
  // The hashes match, since the hub would run exactly this, but the card could not show it whole.
  for (const line of [`M117 Checking the nozzle ${'x'.repeat(120)}\nM104 S290`, 'M117 a\rM104 S290', `M117 ${'x'.repeat(92)}`, 'M117 \u202e092S 401M']) {
    expect(await gcode(line)).toEqual({ state: 'mismatch' })
  }
})
