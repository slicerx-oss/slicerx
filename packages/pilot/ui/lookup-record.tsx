// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PilotLookup } from '@slicerx/contracts'
import { Icon } from '@slicerx/ui'
import { safeUrl } from './citations'

/** What mimir looked up, as it stays in the conversation: the title, its rows and the source link, when it has one. */
export function LookupRecord({ lookup }: { lookup: PilotLookup }) {
  const href = lookup.source ? safeUrl(lookup.source.url) : undefined
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
      {!lookup.source ? null : href ? (
        <a className="lookup-rec-s" href={href} target="_blank" rel="noreferrer noopener">
          {lookup.source.title}
        </a>
      ) : (
        <span className="lookup-rec-s">{lookup.source.title}</span>
      )}
    </div>
  )
}
