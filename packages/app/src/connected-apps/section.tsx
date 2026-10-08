// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Connected apps: services on this network that SlicerX works with, each added once. The hub
// keeps the address; a key goes to the secrets store and only its name is kept. Spoolman moved here from
// Printer bridge with its behavior unchanged. A printer that goes through an app (BamBuddy) can choose it
// as its connection once the app is added.
import { Button, Input, Pill } from '@slicerx/ui'
import { useCallback, useEffect, useState } from 'react'
import { useHost } from '../host'
import { SpoolmanRows } from '../inventory/spoolman-settings'
import { liveBridge, type BridgeServices } from '../link/bridge'
import { set, toast, useApp } from '../state/store'
import { appKeyName, appUrl, connectedApp, type ConnectedApp } from './registry'
import { refreshConnectedApps, useConnectedApps } from './state'

type Check = { state: 'idle' } | { state: 'busy' } | { state: 'ok'; printers: number } | { state: 'bad'; message: string }

/** Why an app did not answer, in plain words. */
export function checkReason(app: ConnectedApp, e: unknown): string {
  const t = e instanceof Error ? e.message : String(e)
  if (/401|403|unauthori[sz]ed|forbidden|api key|auth/i.test(t)) return `${app.name} refused the API key. Make a new key in ${app.name} and enter it again.`
  if (/unreachable|connect|timed out|timeout|refused/i.test(t)) return `${app.name} did not answer at that address. Check the address and port, and that ${app.name} is running.`
  return t || `${app.name} did not answer.`
}

export function ConnectedAppsSection() {
  const on = useApp((s) => s.bridgeStatus.state === 'on')
  useConnectedApps()
  const services = on ? liveBridge()?.services : undefined
  return (
    <section className="set-sec" aria-labelledby="apps-h" data-testid="connected-apps">
      <h3 id="apps-h">Connected apps</h3>
      <p className="sx-small sx-muted">Apps on your network that SlicerX works with. Add one once; its address stays on this computer and a key goes to the system keychain. Printers and spools work as before until you add an app.</p>
      {services ? (
        <>
          <BambuddyRows services={services} />
          <div className="watch-rows" data-testid="connected-app-spoolman">
            <SpoolmanRows services={services} />
          </div>
        </>
      ) : (
        <p className="sx-small">
          Connected apps go through the printer bridge.{' '}
          <Button variant="ghost" size="sm" onClick={() => set({ settingsSection: 'bridge' })}>
            Connect the printer bridge
          </Button>
        </p>
      )}
    </section>
  )
}

function BambuddyRows({ services }: { services: BridgeServices }) {
  const app = connectedApp('bambuddy')!
  const host = useHost()
  const apps = useApp((s) => s.connectedApps)
  const saved = apps.find((a) => a.id === app.id) ?? null
  const [editing, setEditing] = useState(false)
  const [address, setAddress] = useState('')
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState<Check>({ state: 'idle' })

  const test = useCallback(async () => {
    if (!services.check) return
    setCheck({ state: 'busy' })
    try {
      const r = await services.check('bambuddy')
      setCheck({ state: 'ok', printers: r.printers })
    } catch (e) {
      setCheck({ state: 'bad', message: checkReason(app, e) })
    }
  }, [services, app])

  const savedUrl = saved?.baseUrl
  useEffect(() => {
    if (savedUrl) void test()
    else setCheck({ state: 'idle' })
  }, [savedUrl, test])

  const startEdit = () => {
    setAddress(saved ? saved.baseUrl.replace(/^http:\/\//, '') : '')
    setKey('')
    setError(null)
    setEditing(true)
  }

  const save = async () => {
    setError(null)
    const r = appUrl(app, address)
    if ('error' in r) return setError(r.error)
    const typed = key.trim()
    if (!typed && !saved?.hasSecret) return setError(`Enter the ${app.name} API key.`)
    setBusy(true)
    try {
      const name = appKeyName(app.id)
      if (typed) await host.secrets.set(name, typed)
      await services.configure('bambuddy', r.url, name)
      await refreshConnectedApps()
      setEditing(false)
      setKey('')
      toast(saved ? `Saved ${app.name}.` : `Added ${app.name}. Its printers can choose it as their connection.`, 'info')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setError(null)
    try {
      await services.remove('bambuddy')
      await host.secrets.delete(appKeyName(app.id)).catch(() => undefined)
      await refreshConnectedApps()
      setEditing(false)
      toast(`Removed ${app.name}.`, 'info')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const form = (
    <form
      className="preset-save app-form"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label className="sr-only" htmlFor="bambuddy-url">
        {app.name} address
      </label>
      <Input id="bambuddy-url" data-testid="connected-app-bambuddy-address" className="sx-mono" placeholder={app.addressPlaceholder} value={address} autoComplete="off" spellCheck={false} onChange={(e) => setAddress(e.target.value)} />
      <label className="sr-only" htmlFor="bambuddy-key">
        {app.name} {app.key!.label}
      </label>
      <Input id="bambuddy-key" data-testid="connected-app-bambuddy-key" type="password" placeholder={saved?.hasSecret ? 'API key (leave empty to keep the saved one)' : app.key!.placeholder} value={key} autoComplete="off" spellCheck={false} onChange={(e) => setKey(e.target.value)} />
      <Button type="submit" variant="primary" data-testid="connected-app-bambuddy-save" disabled={busy || !address.trim()}>
        {saved ? 'Save' : `Add ${app.name}`}
      </Button>
      {saved ? (
        <Button variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      ) : null}
    </form>
  )

  return (
    <div className="watch-rows" data-testid="connected-app-bambuddy">
      <h4>{app.name}</h4>
      <p className="sx-small sx-muted">{app.blurb}</p>
      {saved && !editing ? (
        <>
          <p>
            <Pill data-testid="connected-app-bambuddy-status" state={check.state === 'ok' ? 'ok' : check.state === 'bad' ? 'bad' : check.state === 'busy' ? 'run' : 'off'}>
              {check.state === 'ok' ? 'Connected' : check.state === 'bad' ? 'Not answering' : check.state === 'busy' ? 'Testing' : 'Added'}
            </Pill>{' '}
            <span className="sx-small sx-mono">{saved.baseUrl}</span>
          </p>
          {check.state === 'ok' ? <p className="sx-small sx-muted">{check.printers === 1 ? '1 printer' : `${check.printers} printers`} in {app.name}.</p> : null}
          {check.state === 'bad' ? (
            <p className="app-err" role="alert">
              {check.message}
            </p>
          ) : null}
          <p className="bridge-forget app-actions">
            {services.check ? (
              <Button size="sm" data-testid="connected-app-bambuddy-test" disabled={check.state === 'busy'} onClick={() => void test()}>
                Test connection
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" data-testid="connected-app-bambuddy-edit" onClick={startEdit}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" className="app-remove" data-testid="connected-app-bambuddy-remove" onClick={() => void remove()}>
              Remove {app.name}
            </Button>
          </p>
        </>
      ) : (
        form
      )}
      {error ? (
        <p className="app-err" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
