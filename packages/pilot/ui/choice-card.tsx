// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useRef, useState, type KeyboardEvent } from 'react'
import type { PilotChoice } from '@slicerx/contracts'
import { Button, Icon } from '@slicerx/ui'
import { wasDismissed } from '../src/tool'

export interface ChoiceCardProps {
  askId: string
  title: string
  question: string
  choices: PilotChoice[]
  /** The answer the run recorded, or null while it waits. A dismissed question records an empty id. */
  picked: string | null
  /** False for cards from a saved log: they cannot be answered. */
  actionable: boolean
  onChoose?: ((askId: string, choiceId: string) => Promise<void>) | undefined
  /** The person turned the question down, with Cancel or by writing in the message box instead. */
  dismissed?: boolean | undefined
  /** What the person wrote instead of picking, shown under the card's answers. */
  said?: string | undefined
  /** Turns the question down without a pick; without it the card has no Cancel. */
  onDismiss?: ((askId: string) => Promise<void>) | undefined
}

/**
 * A question with fixed answers. One press picks; then every chip is done. Each chip keeps a slot for its check from
 * the start, so the picked one keeps its size and its neighbors stay where they are. A live card has a Cancel under its
 * answers that turns the question down (Escape too); the row is there from the first render and stays after any
 * answer, disabled, so neither a pick nor a cancel moves anything.
 */
export function ChoiceCard({ askId, title, question, choices, picked, actionable, onChoose, dismissed = false, said, onDismiss }: ChoiceCardProps) {
  // Shown as picked (or canceled) at once; the run's answer event confirms it.
  const [sent, setSent] = useState<string | null>(null)
  const [canceled, setCanceled] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const turnedDown = dismissed || canceled || (picked !== null && wasDismissed(picked))
  // a dismissed answer is an empty id: never a pick, so no chip is on and no label shows
  const chosen = turnedDown ? null : (picked ?? sent)
  const answered = turnedDown || chosen !== null || picked !== null
  const live = !answered && actionable
  const row = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const label = chosen === null ? null : (choices.find((c) => c.id === chosen)?.label ?? null)
  const failed = (e: unknown): void => setNote(`Could not send your answer: ${e instanceof Error ? e.message : String(e)}`)

  const choose = (id: string): void => {
    if (!live || !onChoose) return
    setSent(id)
    setNote(null)
    onChoose(askId, id).catch((e: unknown) => {
      setSent(null)
      failed(e)
    })
  }

  const cancel = (): void => {
    if (!live || !onDismiss) return
    setCanceled(true)
    setNote(null)
    onDismiss(askId).catch((e: unknown) => {
      setCanceled(false)
      failed(e)
    })
  }

  // Arrow keys move between the answers, Home and End jump to the ends; Enter or Space picks. Cancel is not one of them.
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const all = Array.from(row.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    const at = all.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0 || all.length === 0) return
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (at + 1) % all.length : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (at - 1 + all.length) % all.length : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : -1
    if (to < 0) return
    e.preventDefault()
    all[to]?.focus()
  }

  // Escape anywhere in a live card is Cancel; focus goes back to the message box, where the person types next
  const onCardKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Escape' || !live || !onDismiss) return
    e.preventDefault()
    e.stopPropagation()
    cancel()
    const box = (card.current?.closest('.sx-pilot') ?? document).querySelector<HTMLTextAreaElement>('.composer-text')
    box?.focus()
  }

  const hasFoot = actionable && onDismiss !== undefined
  return (
    <div ref={card} className="choice" role="group" aria-label={title} data-testid="mimir-choice" data-picked={chosen ?? undefined} data-dismissed={turnedDown || undefined} onKeyDown={onCardKey}>
      <div className="choice-top">
        <span className="choice-title">{title}</span>
        <span className={chosen ? 'choice-state c-ok' : 'choice-state'} aria-live="polite" data-testid="mimir-choice-state">
          {turnedDown ? (
            'Canceled'
          ) : label ? (
            <>
              <Icon name="check" /> {label}
            </>
          ) : actionable ? null : (
            'No answer'
          )}
        </span>
      </div>
      <div className="choice-q">{question}</div>
      <div className="choice-a" ref={row} onKeyDown={onKey}>
        {choices.map((c) => {
          const on = c.id === chosen
          return (
            <button
              key={c.id}
              type="button"
              className="choice-chip"
              data-on={on || undefined}
              data-off={(answered && !on) || undefined}
              aria-pressed={on}
              disabled={!live || !onChoose}
              onClick={() => choose(c.id)}
            >
              <span className="choice-check" aria-hidden="true">
                {on ? <Icon name="check" /> : null}
              </span>
              {c.label}
            </button>
          )
        })}
      </div>
      {note ? <div className="choice-note">{note}</div> : null}
      {/* the person's own words sit at the start of the foot row, as a sheet's status sits beside its Cancel */}
      {hasFoot ? (
        <div className="choice-foot">
          {said ? (
            <span className="choice-said" data-testid="mimir-choice-said">
              {said}
            </span>
          ) : null}
          <Button size="sm" variant="ghost" disabled={!live} data-testid="mimir-choice-cancel" onClick={cancel}>
            Cancel
          </Button>
        </div>
      ) : said ? (
        <div className="choice-said" data-testid="mimir-choice-said">
          {said}
        </div>
      ) : null}
    </div>
  )
}
