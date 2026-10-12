// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// The choice card: one press picks and the answer goes back to the run; then every chip is done. Arrow keys move
// between answers. The check has a slot in every chip from the start, so a pick changes no chip's contents but the icon.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PilotEvent } from '@slicerx/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChoiceCard, TranscriptView } from '../ui/index'
import { emptyTranscript, foldEvents, startTurn } from '../ui/reduce'

afterEach(cleanup)

const CHOICES = [
  { id: 'same', label: 'Yes, same model' },
  { id: 'other', label: 'Different model' },
]

function card(onChoose = vi.fn(async () => undefined), picked: string | null = null, actionable = true) {
  render(<ChoiceCard askId="a1" title="Confirm model" question="Is this the same thermostat?" choices={CHOICES} picked={picked} actionable={actionable} onChoose={onChoose} />)
  return onChoose
}

const chips = () => screen.getAllByRole('button') as HTMLButtonElement[]

describe('the choice card', () => {
  it('sends the pick back to the run once, then every chip is done', async () => {
    const onChoose = card()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, same model' }))
    expect(onChoose).toHaveBeenCalledWith('a1', 'same')
    await waitFor(() => expect(chips().every((b) => b.disabled)).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Different model' }))
    expect(onChoose).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Yes, same model' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('group').getAttribute('data-picked')).toBe('same')
  })

  it('keeps a check slot in every chip, so picking changes no chip but the icon in it', () => {
    card()
    const before = chips().map((b) => b.querySelectorAll('.choice-check').length)
    fireEvent.click(chips()[1]!)
    expect(before).toEqual([1, 1])
    expect(chips().map((b) => b.querySelectorAll('.choice-check').length)).toEqual([1, 1])
    expect(chips()[1]!.querySelector('.choice-check svg, .choice-check .sx-ic')).not.toBeNull()
    expect(chips()[0]!.querySelector('.choice-check')!.childElementCount).toBe(0)
  })

  it('moves between answers with the arrow keys and the ends with Home and End', () => {
    card()
    const [a, b] = chips()
    a!.focus()
    fireEvent.keyDown(a!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(b)
    fireEvent.keyDown(b!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(a)
    fireEvent.keyDown(a!, { key: 'End' })
    expect(document.activeElement).toBe(b)
    fireEvent.keyDown(b!, { key: 'Home' })
    expect(document.activeElement).toBe(a)
  })

  it('shows the run\'s answer and cannot be answered from a saved log', () => {
    card(vi.fn(async () => undefined), 'other', false)
    expect(chips().every((b) => b.disabled)).toBe(true)
    expect(screen.getByRole('group').textContent).toContain('Different model')
  })

  it('lets the person try again when the answer could not be sent', async () => {
    card(vi.fn(async () => Promise.reject(new Error('offline'))))
    fireEvent.click(chips()[0]!)
    await waitFor(() => expect(screen.getByText(/Could not send your answer: offline/)).toBeTruthy())
    expect(chips().every((b) => !b.disabled)).toBe(true)
  })
})

describe('in the transcript', () => {
  const ask: PilotEvent = { type: 'ask', askId: 'a1', title: 'Confirm model', question: 'Is this the same thermostat?', choices: CHOICES }

  it('folds an ask into a card and the answer into its pick', () => {
    const t0 = startTurn(emptyTranscript(), { user: 'Can we print it?' }, 0)
    const t1 = foldEvents([ask], t0)
    const block = t1.turns[0]!.blocks[0]!
    expect(block).toMatchObject({ kind: 'choice', askId: 'a1', picked: null })
    const t2 = foldEvents([{ type: 'ask_answered', askId: 'a1', choiceId: 'same' }], t1)
    expect(t2.turns[0]!.blocks[0]).toMatchObject({ kind: 'choice', picked: 'same' })
  })

  it('renders the card and routes the pick to the handler', () => {
    const onChoose = vi.fn(async () => undefined)
    const t = foldEvents([ask], startTurn(emptyTranscript(), { user: 'Hi' }, 0))
    render(<TranscriptView transcript={t} showThinking={false} approvals={{ onApprove: async () => undefined, onCancel: async () => undefined, onChoose }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Different model' }))
    expect(onChoose).toHaveBeenCalledWith('a1', 'other')
  })
})
