// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// The choice card: one press picks and the answer goes back to the run; then every chip is done. Arrow keys move
// between answers. The check has a slot in every chip from the start, so a pick changes no chip's contents but the icon.
// Cancel (or Escape) turns the question down: the card reads Canceled and its foot row stays where it was.
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

const chips = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.choice-chip'))
const cancelButton = () => screen.queryByTestId('mimir-choice-cancel') as HTMLButtonElement | null

/** The card's shape: every element's tag and first class, in order (icons left out), so a press that adds or drops a row shows up. */
const shape = () => Array.from(screen.getByTestId('mimir-choice').querySelectorAll('*'), (el) => `${el.tagName}.${el.classList[0] ?? ''}`).filter((x) => !/^(SVG|PATH|USE|svg|path|use)\./.test(x) && !x.includes('sx-ic'))

function live(o: { onDismiss?: (askId: string) => Promise<void>; onChoose?: (askId: string, id: string) => Promise<void>; picked?: string | null; dismissed?: boolean; said?: string; actionable?: boolean } = {}) {
  const onDismiss = o.onDismiss ?? vi.fn(async () => undefined)
  const onChoose = o.onChoose ?? vi.fn(async () => undefined)
  const props = { askId: 'a1', title: 'Confirm model', question: 'Is this the same thermostat?', choices: CHOICES, picked: o.picked ?? null, actionable: o.actionable ?? true, onChoose, onDismiss, ...(o.dismissed ? { dismissed: true } : {}), ...(o.said ? { said: o.said } : {}) }
  const view = render(<ChoiceCard {...props} />)
  return { onDismiss, onChoose, view, props }
}

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

describe('turning the question down', () => {
  it('a live card shows its answers and a Cancel; a card from a saved log shows no Cancel', () => {
    live()
    expect(chips()).toHaveLength(2)
    expect(cancelButton()?.textContent).toBe('Cancel')
    expect(cancelButton()?.disabled).toBe(false)
    cleanup()
    live({ actionable: false })
    expect(cancelButton()).toBeNull()
    cleanup()
    card()
    expect(cancelButton()).toBeNull()
  })

  it('Cancel sends the dismiss once, the card reads Canceled, and every control is done with nothing added or removed', async () => {
    const { onDismiss, onChoose } = live()
    const before = shape()
    fireEvent.click(cancelButton()!)
    expect(onDismiss).toHaveBeenCalledWith('a1')
    expect(screen.getByTestId('mimir-choice-state').textContent).toBe('Canceled')
    expect(chips().every((b) => b.disabled && b.hasAttribute('data-off') && !b.hasAttribute('data-on'))).toBe(true)
    expect(cancelButton()!.disabled).toBe(true)
    expect(shape()).toEqual(before)
    fireEvent.click(cancelButton()!)
    fireEvent.click(chips()[0]!)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onChoose).not.toHaveBeenCalled()
    expect(screen.getByTestId('mimir-choice').getAttribute('data-dismissed')).toBe('true')
  })

  it('a pick leaves Cancel in place, disabled, and changes nothing else in the card', () => {
    const { onDismiss } = live()
    const before = shape()
    fireEvent.click(chips()[0]!)
    expect(cancelButton()!.disabled).toBe(true)
    expect(shape()).toEqual(before)
    fireEvent.click(cancelButton()!)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('Escape in the card cancels and puts focus in the message box; the arrow keys never reach Cancel', () => {
    const onDismiss = vi.fn(async () => undefined)
    render(
      <div className="sx-pilot">
        <ChoiceCard askId="a1" title="Confirm model" question="Is this the same thermostat?" choices={CHOICES} picked={null} actionable onChoose={vi.fn(async () => undefined)} onDismiss={onDismiss} />
        <textarea className="composer-text" aria-label="Ask" />
      </div>,
    )
    const [a, b] = chips()
    a!.focus()
    for (const key of ['ArrowRight', 'ArrowRight', 'End', 'ArrowLeft', 'ArrowDown']) {
      fireEvent.keyDown(document.activeElement!, { key })
      expect(document.activeElement === a || document.activeElement === b).toBe(true)
    }
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledWith('a1')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Ask' }))
    expect(screen.getByTestId('mimir-choice-state').textContent).toBe('Canceled')
  })

  it('a dismiss that could not be sent puts the card back live, with the note', async () => {
    live({ onDismiss: vi.fn(async () => Promise.reject(new Error('No open question ask_1'))) })
    fireEvent.click(cancelButton()!)
    await waitFor(() => expect(screen.getByText(/Could not send your answer: No open question/)).toBeTruthy())
    expect(chips().every((b) => !b.disabled)).toBe(true)
    expect(cancelButton()!.disabled).toBe(false)
    expect(screen.getByTestId('mimir-choice-state').textContent).toBe('')
  })

  it("a dismissed answer from the run reads Canceled, with the person's words in the foot row", () => {
    live({ picked: '', dismissed: true, said: 'it is a different model' })
    expect(screen.getByTestId('mimir-choice-state').textContent).toBe('Canceled')
    expect(screen.getByTestId('mimir-choice-said').textContent).toBe('it is a different model')
    expect(screen.getByTestId('mimir-choice-said').parentElement?.className).toBe('choice-foot')
    expect(chips().every((b) => b.disabled && b.hasAttribute('data-off'))).toBe(true)
    cleanup()
    // a saved log: no Cancel, the words on their own line, still Canceled and never No answer
    live({ picked: '', dismissed: true, said: 'too big', actionable: false })
    expect(cancelButton()).toBeNull()
    expect(screen.getByTestId('mimir-choice-said').textContent).toBe('too big')
    expect(screen.getByTestId('mimir-choice-state').textContent).toBe('Canceled')
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

  it('folds a dismissed answer into the block, and an answer without the new fields as before', () => {
    const t1 = foldEvents([ask], startTurn(emptyTranscript(), { user: 'Can we print it?' }, 0))
    const t2 = foldEvents([{ type: 'ask_answered', askId: 'a1', choiceId: '', dismissed: true, said: 'a different one' }], t1)
    expect(t2.turns[0]!.blocks[0]).toMatchObject({ kind: 'choice', picked: '', dismissed: true, said: 'a different one' })
    const t3 = foldEvents([{ type: 'ask_answered', askId: 'a1', choiceId: '', dismissed: true }], t1)
    expect(t3.turns[0]!.blocks[0]).toMatchObject({ kind: 'choice', picked: '', dismissed: true })
    expect(t3.turns[0]!.blocks[0]).not.toHaveProperty('said')
    const t4 = foldEvents([{ type: 'ask_answered', askId: 'a1', choiceId: 'other' }], t1)
    expect(t4.turns[0]!.blocks[0]).toMatchObject({ kind: 'choice', picked: 'other' })
    expect(t4.turns[0]!.blocks[0]).not.toHaveProperty('dismissed')
  })

  it('folds an answer given with nobody asked as auto, and hands auto to the card hook', () => {
    const t1 = foldEvents([ask], startTurn(emptyTranscript(), { user: 'Make a plate' }, 0))
    const t2 = foldEvents([{ type: 'ask_answered', askId: 'a1', choiceId: 'same', auto: true }], t1)
    expect(t2.turns[0]!.blocks[0]).toMatchObject({ kind: 'choice', picked: 'same', auto: true })
    const seen: boolean[] = []
    render(<TranscriptView transcript={t2} showThinking={false} approvals={{ onApprove: async () => undefined, onCancel: async () => undefined, onChoose: vi.fn(async () => undefined), choiceCard: (props) => (seen.push(props.auto === true), null) }} />)
    expect(seen.at(-1)).toBe(true)
    // a person's answer is never auto
    const t3 = foldEvents([{ type: 'ask_answered', askId: 'a1', choiceId: 'same' }], t1)
    expect(t3.turns[0]!.blocks[0]).not.toHaveProperty('auto')
  })

  it('routes Cancel to the dismiss handler and shows the dismissed answer the run sent back', () => {
    const onDismiss = vi.fn(async () => undefined)
    const t = foldEvents([ask], startTurn(emptyTranscript(), { user: 'Hi' }, 0))
    const approvals = { onApprove: async () => undefined, onCancel: async () => undefined, onChoose: vi.fn(async () => undefined), onDismiss }
    const { rerender } = render(<TranscriptView transcript={t} showThinking={false} approvals={approvals} />)
    fireEvent.click(screen.getByTestId('mimir-choice-cancel'))
    expect(onDismiss).toHaveBeenCalledWith('a1')
    rerender(<TranscriptView transcript={foldEvents([{ type: 'ask_answered', askId: 'a1', choiceId: '', dismissed: true, said: 'later' }], t)} showThinking={false} approvals={approvals} />)
    expect(screen.getByTestId('mimir-choice-state').textContent).toBe('Canceled')
    expect(screen.getByTestId('mimir-choice-said').textContent).toBe('later')
  })

  it('renders the card and routes the pick to the handler', () => {
    const onChoose = vi.fn(async () => undefined)
    const t = foldEvents([ask], startTurn(emptyTranscript(), { user: 'Hi' }, 0))
    render(<TranscriptView transcript={t} showThinking={false} approvals={{ onApprove: async () => undefined, onCancel: async () => undefined, onChoose }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Different model' }))
    expect(onChoose).toHaveBeenCalledWith('a1', 'other')
  })
})
