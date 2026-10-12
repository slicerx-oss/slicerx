// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PilotSheet, PilotSheetAnswer } from '@slicerx/contracts'
import { Icon } from '@slicerx/ui'
import { safeUrl } from './citations'

const SOURCE: Record<PilotSheet['dims'][number]['source'], string> = { asked: 'you said', lookup: 'looked up', photo: 'from your photo', guess: 'guess' }

/**
 * A dimension sheet as it stays in the conversation: each size with its unit and where it came from, guesses marked,
 * and once answered the values used and which ones the person changed. Editing it happens on the sheet itself.
 */
export function SheetRecord({ sheet, answer }: { sheet: PilotSheet; answer: PilotSheetAnswer | null }) {
  return (
    <div className="lookup-rec" data-sheet-id={sheet.id} data-testid="mimir-sheet-record">
      <div className="lookup-rec-t">
        <Icon name="tolerance" />
        <span>{sheet.title}</span>
      </div>
      <dl className="lookup-rec-f">
        {sheet.dims.map((d) => {
          const used = answer?.values[d.key] ?? d.value
          const href = d.source === 'lookup' ? safeUrl(d.sourceUrl) : null
          return (
            <div key={d.key} data-dim={d.key} data-guess={d.source === 'guess' && !answer ? '' : undefined}>
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
      <span className="lookup-rec-s">{answer ? (answer.changed.length ? `Confirmed with ${answer.changed.length} change${answer.changed.length === 1 ? '' : 's'}` : 'Confirmed as shown') : 'Waiting for you to confirm'}</span>
    </div>
  )
}
