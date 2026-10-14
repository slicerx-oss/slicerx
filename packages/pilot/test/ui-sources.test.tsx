// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// Sources fold to one line under the answer; a transcript kept over a reload comes back as history.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Citations } from '../ui/citations'
import { emptyTranscript, reduceTranscript, restoredTranscript, startTurn, transcriptTurns } from '../ui/reduce'

afterEach(cleanup)

describe('sources under a reply', () => {
  it('fold to "Sources (n)" and open to the list', () => {
    render(<Citations items={[{ id: 'a', title: 'PETG guide', url: 'https://help.prusa3d.com/petg', kind: 'kb' }, { id: 'b', title: 'Bed mesh', kind: 'kb' }]} />)
    const head = screen.getByRole('button', { name: 'Sources (2)' })
    expect(head.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('link', { name: 'PETG guide' })).toBeTruthy()
  })

  it('come after the answer in the turn', () => {
    let t = startTurn(emptyTranscript(), { user: 'Which layer height?' }, 0)
    t = reduceTranscript(t, { type: 'text', delta: '0.2 mm.' }, 0)
    t = reduceTranscript(t, { type: 'citations', items: [{ id: 'a', title: 'Guide', kind: 'kb' }] }, 0)
    expect(t.turns[0]?.blocks.map((b) => b.kind)).toEqual(['say', 'citations'])
  })
})

describe('a transcript kept over a reload', () => {
  it('comes back as history: nothing streams and cards cannot be answered', () => {
    let t = startTurn(emptyTranscript(), { user: 'Pick one' }, 0)
    t = reduceTranscript(t, { type: 'ask', askId: 'q1', title: 'Size', question: 'Which?', choices: [{ id: 'a', label: 'A' }] }, 0)
    t = reduceTranscript(t, { type: 'text', delta: 'Waiting for you.' }, 0)
    const back = restoredTranscript(t)
    expect(back.status).toBe('stopped')
    expect(back.turns[0]?.replay).toBe(true)
    expect(back.turns[0]?.blocks.find((b) => b.kind === 'choice')).toMatchObject({ replay: true })
    expect(back.turns[0]?.blocks.find((b) => b.kind === 'say')).toMatchObject({ streaming: false })
    expect(transcriptTurns(back)).toEqual([{ user: 'Pick one', reply: 'Waiting for you.' }])
  })
})
