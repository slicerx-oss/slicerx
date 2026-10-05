// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings, Phone access: the Remote access switch with the hub's status and the relay's quota.
import { Button, Pill, Switch } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { quotaText, useRemoteAccess, useRemoteState } from './remote'
import { appName } from '../../edition'

export function RemoteRows() {
  const remote = useRemoteAccess()
  const { status, busy, error } = useRemoteState(remote)
  const on = status?.enabled === true
  // Status and quota are read when the section opens and every 15 s while remote access is on.
  useEffect(() => {
    if (!remote) return
    void remote.refresh()
    if (!on) return
    const t = window.setInterval(() => void remote.refresh(), 15_000)
    return () => window.clearInterval(t)
  }, [remote, on])
  return (
    <>
      <div className="sx-switchrow">
        <label htmlFor="remote-access">
          Remote access
          <small>Lets your paired phones reach your printers away from home, also while this app is closed. Everything is sealed between the phone and this computer; the relay only passes it along. Off by default.</small>
        </label>
        <Switch id="remote-access" checked={on} disabled={!remote || busy} onChange={(v) => void remote?.setEnabled(v)} />
      </div>
      {!remote ? <p className="sx-small sx-muted">Connect the printer bridge to turn this on. The bridge is what answers your phone.</p> : null}
      {error ? (
        <p className="app-err" role="alert">
          Remote access: {error}
        </p>
      ) : null}
      {on && status ? (
        <div className="remote-status" role="status">
          <Pill state={status.connected ? 'ok' : status.lastError ? 'bad' : 'run'}>{status.connected ? 'Reachable' : status.lastError ? 'Not reachable' : 'Connecting'}</Pill>
          <span className="sx-small">
            {status.pairings} {status.pairings === 1 ? 'phone' : 'phones'} can reach it, {status.sessions} connected now.
          </span>
          {status.lastError && !status.connected ? <span className="sx-small sx-muted">The relay said: {status.lastError}</span> : null}
          <span className="sx-small sx-muted">{status.signedIn ? `Signed in to your ${appName()} account, so the relay uses your account allowance.` : 'Not signed in, so the relay uses the shared allowance for this network.'}</span>
          {status.quota ? <span className="sx-small sx-muted">{quotaText(status.quota)}</span> : null}
        </div>
      ) : null}
    </>
  )
}

/** Phones removed here that the hub has not confirmed yet, with a retry. Shown under Paired phones. */
export function PendingRemovals() {
  const remote = useRemoteAccess()
  const { pendingRemovals } = useRemoteState(remote)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!remote || !pendingRemovals?.length) return null
  const n = pendingRemovals.length
  return (
    <div className="remote-status" role="status">
      <Pill state="run">Removal pending</Pill>
      <span className="sx-small">
        {n === 1 ? '1 phone was' : `${n} phones were`} removed here, but the hub has not confirmed it yet, so {n === 1 ? 'it' : 'they'} can still reach your printers until it does.
      </span>
      <Button
        size="sm"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setFailed(false)
          remote
            .sync()
            .catch(() => setFailed(true))
            .finally(() => setBusy(false))
        }}
      >
        Retry removal
      </Button>
      {failed ? <span className="sx-small sx-muted">The hub is not reachable. It is retried every few minutes.</span> : null}
    </div>
  )
}
