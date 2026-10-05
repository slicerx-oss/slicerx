// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { Fragment } from 'react'
import { Icon } from '@slicerx/ui'
import { fmtDuration } from './format'

export interface SummaryProps {
  title: string
  rows: [string, string][]
  stopped: boolean
  ms: number | null
}

/** The run's closing card: green with a check when done, orange with the alert icon when stopped. */
export function Summary({ title, rows, stopped, ms }: SummaryProps) {
  return (
    <div className="sum">
      <div className={stopped ? 'sum-h stop' : 'sum-h'}>
        <Icon name={stopped ? 'alert' : 'check'} />
        <span>{title}</span>
        {ms !== null ? <span className="dur">{`${stopped ? 'stopped after' : 'done in'} ${fmtDuration(ms)}`}</span> : null}
      </div>
      {rows.length > 0 ? (
        <div className="kv">
          {rows.map(([k, v], i) => (
            <Fragment key={i}>
              <span className="k">{k}</span>
              <span className="v">{v}</span>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  )
}
