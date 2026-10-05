// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings > Account: your data, deleting the account, and API tokens.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button, Chip, Dialog } from '@slicerx/ui'
import { appName, toast, useEdition, useHost } from '@slicerx/app'
import { activeTokens, deletionBanner, exportFileName, graceLabel, rateLabel, revokedLabel, tokenState } from './account-logic'
import { useSession, useStore } from './queries'
import { creatorUrl, dashboardUrl, openExternal, privacyUrl } from './routes'
import { SignInNotice } from './signin'

export default function Account() {
  const store = useStore()
  const { session, ready } = useSession()
  if (!store) return <p className="sx-muted">This build has no accounts.</p>
  if (!ready) return <div className="ws-loading" aria-busy="true" />
  if (!session) {
    return (
      <section className="set-sec" aria-labelledby="acct-h">
        <h3 id="acct-h">Account</h3>
        <SignInNotice>Sign in to download models, follow creators, upload your own and manage your data.</SignInNotice>
      </section>
    )
  }
  return <SignedIn />
}

function SignedIn() {
  const store = useStore()
  const host = useHost()
  const edition = useEdition()
  const client = useQueryClient()
  const { session } = useSession()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const pending = useQuery({ queryKey: ['account-deletion'], queryFn: async () => (store ? store.pendingAccountDeletion() : null) })
  const policy = useQuery({ queryKey: ['account-policy'], queryFn: async () => (store ? store.accountDeletionPolicy() : null), enabled: confirm })
  const tokens = useQuery({ queryKey: ['api-tokens'], queryFn: async () => (store ? store.apiTokens() : []) })
  if (!store || !session) return null

  const exportData = async () => {
    setBusy('export')
    try {
      const r = await store.exportMyData()
      if (!r.ok) return toast(r.message, 'error')
      const saved = await host.files.save(exportFileName(), new Blob([JSON.stringify(r.value, null, 2)], { type: 'application/json' }), { accept: ['.json'] })
      if (saved) toast(`Saved ${saved.name}`, 'ok')
    } finally {
      setBusy(null)
    }
  }
  const requestDeletion = async () => {
    setBusy('delete')
    try {
      const r = await store.requestAccountDeletion()
      if (!r.ok) return toast(r.message, 'error')
      setConfirm(false)
      await client.invalidateQueries({ queryKey: ['account-deletion'] })
      await client.invalidateQueries({ queryKey: ['api-tokens'] })
    } finally {
      setBusy(null)
    }
  }
  const cancelDeletion = async () => {
    setBusy('cancel')
    try {
      const r = await store.cancelAccountDeletion()
      if (!r.ok) return toast(r.message, 'error')
      toast('Deletion canceled. Your account stays.', 'ok')
      await client.invalidateQueries({ queryKey: ['account-deletion'] })
    } finally {
      setBusy(null)
    }
  }
  const revoke = async (id: string) => {
    const r = await store.revokeApiToken(id)
    if (!r.ok) return toast(r.message, 'error')
    await client.invalidateQueries({ queryKey: ['api-tokens'] })
  }
  const revokeAll = async () => {
    setBusy('revoke-all')
    try {
      const r = await store.revokeAllApiTokens()
      if (!r.ok) return toast(r.message, 'error')
      toast(revokedLabel(r.value.revoked), 'ok')
      await client.invalidateQueries({ queryKey: ['api-tokens'] })
    } finally {
      setBusy(null)
    }
  }
  const signOut = async () => {
    await store.signOut()
    client.setQueryData(['session'], null)
  }
  const open = (url: string) => void openExternal(host, url)
  const live = activeTokens(tokens.data ?? [])

  return (
    <>
      <section className="set-sec" aria-labelledby="acct-h">
        <h3 id="acct-h">Account</h3>
        <div className="acct-who">
          <span className="min0">
            <b>{session.displayName ?? session.handle ?? 'Signed in'}</b>
            <small className="sx-muted">{session.email ?? (store.mode === 'offline' ? 'Demo account, nothing is stored on a server' : '')}</small>
          </span>
          <Button size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
        <div className="row-btns">
          {session.handle ? (
            <Button size="sm" icon="creator" onClick={() => open(creatorUrl(edition, session.handle ?? ''))}>
              Your creator page
            </Button>
          ) : null}
          <Button size="sm" icon="cloud-upload" onClick={() => open(dashboardUrl(edition))}>
            Upload and manage models
          </Button>
        </div>
      </section>

      {pending.data ? (
        <div className="banner warn" role="status">
          <p>{deletionBanner(pending.data)}</p>
          <Button size="sm" variant="primary" disabled={busy === 'cancel'} onClick={() => void cancelDeletion()}>
            Cancel deletion
          </Button>
        </div>
      ) : null}

      <section className="set-sec" aria-labelledby="data-h">
        <h3 id="data-h">Your data</h3>
        <p className="sx-small sx-muted">
          Download everything stored about you as one JSON file. Read what is stored and why in the{' '}
          <a href={privacyUrl(edition, host.build.sourceUrl)} target="_blank" rel="noopener noreferrer">
            privacy notes
          </a>
          .
        </p>
        <div className="row-btns">
          <Button icon="download" disabled={busy === 'export'} onClick={() => void exportData()}>
            {busy === 'export' ? 'Preparing' : 'Download my data'}
          </Button>
          {pending.data ? null : (
            <Button icon="delete" onClick={() => setConfirm(true)}>
              Delete my account
            </Button>
          )}
        </div>
      </section>

      <section className="set-sec" aria-labelledby="tok-h">
        <h3 id="tok-h">API tokens</h3>
        <p className="sx-small sx-muted">Tokens let tools such as the {appName()} command line and MCP server act as you. Revoke one you no longer use, or all of them after a leak.</p>
        {tokens.data?.length ? (
          <ul className="tok-list">
            {tokens.data.map((t) => {
              const state = tokenState(t)
              return (
                <li key={t.id} data-state={state}>
                  <span className="min0">
                    <b>{t.name}</b>
                    <small className="sx-mono sx-muted">
                      {t.prefix}... , {rateLabel(t)}
                    </small>
                    <small className="sx-muted">
                      {t.scopes.join(', ')}
                      {t.lastUsedAt ? `, last used ${new Date(t.lastUsedAt).toLocaleDateString('en-US')}` : ', never used'}
                    </small>
                  </span>
                  {state === 'active' ? (
                    <Button size="sm" onClick={() => void revoke(t.id)} aria-label={`Revoke ${t.name}`}>
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
          <p className="sx-small sx-muted">{tokens.isPending ? 'Loading tokens.' : 'You have no API tokens.'}</p>
        )}
        {live.length > 1 ? (
          <Button icon="delete" disabled={busy === 'revoke-all'} onClick={() => void revokeAll()}>
            Revoke all {live.length} tokens
          </Button>
        ) : null}
      </section>

      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete your account"
        splitFooter
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Keep my account</Button>
            <Button variant="primary" icon="delete" disabled={busy === 'delete' || !policy.data} onClick={() => void requestDeletion()}>
              Delete my account
            </Button>
          </>
        }
      >
        {policy.data ? (
          <div className="policy">
            <p>
              Your account is removed after {graceLabel(policy.data)}. Your API tokens stop working now. Sign in and cancel any time before then to keep everything.
            </p>
            <h4 className="set-sub">Removed</h4>
            <ul>
              {policy.data.removed.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            <h4 className="set-sub">Kept</h4>
            <ul>
              {policy.data.kept.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="sx-muted" aria-busy="true">
            Loading what deletion removes.
          </p>
        )}
      </Dialog>
    </>
  )
}
