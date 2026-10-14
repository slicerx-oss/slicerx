// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PilotSheet, PilotSheetAnswer } from '@slicerx/contracts'
import { Button, Icon, ScrubNumber, tipAttrs } from '@slicerx/ui'
import { useState } from 'react'
import { safeUrl } from './citations'

/** The quiet tag a row keeps; a looked-up size has none, its page is in the header. */
const TAG: Record<PilotSheet['dims'][number]['source'], string | null> = { asked: 'you said', lookup: null, photo: 'from your photo', guess: 'guess' }

const unitText = (u: PilotSheet['dims'][number]['unit']): string => (u === 'deg' ? '°' : u)

/** The pages the looked-up sizes came from, once each, in row order. */
function sourcesOf(sheet: PilotSheet): { title: string; href: string | null }[] {
  const seen = new Map<string, { title: string; href: string | null }>()
  for (const d of sheet.dims) {
    if (d.source !== 'lookup') continue
    const href = safeUrl(d.sourceUrl)
    const id = href ?? d.sourceTitle ?? ''
    if (!seen.has(id)) seen.set(id, { title: d.sourceTitle ?? (href ? new URL(href).hostname.replace(/^www\./, '') : 'Looked up'), href })
  }
  return [...seen.values()]
}

/**
 * A dimension sheet as it stays in the conversation: a numbered row per size (the number matches its callout in the
 * drawing), where the looked-up sizes came from in the header, guesses marked, and once answered the values used and
 * which ones the person changed. With `onEdit` the rows take typed values while the sheet waits.
 */
export function SheetRecord({
  sheet,
  answer,
  bound = false,
  actionable = false,
  values,
  onEdit,
  onConfirm,
  onOpen,
}: {
  sheet: PilotSheet
  answer: PilotSheetAnswer | null
  /** Its rows drive the built design's steps. */
  bound?: boolean
  actionable?: boolean
  /** The values typed so far, by key; a row without one shows the sheet's value. */
  values?: Record<string, number> | undefined
  onEdit?: ((sheetId: string, key: string, value: number) => void) | undefined
  onConfirm?: ((sheetId: string, values: Record<string, number>) => Promise<void>) | undefined
  onOpen?: ((sheetId: string) => void) | undefined
}) {
  const [sent, setSent] = useState(false)
  const canConfirm = actionable && !answer && onConfirm !== undefined
  const canOpen = actionable && onOpen !== undefined && answer !== null && answer.confirmed && bound
  const editable = !answer && onEdit !== undefined && !sent
  const valueOf = (key: string, fallback: number): number => (answer?.confirmed ? (answer.values[key] ?? fallback) : (values?.[key] ?? fallback))
  // a guess is assumed until its row is typed in or kept with Enter, or the sheet is confirmed
  const assumed = answer?.confirmed ? [] : sheet.dims.filter((d) => d.source === 'guess' && (answer !== null || !(values && d.key in values)))
  const status = !answer && assumed.length
    ? `${assumed.length} assumed value${assumed.length === 1 ? '' : 's'}: ${assumed.map((d) => `${d.label.toLowerCase()} ${valueOf(d.key, d.value)} ${unitText(d.unit)}`).join(', ')}`
    : !answer ? 'Waiting for you to confirm' : !answer.confirmed ? 'Canceled, nothing built' : answer.changed.length ? `Confirmed with ${answer.changed.length} change${answer.changed.length === 1 ? '' : 's'}` : 'Confirmed as shown'
  return (
    <div className="lookup-rec sheet-rec" data-sheet-id={sheet.id} data-testid="mimir-sheet-record">
      <div className="sheet-rec-head">
        <span className="lookup-rec-t">
          <Icon name="tolerance" />
          <span>{sheet.title}</span>
        </span>
        {sourcesOf(sheet).map((s) =>
          s.href ? (
            <a key={s.href} className="sheet-rec-src" href={s.href} target="_blank" rel="noreferrer noopener" data-testid="mimir-sheet-source" {...tipAttrs({ title: s.title })}>
              <Icon name="log" size={13} />
              <span>Source: {s.title}</span>
              <Icon name="external" size={12} />
            </a>
          ) : (
            <span key={s.title} className="sheet-rec-src" data-testid="mimir-sheet-source">
              <Icon name="log" size={13} />
              <span>Source: {s.title}</span>
            </span>
          ),
        )}
      </div>
      <ol className="sheet-rec-rows">
        {sheet.dims.map((d, i) => {
          const used = valueOf(d.key, d.value)
          const yours = answer ? answer.changed.includes(d.key) : used !== d.value
          const guess = assumed.includes(d)
          const tag = yours ? 'yours' : d.source === 'guess' && !guess && !answer ? 'kept' : TAG[d.source]
          const id = `sheet-rec-${sheet.id}-${d.key}`
          return (
            <li key={d.key} className="sheet-rec-row" data-dim={d.key} data-source={d.source} data-guess={guess ? '' : undefined}>
              <span className="sheet-rec-n" aria-hidden="true">
                {i + 1}
              </span>
              <label className="sheet-rec-label" htmlFor={editable ? id : undefined}>
                {d.label}
                {tag ? <small className="sheet-rec-tag">{tag}</small> : null}
              </label>
              {editable ? (
                <span
                  className="sheet-rec-field"
                  onKeyDown={(e) => {
                    // Enter on a guess left as it is keeps it, the same as typing it in
                    const v = Number((e.target as HTMLInputElement).value)
                    if (e.key === 'Enter' && guess && v === used) onEdit(sheet.id, d.key, used)
                  }}
                >
                  <ScrubNumber
                    id={id}
                    value={used}
                    ariaLabel={`${d.label}, ${d.unit === 'deg' ? 'degrees' : d.unit === '%' ? 'percent' : 'millimeters'}`}
                    digits={2}
                    step={d.unit === 'deg' ? 1 : 0.5}
                    boxed={false}
                    onCommit={(v) => onEdit(sheet.id, d.key, v)}
                    {...(d.min !== undefined ? { min: d.min } : {})}
                    {...(d.max !== undefined ? { max: d.max } : {})}
                  />
                  <span className="sheet-rec-unit">{unitText(d.unit)}</span>
                </span>
              ) : (
                <span className="sheet-rec-v">
                  {used} {unitText(d.unit)}
                </span>
              )}
            </li>
          )
        })}
      </ol>
      <span className="sheet-rec-foot">
        <span className="lookup-rec-s" data-assumed={!answer && assumed.length ? '' : undefined} data-testid="mimir-sheet-status">
          {status}
        </span>
        {canConfirm ? (
          <Button
            size="sm"
            variant="primary"
            disabled={sent}
            data-testid="mimir-sheet-confirm"
            onClick={() => {
              setSent(true)
              void onConfirm(sheet.id, Object.fromEntries(sheet.dims.map((d) => [d.key, valueOf(d.key, d.value)]))).catch(() => setSent(false))
            }}
          >
            Confirm sizes and build
          </Button>
        ) : canOpen ? (
          <Button size="sm" variant="ghost" data-testid="mimir-sheet-open" onClick={() => onOpen(sheet.id)}>
            Edit sizes
          </Button>
        ) : null}
      </span>
    </div>
  )
}
