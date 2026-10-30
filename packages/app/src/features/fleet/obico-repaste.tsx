// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A new Obico address for a printer already reached through Obico, for when its access was removed or revoked in
// Obico: the same masked paste box and the same parse as setup. Saving hands only the new tunnel host and its user
// name and password to the bridge, which keeps the printer's id, jobs, name and settings. The address itself never
// enters React state, the app store or a log. A person does this in the app; no agent or client path sets it.
import { parseTunnelEndpoint, TUNNEL_PROBLEM_TEXT, type PrinterStatus } from '@slicerx/contracts'
import { Button, Dialog, Steady } from '@slicerx/ui'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useId, useRef, useState } from 'react'
import { appName } from '../../edition'
import { useHost } from '../../host'
import { ObicoPasteBox } from '../../first-run/obico-paste'
import { registeredPrinterSetup } from '../../first-run/setup-registry'
import { readTunnelPaste, tunnelPasteError, type TunnelPaste } from '../../first-run/tunnel-paste'
import type { FleetRow } from '../../lib/queries'
import { toast } from '../../state/store'

/** The action's name, on the card menu and on the card of a printer whose Obico access is gone. */
export const REPASTE_LABEL = 'Paste a new Obico address'

/** Tunnel problems a new address fixes: no access stored here, or access removed in Obico. */
const FIXED_BY_NEW_ADDRESS: ReadonlySet<PrinterStatus['tunnelProblem']> = new Set(['no_access', 'access_removed'])

/** Where a printer card offers a new Obico address: in its menu for any printer reached through Obico, and on the card itself when the access is gone. */
export function offersRepaste(r: FleetRow): { menu: boolean; pointer: boolean } {
  const menu = Boolean(r.tunnel)
  return { menu, pointer: menu && FIXED_BY_NEW_ADDRESS.has(r.status.tunnelProblem) }
}

/**
 * The card's line for a printer whose Obico access is gone: the problem's first sentence only, since the line under it
 * points to the fix. Elsewhere (clients, a failed test) the problem keeps both sentences.
 */
export function repasteCardText(problem: 'no_access' | 'access_removed'): string {
  return TUNNEL_PROBLEM_TEXT[problem].split(/(?<=\.)\s+/)[0] ?? TUNNEL_PROBLEM_TEXT[problem]
}

const SAVE_FORMS = ['Save address', 'Saving']

export function ObicoRepaste({ printer, open, onClose }: { printer: FleetRow; open: boolean; onClose: () => void }) {
  const host = useHost()
  const qc = useQueryClient()
  const id = useId()
  const fieldId = `${id}-tunnel`
  const formId = `${id}-form`
  const setup = registeredPrinterSetup()?.(host) ?? null
  const setTunnel = setup?.setTunnel
  const keychain = setup?.keychain ?? host.capabilities.secureStorage === true
  // The pasted address carries the password: it stays here and in the masked field, never in state.
  const raw = useRef('')
  const [read, setRead] = useState<TunnelPaste | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const onValue = useCallback((value: string) => {
    raw.current = value
    setFailed(null)
    setRead(readTunnelPaste(value))
  }, [])
  const error = read ? tunnelPasteError(read) : undefined
  const tunnelHost = read && 'host' in read && !error ? read.host : null
  const ready = Boolean(setTunnel) && tunnelHost !== null && !saving

  const clear = () => {
    raw.current = ''
    const el = document.getElementById(fieldId) as HTMLInputElement | null
    if (el) el.value = ''
    setRead(undefined)
    setFailed(null)
  }
  const close = () => {
    if (saving) return
    clear()
    onClose()
  }
  const save = async () => {
    if (!ready || !setTunnel) return
    const parsed = parseTunnelEndpoint(raw.current)
    if (!parsed.ok || !parsed.credential) return
    setSaving(true)
    setFailed(null)
    try {
      const out = await setTunnel(printer.id, { address: parsed.host, credential: parsed.credential })
      clear()
      onClose()
      if (out.credentialKept === 'session') toast(`${appName()} could not store the Obico access in your system keychain, so it is kept only until ${appName()} closes.`, 'warn')
      else toast(`${printer.name} now connects through ${out.host}.`, 'ok')
      await qc.invalidateQueries({ queryKey: ['fleet'] })
    } catch (e) {
      // The bridge's own words may name what was sent; the dialog says only that nothing changed.
      const plain = (e as { name?: string } | null)?.name === 'SetupError' && e instanceof Error ? ` ${e.message}` : ''
      setFailed(`The new address was not saved. Nothing changed.${plain}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={REPASTE_LABEL}
      testId="printer-repaste"
      footer={
        <>
          <Button onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" icon="paste" type="submit" form={formId} disabled={!ready} data-testid="printer-repaste-save">
            <Steady text={saving ? 'Saving' : 'Save address'} forms={SAVE_FORMS} />
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="wall-repaste"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <ObicoPasteBox
          id={fieldId}
          connection={printer.plugin === 'octoprint' ? 'octoprint' : 'moonraker'}
          keychain={keychain}
          note={`Authorize ${appName()} for ${printer.name} in Obico again, then paste the address it shows. The printer keeps its name, jobs and settings.`}
          error={error}
          host={tunnelHost}
          onValue={onValue}
          testId="printer-repaste-box"
        />
        {setTunnel ? null : (
          <p className="app-err" role="alert">
            This printer bridge cannot take a new Obico address. Update the app.
          </p>
        )}
        {failed ? (
          <p className="app-err" role="alert">
            {failed}
          </p>
        ) : null}
      </form>
    </Dialog>
  )
}
