// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PilotSheet, PilotSheetAnswer } from '@slicerx/contracts'
import { Button, Icon } from '@slicerx/ui'
import { useState } from 'react'
import { safeUrl } from './citations'

const SOURCE: Record<PilotSheet['dims'][number]['source'], string> = { asked: 'you said', lookup: 'looked up', photo: 'from your photo', guess: 'guess' }

/**
 * A dimension sheet as it stays in the conversation: each size with its unit and where it came from, guesses marked,
 * and once answered the values used and which ones the person changed. Editing it happens on the sheet itself.
 */
export function SheetRecord({
  sheet,
  answer,
  bound = false,
  actionable = false,
  onConfirm,
  onOpen,
}: {
  sheet: PilotSheet
  answer: PilotSheetAnswer | null
  /** Its rows drive the built design's steps. */
  bound?: boolean
  actionable?: boolean
  onConfirm?: ((sheetId: string, values: Record<string, number>) => Promise<void>) | undefined
  onOpen?: ((sheetId: string) => void) | undefined
}) {
  const [sent, setSent] = useState(false)
  const canConfirm = actionable && !answer && onConfirm !== undefined && onOpen === undefined
  const canOpen = actionable && onOpen !== undefined && (!answer || (answer.confirmed && bound))
  const status = !answer ? 'Waiting for you to confirm' : !answer.confirmed ? 'Canceled, nothing built' : answer.changed.length ? `Confirmed with ${answer.changed.length} change${answer.changed.length === 1 ? '' : 's'}` : 'Confirmed as shown'
  return (
    <div className="lookup-rec" data-sheet-id={sheet.id} data-testid="mimir-sheet-record">
      <div className="lookup-rec-t">
        <Icon name="tolerance" />
        <span>{sheet.title}</span>
      </div>
      <dl className="lookup-rec-f">
        {sheet.dims.map((d) => {
          const used = answer?.confirmed ? (answer.values[d.key] ?? d.value) : d.value
          const href = d.source === 'lookup' ? safeUrl(d.sourceUrl) : null
          return (
            <div key={d.key} data-dim={d.key} data-guess={d.source === 'guess' && !answer?.confirmed ? '' : undefined}>
              <dt>{d.label}</dt>
              <dd>
                {used} {d.unit === 'deg' ? '°' : d.unit}{' '}
                <small className="sx-muted">
                  {answer?.changed.includes(d.key) ? 'you changed it' : href ? <a href={href} target="_blank" rel="noreferrer noopener">{d.sourceTitle ?? SOURCE.lookup}</a> : SOURCE[d.source]}
                </small>
              </dd>
            </div>
          )
        })}
      </dl>
      {canConfirm ? (
        <Button
          size="sm"
          disabled={sent}
          data-testid="mimir-sheet-confirm"
          onClick={() => {
            setSent(true)
            void onConfirm(sheet.id, Object.fromEntries(sheet.dims.map((d) => [d.key, d.value]))).catch(() => setSent(false))
          }}
        >
          Build with these sizes
        </Button>
      ) : (
        <span className="sheet-rec-foot">
          <span className="lookup-rec-s">{status}</span>
          {canOpen ? (
            <Button size="sm" variant="ghost" data-testid="mimir-sheet-open" onClick={() => onOpen(sheet.id)}>
              {answer ? 'Edit sizes' : 'Check sizes'}
            </Button>
          ) : null}
        </span>
      )}
    </div>
  )
}
