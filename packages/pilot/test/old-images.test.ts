// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Older pictures leave the history to save space, but never from before reasoning the provider signed: that reasoning
// is bound to the history as it was sent, and a changed one is refused.
import { describe, expect, it } from 'vitest'
import type { LlmMessage } from '../src/provider/types'
import { dropOldImages } from '../src/runtime'

const png = (data: string) => ({ mime: 'image/png' as const, data })
const look = (id: string, data: string): LlmMessage[] => [
  { role: 'assistant', content: '', toolCalls: [{ id, name: 'design.look', arguments: '{}' }] },
  { role: 'tool', callId: id, content: 'Looked at the model', images: [png(data)] },
]
const thought = (kind: string): LlmMessage => ({ role: 'assistant', content: 'Done.', raw: [{ type: kind, thinking: 'x', signature: 'sig' }, { type: 'text', text: 'Done.' }] })
const pictures = (messages: LlmMessage[]) => messages.flatMap((m) => (m.role === 'tool' ? (m.images ?? []).map((i) => i.data) : []))

describe('dropping older pictures', () => {
  it('drops the oldest picture when no signed reasoning follows it', () => {
    const messages: LlmMessage[] = [{ role: 'user', content: 'make a boat' }, ...look('a', 'A'), ...look('b', 'B')]
    dropOldImages(messages, 1)
    expect(pictures(messages)).toEqual(['B'])
    expect(messages[2]).toMatchObject({ role: 'tool', content: expect.stringContaining('Older image removed') })
  })

  it.each(['thinking', 'redacted_thinking'])('keeps a picture that %s after it was signed against', (kind) => {
    const messages: LlmMessage[] = [{ role: 'user', content: 'make a boat' }, ...look('a', 'A'), thought(kind), { role: 'user', content: 'add a funnel' }, ...look('b', 'B')]
    const before = JSON.stringify(messages.slice(0, 4))
    dropOldImages(messages, 0)
    expect(JSON.stringify(messages.slice(0, 4))).toBe(before)
    // only what came after the signed reasoning is trimmed
    expect(pictures(messages)).toEqual(['A'])
  })

  it('leaves reasoning with no signature out of the count', () => {
    const plain: LlmMessage = { role: 'assistant', content: 'Done.', raw: [{ type: 'text', text: 'Done.' }] }
    const messages: LlmMessage[] = [{ role: 'user', content: 'make a boat' }, ...look('a', 'A'), plain, ...look('b', 'B')]
    dropOldImages(messages, 1)
    expect(pictures(messages)).toEqual(['B'])
  })
})
