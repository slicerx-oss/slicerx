// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { Fragment } from 'react'
import type { SettingsDiff } from '@slicerx/contracts'

function withUnit(value: string, unit: string | undefined): string {
  if (!unit || value.endsWith(unit)) return value
  return `${value} ${unit}`
}

/** A settings diff: removed and added lines per key, each with the reason and its sources. */
export function Diff({ diff }: { diff: SettingsDiff }) {
  return (
    <div className="diff">
      <div className="diff-h">{diff.title}</div>
      {diff.rows.map((r) => (
        <Fragment key={r.key}>
          {r.before !== null ? (
            <div className="drow del">
              <span aria-hidden="true">-</span>
              <span className="vh">Before:</span>
              <span className="dk" title={r.label}>
                {r.key}
              </span>
              <span className="dv">{withUnit(r.before, r.unit)}</span>
            </div>
          ) : null}
          <div className="drow add">
            <span aria-hidden="true">+</span>
            <span className="vh">{r.before === null ? 'New:' : 'After:'}</span>
            <span className="dk" title={r.label}>
              {r.key}
            </span>
            <span className="dv">{withUnit(r.after, r.unit)}</span>
          </div>
          {r.reason || (r.sources && r.sources.length > 0) ? (
            <div className="dwhy">
              {r.reason}
              {r.sources && r.sources.length > 0 ? <span className="dsrc">{r.sources.join(', ')}</span> : null}
            </div>
          ) : null}
        </Fragment>
      ))}
    </div>
  )
}
