// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Obico paste box, shared by printer setup and a printer card's "Paste a new Obico address". The whole tunnel
// address goes in a masked field, like a password, and stays out of React state; below it shows only what was read:
// the tunnel host, or why the address is refused.
import { Field, Icon, Input } from '@slicerx/ui'
import { useEffect, type ReactNode } from 'react'
import type { ConnectionId } from '@slicerx/printer-catalog'
import { appName } from '../edition'
import { openLink } from '../lib/links'
import './obico-paste.css'

/** Obico's page for authorizing an app on one printer, from Obico's tunnel integration guide. It shows the tunnel address to copy. */
export function obicoAuthorizeUrl(app: string, connection: ConnectionId | null): string {
  const platform = connection === 'octoprint' ? 'OctoPrint' : 'Klipper'
  return `https://app.obico.io/tunnels/new/?app=${encodeURIComponent(app)}&platform=${platform}`
}

/**
 * The masked field with its Open Obico link, keychain hint, refusal and the host it read. `onValue` gets every change
 * of the field (typed, pasted, autofilled); the caller keeps the address out of React state.
 */
export function ObicoPasteBox({ id, connection, keychain, note, error, host, onValue, testId = 'setup-obico' }: { id: string; connection: ConnectionId | null; keychain: boolean; note: ReactNode; error: string | undefined; host: string | null; onValue: (value: string) => void; testId?: string }) {
  // A value the browser filled in before the first render reaches the caller once.
  useEffect(() => {
    const el = document.getElementById(id) as HTMLInputElement | null
    if (el?.value) onValue(el.value)
  }, [id, onValue])
  return (
    <div className="fr-obico" data-testid={testId}>
      <p className="fr-note">{note}</p>
      <Field
        htmlFor={id}
        label="Obico tunnel address"
        aside={
          <button type="button" className="fr-textbtn" onClick={() => openLink(obicoAuthorizeUrl(appName(), connection))}>
            Open Obico
          </button>
        }
        error={error}
        hint={keychain ? 'The user name and password in it go to your system keychain.' : `This browser has no system keychain, so the address is used for the test only and not saved.`}
      >
        <Input
          id={id}
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://...tunnels.app.obico.io"
          onChange={(e) => onValue(e.target.value)}
          onInput={(e) => onValue(e.currentTarget.value)}
          onBlur={(e) => onValue(e.currentTarget.value)}
          data-testid="setup-obico-paste"
          data-secret="true"
        />
      </Field>
      <p className="fr-obico-read" role="status" aria-live="polite" data-testid="setup-obico-host" hidden={!host}>
        {host ? (
          <>
            <Icon name="check" size={16} /> Connects to <span className="sx-mono">{host}</span>
          </>
        ) : null}
      </p>
    </div>
  )
}
