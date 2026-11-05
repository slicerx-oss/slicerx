// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Account, Partner apps: a cloud slicing token for an app someone else makes, such as a
// phone app. It slices on this account and its daily limits, sees only the jobs it queued, and never
// sends a job to a printer. The secret is shown here once, to paste into that app, and revoked here.
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { ApiToken, AuthClient } from '@slicerx/contracts'
import { PARTNER_APP_NAME_MAX } from '@slicerx/contracts'
import { Button, Chip, Icon, Input, Select } from '@slicerx/ui'
import { appName } from '../../edition'
import { toast } from '../../state/store'
import { daysLabel, expiryLabel, PARTNER_TOKEN_DAYS, partnerTokens, tokenState } from './account-logic'

export function PartnerTokens({ store, tokens, pending }: { store: Pick<AuthClient, 'createPartnerToken' | 'revokeApiToken'>; tokens: readonly ApiToken[]; pending: boolean }) {
  const client = useQueryClient()
  const [name, setName] = useState('')
  const [days, setDays] = useState<number>(90)
  const [busy, setBusy] = useState(false)
  // The secret lives in this state only until it is hidden or the page closes.
  const [made, setMade] = useState<{ app: string; secret: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const list = partnerTokens(tokens)

  const create = async () => {
    setBusy(true)
    setMade(null)
    setCopied(false)
    try {
      const r = await store.createPartnerToken({ partnerApp: name.trim(), expiresInDays: days })
      if (!r.ok) return toast(r.message, 'error')
      setMade({ app: r.value.token.partnerApp ?? r.value.token.name, secret: r.value.secret })
      setName('')
      await client.invalidateQueries({ queryKey: ['api-tokens'] })
    } finally {
      setBusy(false)
    }
  }
  const copy = async () => {
    if (!made) return
    try {
      await navigator.clipboard.writeText(made.secret)
      setCopied(true)
    } catch {
      toast('Could not copy. Select the token and copy it by hand.', 'error')
    }
  }
  const revoke = async (t: ApiToken) => {
    const r = await store.revokeApiToken(t.id)
    if (!r.ok) return toast(r.message, 'error')
    toast(`${t.partnerApp ?? t.name} can no longer slice on your account.`, 'ok')
    await client.invalidateQueries({ queryKey: ['api-tokens'] })
  }

  return (
    <section className="set-sec" aria-labelledby="ptk-h" data-testid="partner-tokens">
      <h3 id="ptk-h">Partner apps</h3>
      <p className="sx-small sx-muted">
        Let another app, such as a phone app, slice in the cloud on your account. Its slices count against your daily cloud slices. It sees only the jobs it sent, and it can't send a print to a
        printer or change anything else in your account.
      </p>
      <form
        className="ptk-form"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <label className="sr-only" htmlFor="ptk-name">
          Partner app name
        </label>
        <Input id="ptk-name" data-testid="partner-token-name" placeholder="App name" value={name} maxLength={PARTNER_APP_NAME_MAX} autoComplete="off" disabled={busy} onChange={(e) => setName(e.target.value)} />
        <label className="sr-only" htmlFor="ptk-days">
          Token lasts
        </label>
        <Select id="ptk-days" data-testid="partner-token-days" value={String(days)} disabled={busy} onChange={(e) => setDays(Number(e.target.value))}>
          {PARTNER_TOKEN_DAYS.map((d) => (
            <option key={d} value={d}>
              {daysLabel(d)}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="primary" icon="key" data-testid="partner-token-create" disabled={busy || !name.trim()}>
          {busy ? 'Working' : 'Create token'}
        </Button>
      </form>
      {made ? (
        <div className="ptk-made" role="status" data-testid="partner-token-made">
          <p>
            <Icon name="check" size={16} /> Token for {made.app}. Paste it into {made.app} now: it is shown only this once, and {appName()} keeps no copy it could show again.
          </p>
          <pre className="ptk-secret sx-mono" data-testid="partner-token-secret">
            {made.secret}
          </pre>
          <div className="row-btns">
            <Button icon={copied ? 'check' : 'copy'} data-testid="partner-token-copy" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy token'}
            </Button>
            <Button variant="ghost" data-testid="partner-token-hide" onClick={() => setMade(null)}>
              Hide token
            </Button>
          </div>
        </div>
      ) : null}
      {list.length ? (
        <ul className="tok-list" data-testid="partner-token-list">
          {list.map((t) => {
            const state = tokenState(t)
            return (
              <li key={t.id} data-state={state} data-testid="partner-token-row">
                <span className="min0">
                  <b>{t.partnerApp}</b>
                  <small className="sx-mono sx-muted">{t.prefix}...</small>
                  <small className="sx-muted">
                    Cloud slicing, {expiryLabel(t)}
                    {t.lastUsedAt ? `, last used ${new Date(t.lastUsedAt).toLocaleDateString('en-US')}` : ', never used'}
                  </small>
                </span>
                {state === 'active' ? (
                  <Button size="sm" onClick={() => void revoke(t)} aria-label={`Revoke ${t.partnerApp}`}>
                    Revoke
                  </Button>
                ) : (
                  <Chip>{state === 'revoked' ? 'Revoked' : 'Expired'}</Chip>
                )}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="sx-small sx-muted">{pending ? 'Loading partner apps.' : 'No partner app can slice on your account.'}</p>
      )}
    </section>
  )
}
