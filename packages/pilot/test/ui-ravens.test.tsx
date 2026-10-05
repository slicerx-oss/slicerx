// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// huginn beats a wing while mimir reasons, muninn while it reads the knowledge base or the project.
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolRowModel } from '../ui/reduce'
import { isRecall } from '../ui/raven-wait'
import { Think } from '../ui/think'
import { ToolGroup } from '../ui/tool-group'

afterEach(cleanup)

const row = (tool: string, state: ToolRowModel['state']): ToolRowModel => ({ callId: tool, tool, source: 'kb', args: '', callSummary: undefined, state, summary: undefined, display: [], progress: [], ms: undefined, untrusted: false })

describe('ravens while mimir works', () => {
  it('tells recall tools from the rest', () => {
    expect(isRecall('kb.filament')).toBe(true)
    expect(isRecall('project.info')).toBe(true)
    expect(isRecall('printer.status')).toBe(false)
  })

  it('puts huginn by a streaming thought and nothing by a finished one', () => {
    const live = render(<Think text="" ms={null} showThinking={false} />)
    expect(live.container.querySelector('.raven-wait[title="huginn, thinking"] .sx-raven[data-flap]')).toBeTruthy()
    cleanup()
    const done = render(<Think text="" ms={1200} showThinking={false} />)
    expect(done.container.querySelector('.raven-wait')).toBeNull()
  })

  it('puts muninn on a running recall, the spinner on other tools', () => {
    const kb = render(<ToolGroup rows={[row('kb.search', 'running')]} />)
    expect(kb.container.querySelector('.tfold .raven-wait[title="muninn, recalling"]')).toBeTruthy()
    cleanup()
    const other = render(<ToolGroup rows={[row('printer.status', 'running')]} />)
    expect(other.container.querySelector('.raven-wait')).toBeNull()
  })
})
