// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_POLICY, type Pilot, type PilotEvent } from '@slicerx/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PilotWorkspace } from '../ui/index'

function fakePilot(runs: string[]): Pilot {
  return {
    tools: () => [],
    policy: () => DEFAULT_POLICY,
    setPolicy: () => undefined,
    resolveApproval: async () => undefined,
    async *run(_s, message): AsyncIterable<PilotEvent> {
      runs.push(message)
      yield { type: 'text', delta: 'ok' }
      yield { type: 'done', stopReason: 'end', ms: 1 }
    },
    async *switchMachine(): AsyncIterable<PilotEvent> {
      yield { type: 'done', stopReason: 'end', ms: 1 }
    },
  }
}

afterEach(cleanup)

describe('initialPrompt', () => {
  it('runs the handed-over prompt once and reports it consumed', async () => {
    const runs: string[] = []
    const consumed = vi.fn()
    const pilot = fakePilot(runs)
    const { rerender } = render(<PilotWorkspace pilot={pilot} sessionId="s" skills={[]} initialPrompt="Why did Bay 4 fail?" onPromptConsumed={consumed} />)
    await waitFor(() => expect(screen.getByText('Why did Bay 4 fail?')).toBeTruthy())
    rerender(<PilotWorkspace pilot={pilot} sessionId="s" skills={[]} initialPrompt="Why did Bay 4 fail?" onPromptConsumed={consumed} />)
    await waitFor(() => expect(consumed).toHaveBeenCalledTimes(1))
    expect(runs).toEqual(['Why did Bay 4 fail?'])
  })
})
