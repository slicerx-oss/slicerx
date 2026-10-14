// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One line blocks: the permission note, Auto's model switch, errors, the plan and the integrations a reply used.
import { Icon } from '@slicerx/ui'
import { useContext } from 'react'
import { USAGE_CODES, UsageLinkContext } from './usage-link'

/** What the Permissions setting decided for a step mimir did not ask about. */
export function PermLine({ mode, message }: { mode: 'allow' | 'off'; message: string }) {
  return <div className={mode === 'allow' ? 'perm-ln ok' : 'perm-ln warn'}>{message}</div>
}

/** Auto moved the run to another model; one short line, so the person knows what it costs. */
export function ModelLine({ label, reason }: { label: string; reason: 'request' | 'tool' | 'struggle' }) {
  return <div className="model-ln" data-testid="mimir-model-switch">{reason === 'request' ? `Using ${label} for this one.` : `Switched to ${label} for the harder part.`}</div>
}

/** `code` marks a mimir cloud refusal (`day_used`, `paused`, ...) for the limit hook. A used-up allowance links to the
 * usage page when the host has one. */
export function ErrorLine({ message, code }: { message: string; code?: string | undefined }) {
  const seeUsage = useContext(UsageLinkContext)
  return (
    <div className="pp-err" role="alert" data-testid={code ? 'mimir-limit' : undefined} data-code={code}>
      <Icon name="alert" />
      <span>
        {message}
        {seeUsage && code && USAGE_CODES.has(code) && (
          <>
            {' '}
            <button type="button" className="pp-err-link" data-testid="mimir-see-usage" onClick={seeUsage}>
              See usage
            </button>
          </>
        )}
      </span>
    </div>
  )
}

export function PlanList({ steps }: { steps: string[] }) {
  return (
    <ol className="plan" aria-label="Plan">
      {steps.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ol>
  )
}

/** One small pill under a reply that used an integration, naming the ones it used. Nothing when it used none. */
export function UsedLine({ names }: { names: string[] }) {
  if (!names.length) return null
  return (
    <div className="meta-ln used">
      <span className="used-pill">
        <Icon name="check" />
        {names.join(', ')}
      </span>
    </div>
  )
}
