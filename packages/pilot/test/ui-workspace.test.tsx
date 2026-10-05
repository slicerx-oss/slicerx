// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  DEFAULT_POLICY,
  type ApprovalDecision,
  type ApprovalRequest,
  type PermissionPolicy,
  type Pilot,
  type PilotEvent,
  type ToolSpec,
} from '@slicerx/contracts'
import { PilotWorkspace } from '../ui/index'

const REQUEST: ApprovalRequest = {
  id: 'apr_1',
  sessionId: 'bay-planning',
  tool: 'printer.queue',
  permission: 'queue',
  title: 'Send 2 plates to Bay 2 and Bay 3?',
  lines: ['Plate 1: 6 brackets on Bay 2, 1h 52m', 'Plate 2: 6 brackets on Bay 3, 2h 14m'],
  paramsHash: 'h',
  actions: [],
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
}

type Step = PilotEvent | 'gate' | 'approval'

const SCRIPT: Step[] = [
  { type: 'start', runId: 'r1', sessionId: 'bay-planning', provider: 'fake', model: 'fake-1', at: new Date().toISOString() },
  { type: 'plugins', plugins: [{ id: 'spoolman', name: 'Spoolman', state: 'loading', tools: 2 }] },
  { type: 'plugins', plugins: [{ id: 'spoolman', name: 'Spoolman', state: 'ready', tools: 2, detail: '23 spools tracked' }] },
  { type: 'thinking', delta: 'Friday is three days out, ' },
  { type: 'thinking', delta: 'so cost decides.' },
  'gate',
  { type: 'thinking_done', ms: 3200 },
  { type: 'usage', inputTokens: 1500, outputTokens: 400 },
  { type: 'tool_call', callId: 'c1', tool: 'spoolman.check', source: 'plugin', input: { material: 'PETG' }, args: '--material PETG' },
  {
    type: 'tool_result',
    callId: 'c1',
    ok: true,
    summary: '3 PETG spools, 2 loaded',
    ms: 800,
    display: [{ kind: 'table', head: ['spool', 'left'], rows: [['#14', '612 g'], ['#07', { text: '138 g', tone: 'warn' }]] }],
  },
  { type: 'tool_call', callId: 'c2', tool: 'slice', source: 'skill', input: {}, args: '--profile "0.20 Standard"' },
  {
    type: 'tool_result',
    callId: 'c2',
    ok: true,
    summary: '2 plates, 4h 06m, 77.3 g',
    ms: 3400,
    display: [{ kind: 'progress', items: [{ label: 'plate 1', fraction: 1, note: '30 layers' }] }],
  },
  {
    type: 'settings_diff',
    diff: {
      title: 'Plate overrides for PETG. The saved profile is unchanged.',
      scope: 'plate',
      rows: [{ key: 'outer_wall_speed', before: '200 mm/s', after: '120 mm/s', reason: 'PETG strings and sags at high wall speeds', sources: ['prusa_kb_petg'] }],
    },
  },
  { type: 'approval_request', request: REQUEST },
  'approval',
  { type: 'approval_resolved', requestId: 'apr_1', decision: { kind: 'approve' }, by: 'user' },
  { type: 'tool_call', callId: 'c3', tool: 'bambu.lan.queue', source: 'plugin', input: {}, args: 'bay-2' },
  { type: 'tool_result', callId: 'c3', ok: true, summary: 'Plate 1 accepted on Bay 2', ms: 900 },
  { type: 'text', delta: 'Both plates are queued. Use ' },
  { type: 'text', delta: '`sx status` to follow them.' },
  { type: 'text_done' },
  {
    type: 'citations',
    items: [
      { id: 'prusa_kb_petg', title: 'PETG material guide', publisher: 'Prusa Knowledge Base', url: 'https://help.prusa3d.com/article/petg_2059', kind: 'kb' },
      { id: 'https://example.org/petg', title: 'PETG tips', url: 'https://example.org/petg', kind: 'web' },
    ],
  },
  { type: 'summary', title: '12 brackets queued on 2 printers', rows: [['Cost', '$2.72']], stopped: false },
  { type: 'done', stopReason: 'end', ms: 72_000 },
]

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

class FakePilot implements Pilot {
  resolved: [string, ApprovalDecision][] = []
  runs: string[] = []
  private current: PermissionPolicy = DEFAULT_POLICY
  private gate = deferred()
  private approval = deferred()

  tools(): ToolSpec[] {
    return []
  }

  openGate(): void {
    this.gate.resolve()
  }

  async *run(_sessionId: string, message: string): AsyncIterable<PilotEvent> {
    this.runs.push(message)
    for (const step of SCRIPT) {
      if (step === 'gate') await this.gate.promise
      else if (step === 'approval') await this.approval.promise
      else yield step
    }
  }

  async *switchMachine(): AsyncIterable<PilotEvent> {
    yield { type: 'done', stopReason: 'end', ms: 1 }
  }

  async resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    this.resolved.push([requestId, decision])
    this.approval.resolve()
  }

  setPolicy(policy: PermissionPolicy): void {
    this.current = policy
  }

  policy(): PermissionPolicy {
    return this.current
  }
}

const SKILLS = [{ name: 'slice', version: '2.3.1', description: 'Slices with a named profile and reports time, grams and cost per plate.' }]

afterEach(() => cleanup())

describe('PilotWorkspace', () => {
  it('renders a live run from Pilot events and answers the approval', async () => {
    const pilot = new FakePilot()
    const { container } = render(<PilotWorkspace pilot={pilot} sessionId="bay-planning" skills={SKILLS} context={{ project: 'brackets' }} />)

    expect(container.querySelector('.term-title')?.textContent).toBe('mimir - new-run - zsh')
    fireEvent.click(screen.getByRole('button', { name: 'Plan 12 strong PETG brackets by Friday' }))
    expect(pilot.runs).toEqual(['Plan 12 strong PETG brackets by Friday'])

    // The bubble, then thinking streaming open.
    await waitFor(() => expect(container.querySelector('.bubble')?.textContent).toContain('Plan 12 strong PETG brackets by Friday'))
    expect(container.querySelector('.turn-user .where')?.textContent).toBe('~/brackets')
    const thinkButton = await screen.findByRole('button', { name: /Thinking/ })
    expect(thinkButton.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.think-b')?.textContent).toBe('Friday is three days out, so cost decides.')

    pilot.openGate()

    // Approval card with Approve focused.
    const card = await screen.findByRole('group', { name: 'Approval request' })
    const approve = within(card).getByRole('button', { name: 'Approve' })
    await waitFor(() => expect(document.activeElement).toBe(approve))
    expect(within(card).getByText('Queue jobs: ask first')).toBeTruthy()
    expect(within(card).getByText('Send 2 plates to Bay 2 and Bay 3?')).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Edit plan' })).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(card.querySelector('.cd')?.textContent).toMatch(/^Expires in [45]:\d\d$/)

    // Thinking folded to one line after thinking_done.
    const folded = screen.getByRole('button', { name: /Thought for 3\.2s/ })
    expect(folded.getAttribute('aria-expanded')).toBe('false')

    // Consecutive tool calls share one group; the progress row starts open; rows toggle.
    const groups = container.querySelectorAll('.tools')
    expect(groups).toHaveLength(1)
    const rows = groups[0]?.querySelectorAll('.trow') ?? []
    expect(rows).toHaveLength(2)
    const first = rows[0]
    const second = rows[1]
    if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement)) throw new Error('missing tool rows')
    expect(first.textContent).toContain('spoolman.check')
    expect(first.textContent).toContain('3 PETG spools, 2 loaded')
    expect(first.getAttribute('aria-expanded')).toBe('false')
    expect(second.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(first)
    expect(first.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.cmd')?.textContent).toBe('$ plugin spoolman.check --material PETG')
    fireEvent.click(first)
    expect(first.getAttribute('aria-expanded')).toBe('false')

    // Settings diff with before, after and the reason.
    expect(container.querySelector('.drow.del')?.textContent).toContain('200 mm/s')
    expect(container.querySelector('.drow.add')?.textContent).toContain('120 mm/s')
    expect(container.querySelector('.dwhy')?.textContent).toContain('PETG strings and sags at high wall speeds')
    expect(container.querySelector('.dwhy')?.textContent).toContain('prusa_kb_petg')

    // Approve goes to the runtime as the person's decision.
    fireEvent.click(approve)
    await waitFor(() => expect(pilot.resolved).toEqual([['apr_1', { kind: 'approve' }]]))
    await waitFor(() => expect(within(card).getByText(/^Approved by you at \d\d:\d\d$/)).toBeTruthy())
    expect(within(card).queryByRole('button', { name: 'Approve' })).toBeNull()

    // After approval: a new tool group, the reply, sources and the summary.
    await screen.findByText('12 brackets queued on 2 printers')
    expect(container.querySelectorAll('.tools')).toHaveLength(2)
    expect(container.querySelector('.say .code')?.textContent).toBe('sx status')
    const link = screen.getByRole('link', { name: 'PETG tips' })
    expect(link.getAttribute('href')).toBe('https://example.org/petg')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noreferrer noopener')
    expect(screen.getByRole('link', { name: 'PETG material guide' }).getAttribute('rel')).toBe('noreferrer noopener')
    expect(container.querySelector('.sum-h .dur')?.textContent).toBe('done in 1m 12s')

    // Inspector meter and Show thinking.
    const meter = container.querySelector('.meter')?.textContent ?? ''
    expect(meter).toContain('Tool calls3')
    expect(meter).toContain('Model tokens1.9k')
    fireEvent.click(screen.getByLabelText('Show thinking'))
    expect(screen.getByRole('button', { name: /Thought for 3\.2s/ }).getAttribute('aria-expanded')).toBe('true')
  })

  it('never offers Allow for starting prints and reports policy changes', () => {
    const pilot = new FakePilot()
    const changes: PermissionPolicy[] = []
    render(<PilotWorkspace pilot={pilot} sessionId="s" skills={SKILLS} onPolicyChange={(p) => changes.push(p)} />)
    const start = screen.getByRole('radiogroup', { name: 'Start or resume prints' })
    expect(within(start).queryByRole('radio', { name: 'Allow' })).toBeNull()
    const queue = screen.getByRole('radiogroup', { name: 'Queue jobs' })
    fireEvent.click(within(queue).getByRole('radio', { name: 'Allow' }))
    expect(changes.at(-1)?.classes.queue).toBe('allow')
    expect(pilot.policy().classes.queue).toBe('allow')
  })
})
