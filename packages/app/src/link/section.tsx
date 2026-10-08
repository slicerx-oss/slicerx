// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Printer bridge: connect to sx-link so the app reaches real printers. The desktop app starts
// its own bridge; in the browser the person runs sx-link and types the pairing code it prints. Once connected,
// the print watch is set up here too. Spoolman and other apps are in Settings, Connected apps.
import { hubFingerprint, type PrinterInfo } from '@slicerx/contracts/printers'
import { Button, Dialog, Input, Pill, Switch } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { useHost } from '../host'
import { set, toast, useApp } from '../state/store'
import { bridgeConnector, connectBridge, disconnectBridge, liveBridge } from './bridge'
import { forgetHub, hubPinned, pinnedHubKey, trustHub } from './hub-pin'
import { appName } from '../edition'

/** A hub key's fingerprint as `sx-link code` prints it, or null while it is worked out or for no key. */
export function useFingerprint(key: string | undefined): string | null {
  const [out, setOut] = useState<{ key: string; f: string | null } | null>(null)
  useEffect(() => {
    if (!key) return
    let live = true
    void hubFingerprint(key).then((f) => live && setOut({ key, f }))
    return () => {
      live = false
    }
  }, [key])
  return key && out?.key === key ? out.f : null
}

/** The code as sx-link accepts it: letters and digits only, upper case. It prints ABCD-EFGH. */
export const normalizeCode = (s: string): string => s.replace(/[^a-z0-9]/gi, '').toUpperCase()

/**
 * Print watch, per printer: whether one camera frame may go to the connected AI account for a second look when the
 * local detector is suspicious. Off by default, and it says plainly what leaves this computer.
 */
function WatchRows() {
  const host = useHost()
  const bridge = liveBridge()
  const epoch = useApp((s) => s.linkEpoch)
  const [printers, setPrinters] = useState<PrinterInfo[]>([])
  const [on, setOn] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const w = bridge?.watch
    if (!w) return
    void Promise.all([host.printers?.list() ?? Promise.resolve([]), w.huginnPrinters()]).then(
      ([list, ids]) => {
        setPrinters(list)
        setOn(new Set(ids))
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    )
  }, [bridge, host, epoch])
  if (!bridge?.watch || printers.length === 0) return null
  const change = (id: string, enabled: boolean) => {
    setError(null)
    void bridge.watch?.setHuginn(id, enabled).then(
      () => setOn((cur) => new Set(enabled ? [...cur, id] : [...cur].filter((x) => x !== id))),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    )
  }
  return (
    <div className="watch-rows">
      <h4>Print watch</h4>
      <p className="sx-small sx-muted">When the detector on this computer is suspicious, it can send one frame from the printer's camera to your connected AI account (mimir) to confirm before pausing. Nothing leaves this computer unless a printer below is on.</p>
      {printers.map((p) => (
        <div className="sx-switchrow" key={p.id}>
          <label htmlFor={`huginn-${p.id}`}>
            Let mimir confirm with one camera frame
            <small>{p.name}</small>
          </label>
          <Switch id={`huginn-${p.id}`} checked={on.has(p.id)} onChange={(v) => change(p.id, v)} />
        </div>
      ))}
      {error ? <p className="app-err" role="alert">{error}</p> : null}
    </div>
  )
}

export function BridgeSection() {
  const host = useHost()
  const status = useApp((s) => s.bridgeStatus)
  const [code, setCode] = useState('')
  const connector = bridgeConnector()
  const [confirm, setConfirm] = useState(false)
  // Read on each render: pairing writes the pin, and the status change that follows redraws this section.
  const pinned = connector !== null && !connector.automatic && hubPinned()
  const [trust, setTrust] = useState(false)
  const trustedKey = pinned ? pinnedHubKey() : undefined
  const shownKey = status.state === 'on' ? (status.hubKey ?? trustedKey) : trustedKey
  const shown = useFingerprint(shownKey)
  const presented = useFingerprint(status.state === 'error' ? status.presentedKey : undefined)
  const trustPresented = () => {
    setTrust(false)
    if (status.state !== 'error' || !status.presentedKey) return
    trustHub(status.presentedKey)
    set({ bridgeStatus: { state: 'off' } })
    toast(`${appName()} now trusts this bridge. Type the pairing code to connect.`, 'info')
  }
  if (!connector) return null
  const forget = () => {
    setConfirm(false)
    if (status.state === 'on') disconnectBridge(host)
    toast(forgetHub() ? 'Forgot the bridge. Pair again with the code sx-link prints.' : 'No bridge was remembered.', 'info')
  }
  const on = status.state === 'on'
  const busy = status.state === 'connecting'
  return (
    <section className="set-sec" aria-labelledby="bridge-h">
      <h3 id="bridge-h">Printer bridge</h3>
      <p className="sx-small sx-muted">
        {connector.automatic
          ? 'The bridge talks to your printers on this network. Approvals for starting a print, pausing and the like stay in this app.'
          : 'A small program called sx-link runs on this computer and talks to your printers. Start it, then type the pairing code it prints. It only listens on this computer.'}
      </p>
      <p>
        <Pill state={on ? 'ok' : status.state === 'error' ? 'bad' : busy ? 'run' : 'off'}>{on ? 'Connected' : busy ? 'Connecting' : status.state === 'error' ? 'Not connected' : 'Off'}</Pill>
      </p>
      {status.state === 'error' ? (
        <p className="app-err" role="alert">
          {status.message}
        </p>
      ) : null}
      {presented ? (
        <div className="bridge-forget">
          <p className="sx-small">
            The program answering on this computer has the fingerprint <span className="sx-mono">{presented}</span>
            {shown ? (
              <>
                . The bridge this browser trusts has <span className="sx-mono">{shown}</span>
              </>
            ) : null}
            . Run <span className="sx-mono">sx-link code</span> in a terminal on this computer and compare. Trust the new bridge only if it prints the same fingerprint.
          </p>
          <Button variant="ghost" size="sm" onClick={() => setTrust(true)}>
            Compare and trust
          </Button>
        </div>
      ) : null}
      {shown && !presented ? (
        <p className="sx-small sx-muted">
          Bridge fingerprint: <span className="sx-mono">{shown}</span>. Running <span className="sx-mono">sx-link code</span> on this computer prints the same one.
        </p>
      ) : null}
      {on ? (
        <Button onClick={() => disconnectBridge(host)}>Disconnect</Button>
      ) : connector.automatic ? (
        <Button variant="primary" disabled={busy} onClick={() => void connectBridge(host)}>
          Connect
        </Button>
      ) : (
        <form
          className="preset-save"
          onSubmit={(e) => {
            e.preventDefault()
            void connectBridge(host, normalizeCode(code)).then((ok) => ok && setCode(''))
          }}
        >
          <label className="sr-only" htmlFor="bridge-code">
            Pairing code
          </label>
          <Input id="bridge-code" className="sx-mono" placeholder="Pairing code, like ABCD-EFGH" value={code} maxLength={9} autoComplete="off" spellCheck={false} onChange={(e) => setCode(e.target.value)} />
          <Button type="submit" variant="primary" disabled={busy || normalizeCode(code).length !== 8}>
            Connect
          </Button>
        </form>
      )}
      {on ? <WatchRows /> : null}
      {pinned ? (
        <p className="bridge-forget">
          <span className="sx-small sx-muted">This browser remembers the bridge it paired with and sends the code to no other program.</span>
          <Button variant="ghost" size="sm" icon="unlink" onClick={() => setConfirm(true)}>
            Forget this bridge
          </Button>
        </p>
      ) : null}
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Forget this bridge?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={forget}>
              Forget this bridge
            </Button>
          </>
        }
      >
        <p>{appName()} stops checking that the bridge on this computer is the one you paired with{on ? ', and disconnects from it' : ''}. The next pairing trusts whichever program answers and remembers that one.</p>
        <p className="sx-small sx-muted">Do this after you reinstalled or moved sx-link on purpose. If you saw a warning you did not expect, leave it and check what is running on this computer first. After you pair again, check that the fingerprint shown here matches the one <span className="sx-mono">sx-link code</span> prints.</p>
      </Dialog>
      <Dialog
        open={trust}
        onClose={() => setTrust(false)}
        title="Trust this bridge?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setTrust(false)}>
              They differ
            </Button>
            <Button variant="danger" onClick={trustPresented}>
              They match, trust it
            </Button>
          </>
        }
      >
        <p>
          Open a terminal on this computer and run <span className="sx-mono">sx-link code</span>. It prints the fingerprint of the bridge installed here.
        </p>
        <p>
          The program answering now shows: <span className="sx-mono">{presented}</span>
        </p>
        <p className="sx-small sx-muted">If they match, you reinstalled or moved the bridge, and {appName()} sends the pairing code to this one only. If they differ, something else is answering on the bridge's port: keep the old one and check what is running on this computer.</p>
      </Dialog>
    </section>
  )
}
