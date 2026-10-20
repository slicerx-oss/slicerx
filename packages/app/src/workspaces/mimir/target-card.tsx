// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The card that picks a printer and its spool for the print run, for asks whose choice ids start with `pick:`. Flat in
// the conversation: each online printer with its loaded spools as swatches and words, and None of these. A tap answers.
// Every spool keeps room for its check from the start, so the picked one keeps its size and nothing moves.
import type { FilamentSlot, PilotChoice } from '@slicerx/contracts'
import { colorWord } from '@slicerx/pilot'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import type { ChoiceCardProps } from '@slicerx/pilot/ui'
import { Button, Icon, SwatchRing } from '@slicerx/ui'
import { useState } from 'react'
import { useFleet, type FleetRow } from '../../lib/queries'

/** What the card says when its answer could not be delivered. */
export const TARGET_INACTIVE = `Nothing picked. Ask ${ASSISTANT_NAME} again.`

/** The choice id that picks nothing. */
export const PICK_NONE = 'pick:none'

/** The printer and slot a choice id names, or null for None of these and any other id. */
export function pickOf(id: string): { printerId: string; slot: string } | null {
  const m = /^pick:(.+):([^:]+)$/.exec(id)
  return m ? { printerId: m[1]!, slot: m[2]! } : null
}

/** Whether an ask is the printer and spool pick: every choice id starts with `pick:`. */
export const isTargetAsk = (choices: readonly PilotChoice[]): boolean => choices.length > 0 && choices.every((c) => c.id.startsWith('pick:'))

interface Spool {
  choice: PilotChoice
  slot: string
  color: string
  words: string
}

interface Printer {
  id: string
  name: string
  model: string
  spools: Spool[]
}

/** A spool's color in the words the question's labels use ("Blue"), so the card and the question agree. */
function shownColor(hex: string | undefined): string | null {
  const w = colorWord(hex)
  return w ? w[0]!.toUpperCase() + w.slice(1) : null
}

/**
 * The printers to list, in the order the choices give them, each with its spools. A printer the fleet has as offline
 * is left out. Without a fleet row the choice's own label gives the words, with no color.
 */
export function targetPrinters(choices: readonly PilotChoice[], rows: readonly FleetRow[]): Printer[] {
  const out: Printer[] = []
  for (const c of choices) {
    const at = pickOf(c.id)
    if (!at) continue
    const row = rows.find((r) => r.id === at.printerId)
    if (row?.status.state === 'offline') continue
    const [lead = '', what = ''] = c.label.split(': ')
    let p = out.find((x) => x.id === at.printerId)
    if (!p) out.push((p = { id: at.printerId, name: row?.name ?? lead.split(', slot ')[0] ?? lead, model: row?.model ?? '', spools: [] }))
    const slot: FilamentSlot | undefined = row?.status.slots.find((s) => s.id === at.slot)
    const words = slot?.material || slot?.color ? [slot.material, shownColor(slot.color)].filter(Boolean).join(' ') : what.replace(', ', ' ')
    p.spools.push({ choice: c, slot: at.slot, color: slot?.color ?? '', words })
  }
  return out
}

export interface TargetPickerProps extends ChoiceCardProps {
  /** The fleet as the app knows it, for each printer's name, state and spool colors. */
  printers: readonly FleetRow[]
}

export function TargetPicker({ askId, title, question, choices, picked, actionable, onChoose, printers }: TargetPickerProps) {
  // Shown as picked at once; the run's answer event confirms it.
  const [sent, setSent] = useState<string | null>(null)
  // an answer the app could not deliver: the ask is gone, so the card stops taking answers
  const [inactive, setInactive] = useState(false)
  const chosen = picked ?? sent
  const live = chosen === null && actionable && onChoose !== undefined && !inactive
  const list = targetPrinters(choices, printers)
  const none = choices.find((c) => c.id === PICK_NONE)
  const at = chosen ? pickOf(chosen) : null
  const pickedName = at ? list.find((p) => p.id === at.printerId)?.name : undefined
  const state = chosen === null ? (actionable && !inactive ? null : 'No answer') : at ? `${pickedName ?? 'Picked'}, slot ${at.slot}` : 'None picked'

  const choose = (id: string): void => {
    if (!live) return
    setSent(id)
    // no internal reason or id reaches the person: the pick is over, and asking again makes a new one
    onChoose(askId, id).catch((e: unknown) => {
      console.warn('mimir: the printer pick did not land', e)
      setSent(null)
      setInactive(true)
    })
  }

  return (
    <div className="target-rec" role="group" aria-label={title} data-testid="mimir-target" data-picked={chosen ?? undefined}>
      <div className="target-rec-top">
        <span className="target-rec-title">{title}</span>
        <span className="target-rec-state" data-on={at ? true : undefined} aria-live="polite">
          {at ? <Icon name="check" /> : null}
          {state}
        </span>
      </div>
      {question ? <div className="target-rec-q">{question}</div> : null}
      <ul className="target-rec-printers">
        {list.map((p) => (
          <li key={p.id} className="target-rec-printer">
            <div className="target-rec-name">
              <span>{p.name}</span>
              {p.model && p.model !== p.name ? <span className="target-rec-model">{p.model}</span> : null}
            </div>
            <div className="target-rec-spools">
              {p.spools.map((s) => {
                const on = s.choice.id === chosen
                return (
                  <button
                    key={s.choice.id}
                    type="button"
                    className="target-rec-spool"
                    data-testid="mimir-target-spool"
                    data-on={on || undefined}
                    data-off={(!live && !on) || undefined}
                    aria-pressed={on}
                    aria-label={`${p.name}, slot ${s.slot}: ${s.words}`}
                    disabled={!live}
                    onClick={() => choose(s.choice.id)}
                  >
                    <SwatchRing color={s.color} size={28} selected={on} />
                    <span className="target-rec-words">
                      <span className="target-rec-what">{s.words}</span>
                      <span className="target-rec-slot">Slot {s.slot}</span>
                    </span>
                    <span className="target-rec-check" aria-hidden="true">
                      {on ? <Icon name="check" /> : null}
                    </span>
                  </button>
                )
              })}
            </div>
          </li>
        ))}
      </ul>
      {none ? (
        <div className="target-rec-foot">
          <Button size="sm" disabled={!live} pressed={chosen === PICK_NONE} onClick={() => choose(PICK_NONE)}>
            {none.label}
          </Button>
        </div>
      ) : null}
      {/* always there and one line, so the card keeps its height when the line fills */}
      <div className="target-rec-note" role="status" data-testid="mimir-target-note">
        {inactive ? TARGET_INACTIVE : ''}
      </div>
    </div>
  )
}

/** The pick card with the app's fleet. */
export function TargetCard(props: ChoiceCardProps) {
  const fleet = useFleet().data ?? []
  return <TargetPicker {...props} printers={fleet} />
}
