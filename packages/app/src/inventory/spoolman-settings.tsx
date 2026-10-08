// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Connected apps > Spoolman: point the bridge at a Spoolman server on this network, test it,
// see whether it answers, remove it. The address is all the app sends; Spoolman needs no key. Once it
// answers, the Filament dialog shows the spools and the grams left.
import { Button, Input, Pill } from '@slicerx/ui'
import { useCallback, useEffect, useState } from 'react'
import { useHost } from '../host'
import type { BridgeServices } from '../link/bridge'
import { toast, useApp } from '../state/store'
import { loadSpools, parseSpools } from './spools'
import { refreshConnectedApps } from '../connected-apps/state'

/** Spoolman's own default port. */
export const SPOOLMAN_PORT = 7912

/**
 * The address as the bridge takes it: `http://host:port` with no trailing slash. A bare host gets
 * `http://` and Spoolman's port 7912. Spoolman serves plain http on a home network; https is refused.
 */
export function spoolmanUrl(input: string): { url: string } | { error: string } {
  let t = input.trim().replace(/\/+$/, '')
  if (!t) return { error: 'Type the address of your Spoolman server.' }
  if (/^https:\/\//i.test(t)) return { error: 'Use the plain http:// address of Spoolman on your network.' }
  if (!/^[a-z]+:\/\//i.test(t)) t = `http://${t}`
  if (!/^http:\/\//i.test(t)) return { error: 'The address must start with http://.' }
  let u: URL
  try {
    u = new URL(t)
  } catch {
    return { error: 'That is not an address, like 192.168.1.50 or spoolman.local:7912.' }
  }
  if (u.pathname !== '/' && u.pathname !== '') return { error: 'Use the server address only, without a path.' }
  return { url: `http://${u.hostname}${u.port ? `:${u.port}` : `:${SPOOLMAN_PORT}`}` }
}

type Check = { state: 'idle' } | { state: 'busy' } | { state: 'ok'; spools: number } | { state: 'bad'; message: string }

const reason = (e: unknown): string => {
  const t = e instanceof Error ? e.message : String(e)
  if (/unreachable|connect|timed out|timeout/i.test(t)) return 'Spoolman did not answer at that address. Check the address and port, and that the server is on.'
  return t || 'Spoolman did not answer.'
}

export function SpoolmanRows({ services }: { services: BridgeServices }) {
  const host = useHost()
  const epoch = useApp((s) => s.linkEpoch)
  const [saved, setSaved] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [check, setCheck] = useState<Check>({ state: 'idle' })
  const [error, setError] = useState<string | null>(null)

  const test = useCallback(async () => {
    setCheck({ state: 'busy' })
    try {
      const spools = parseSpools(await host.printers?.callTool('spoolman', 'list_spools', {}))
      setCheck({ state: 'ok', spools: spools.length })
      await loadSpools(host)
    } catch (e) {
      setCheck({ state: 'bad', message: reason(e) })
    }
  }, [host])

  useEffect(() => {
    let live = true
    void services.list().then(
      (list) => {
        if (!live) return
        const s = list.find((x) => x.pluginId === 'spoolman')
        setSaved(s?.baseUrl ?? null)
        if (s) void test()
      },
      () => live && setSaved(null),
    )
    return () => {
      live = false
    }
  }, [services, epoch, test])

  const add = async () => {
    setError(null)
    const r = spoolmanUrl(address)
    if ('error' in r) return setError(r.error)
    try {
      await services.configure('spoolman', r.url)
      setSaved(r.url)
      void refreshConnectedApps()
      setAddress('')
      await test()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async () => {
    setError(null)
    try {
      await services.remove('spoolman')
      setSaved(null)
      void refreshConnectedApps()
      setCheck({ state: 'idle' })
      await loadSpools(host)
      toast('Removed Spoolman.', 'info')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="watch-rows spoolman-rows">
      <h4>Spoolman</h4>
      <p className="sx-small sx-muted">Spoolman keeps track of your spools. Connect it to pick a spool for each filament slot, see the grams left, get a warning when a spool is too short for the plate, and record the filament a print used (you approve each one).</p>
      {saved ? (
        <>
          <p>
            <Pill state={check.state === 'ok' ? 'ok' : check.state === 'bad' ? 'bad' : check.state === 'busy' ? 'run' : 'off'}>{check.state === 'ok' ? 'Connected' : check.state === 'bad' ? 'Not answering' : check.state === 'busy' ? 'Testing' : 'Added'}</Pill>{' '}
            <span className="sx-small sx-mono">{saved}</span>
          </p>
          {check.state === 'ok' ? <p className="sx-small sx-muted">{check.spools === 1 ? '1 spool' : `${check.spools} spools`} in Spoolman.</p> : null}
          {check.state === 'bad' ? (
            <p className="app-err" role="alert">
              {check.message}
            </p>
          ) : null}
          <p className="bridge-forget app-actions">
            <Button size="sm" disabled={check.state === 'busy'} onClick={() => void test()}>
              Test connection
            </Button>
            <Button variant="ghost" size="sm" className="app-remove" onClick={() => void remove()}>
              Remove Spoolman
            </Button>
          </p>
        </>
      ) : (
        <form
          className="preset-save app-form"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <label className="sr-only" htmlFor="spoolman-url">
            Spoolman address
          </label>
          <Input id="spoolman-url" className="sx-mono" placeholder="Address, like 192.168.1.50" value={address} autoComplete="off" spellCheck={false} onChange={(e) => setAddress(e.target.value)} />
          <Button type="submit" variant="primary" disabled={!address.trim()}>
            Add Spoolman
          </Button>
        </form>
      )}
      {error ? (
        <p className="app-err" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
