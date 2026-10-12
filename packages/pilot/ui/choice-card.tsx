// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useRef, useState, type KeyboardEvent } from 'react'
import type { PilotChoice } from '@slicerx/contracts'
import { Icon } from '@slicerx/ui'

export interface ChoiceCardProps {
  askId: string
  title: string
  question: string
  choices: PilotChoice[]
  /** The answer the run recorded, or null while it waits. */
  picked: string | null
  /** False for cards from a saved log: they cannot be answered. */
  actionable: boolean
  onChoose?: ((askId: string, choiceId: string) => Promise<void>) | undefined
}

/**
 * A question with fixed answers. One press picks; then every chip is done. Each chip keeps a slot for its check from
 * the start, so the picked one keeps its size and its neighbors stay where they are.
 */
export function ChoiceCard({ askId, title, question, choices, picked, actionable, onChoose }: ChoiceCardProps) {
  // Shown as picked at once; the run's answer event confirms it.
  const [sent, setSent] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const chosen = picked ?? sent
  const live = chosen === null && actionable && onChoose !== undefined
  const row = useRef<HTMLDivElement>(null)
  const label = chosen === null ? null : choices.find((c) => c.id === chosen)?.label ?? null

  const choose = (id: string): void => {
    if (!live) return
    setSent(id)
    onChoose(askId, id).catch((e: unknown) => {
      setSent(null)
      setNote(`Could not send your answer: ${e instanceof Error ? e.message : String(e)}`)
    })
  }

  // Arrow keys move between the answers, Home and End jump to the ends; Enter or Space picks.
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const all = Array.from(row.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    const at = all.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0 || all.length === 0) return
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (at + 1) % all.length : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (at - 1 + all.length) % all.length : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : -1
    if (to < 0) return
    e.preventDefault()
    all[to]?.focus()
  }

  return (
    <div className="choice" role="group" aria-label={title} data-testid="mimir-choice" data-picked={chosen ?? undefined}>
      <div className="choice-top">
        <span className="choice-title">{title}</span>
        <span className={chosen ? 'choice-state c-ok' : 'choice-state'} aria-live="polite">
          {label ? (
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
              data-off={(chosen !== null && !on) || undefined}
              aria-pressed={on}
              disabled={!live}
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
    </div>
  )
}
