// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PilotLookup } from '@slicerx/contracts'
import { Icon } from '@slicerx/ui'

/** What mimir looked up, as it stays in the conversation: the title, its rows and the source link. */
export function LookupRecord({ lookup }: { lookup: PilotLookup }) {
  return (
    <div className="lookup-rec" data-lookup-id={lookup.id}>
      <div className="lookup-rec-t">
        <Icon name="search" />
        <span>{lookup.title}</span>
      </div>
      <dl className="lookup-rec-f">
        {lookup.fields.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <a className="lookup-rec-s" href={lookup.source.url} target="_blank" rel="noreferrer noopener">
        {lookup.source.title}
      </a>
    </div>
  )
}
