// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Connect your AI agent, Partner app: a named key for another app on this computer (LayerMate is
// the first). The hub makes it and keeps only its hash; it is shown here once, to copy into that
// app, and listed in Settings, Printer bridge, Devices, where it is revoked.
import { Button, Icon, Input } from '@slicerx/ui'
import { useState } from 'react'
import { liveBridge } from '../link/bridge'
import { useApp } from '../state/store'
import { appName } from '../edition'

export function PartnerKeyRows({ idPrefix }: { idPrefix: string }) {
  const on = useApp((s) => s.bridgeStatus.state === 'on')
  const clients = on ? (liveBridge()?.clients ?? null) : null
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  // The key lives in this state only until it is hidden or the panel closes.
  const [made, setMade] = useState<{ name: string; key: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const create = async () => {
    if (!clients) return
    const n = name.trim()
    setBusy(true)
    setError(null)
    setMade(null)
    setCopied(false)
    try {
      const r = await clients.createPartner(n)
      setMade({ name: n, key: r.clientKey })
      setName('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!made) return
    try {
      await navigator.clipboard.writeText(made.key)
      setCopied(true)
    } catch {
      setError('Could not copy. Select the key and copy it by hand.')
    }
  }

  return (
    <>
      <form
        className="ag-act"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <label className="sr-only" htmlFor={`${idPrefix}-partner-name`}>
          Partner app name
        </label>
        <Input id={`${idPrefix}-partner-name`} data-testid="partner-name" placeholder="App name, like LayerMate" value={name} maxLength={80} autoComplete="off" disabled={!clients || busy} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="primary" icon="key" data-testid="partner-create" disabled={!clients || busy || !name.trim()}>
          {busy ? 'Working' : 'Create key'}
        </Button>
        <span className="ag-what">{clients ? 'A key for another app on this computer that works with your printers. It is shown once.' : `Connect the printer bridge first, in Settings, Printer bridge. The key works through it.`}</span>
      </form>
      {made ? (
        <div className="ag-result ok" role="status" data-testid="partner-made">
          <p>
            <Icon name="check" size={16} /> Key for {made.name}. Paste it into {made.name} now: it is shown only this once, and {appName()} keeps no copy it could show again.
          </p>
          <pre className="ag-paste sx-mono" data-testid="partner-key">
            {made.key}
          </pre>
          <p className="ag-into">Revoke it any time in Settings, Printer bridge, Devices.</p>
          <div className="ag-act ag-keybtns">
            <Button icon={copied ? 'check' : 'copy'} data-testid="partner-copy" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy key'}
            </Button>
            <Button variant="ghost" data-testid="partner-hide" onClick={() => setMade(null)}>
              Hide key
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="ag-result bad" role="alert">
          <p>
            <Icon name="alert" size={16} /> {error}
          </p>
        </div>
      ) : null}
    </>
  )
}
