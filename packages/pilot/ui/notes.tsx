// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One line blocks: the permission note, errors, the plan and the plugins loading line.
import type { PluginLoad } from '@slicerx/contracts'
import { Icon } from '@slicerx/ui'
import { Spinner } from './spinner'

/** What the Permissions setting decided for a step mimir did not ask about. */
export function PermLine({ mode, message }: { mode: 'allow' | 'off'; message: string }) {
  return <div className={mode === 'allow' ? 'perm-ln ok' : 'perm-ln warn'}>{message}</div>
}

export function ErrorLine({ message }: { message: string }) {
  return (
    <div className="pp-err" role="alert">
      <Icon name="alert" />
      <span>{message}</span>
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

/** A quiet line at run start: each plugin with a spinner that becomes a check, or "off". */
export function PluginsLoading({ plugins }: { plugins: PluginLoad[] }) {
  const loading = plugins.some((p) => p.state === 'loading')
  return (
    <div className="meta-ln plugs" aria-busy={loading || undefined}>
      <span>{loading ? 'Loading plugins' : 'Plugins'}</span>
      {plugins.map((p) => (
        <span key={p.id} className={`plug ${p.state}`}>
          {p.state === 'loading' ? (
            <Spinner className="pst" />
          ) : p.state === 'ready' ? (
            <span className="pst">
              <Icon name="check" />
            </span>
          ) : p.state === 'error' ? (
            <span className="pst">
              <Icon name="alert" />
            </span>
          ) : null}
          {p.name}
          {p.state === 'off' ? <span className="poff">off</span> : null}
          {p.state === 'error' ? <span className="vh">failed to load</span> : null}
        </span>
      ))}
    </div>
  )
}
