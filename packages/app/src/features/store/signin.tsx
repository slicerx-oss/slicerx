// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Signing in from the app: an emailed link, or one of the providers the edition offers. The link
// comes back to the app (the web callback or the desktop deep link), and the session follows.
import type { AuthProvider } from '@slicerx/contracts'
import { useState, type ReactNode } from 'react'
import { Button, Dialog } from '@slicerx/ui'
import { toast, useHost } from '@slicerx/app'
import { useStore } from './queries'
import './signin.css'

const PROVIDER_LABEL: Record<AuthProvider, string> = { github: 'GitHub', google: 'Google', apple: 'Apple', discord: 'Discord' }
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** True for an address worth sending a link to. */
export function plausibleEmail(text: string): boolean {
  return EMAIL.test(text.trim())
}

/** The email field and provider buttons. Sign-up and sign-in are the same step: a new address gets an account. */
export function SignInForm({ compact }: { compact?: boolean }) {
  const store = useStore()
  const host = useHost()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!store) return <p className="sx-small sx-muted">This build has no accounts.</p>
  const providers = store.signInMethods().filter((m): m is AuthProvider => m !== 'email')
  const allowsEmail = store.signInMethods().includes('email')

  const send = async () => {
    const to = email.trim()
    if (!plausibleEmail(to)) {
      setError('Enter your email address')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await store.signInWithEmail(to)
      if (r.ok) setSent(to)
      else setError(r.code === 'rate_limited' ? 'Too many links asked for. Try again in a few minutes.' : r.message)
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <div className="si-sent" role="status">
        <p>
          We sent a sign-in link to <b>{sent}</b>. Open it on this {host.kind === 'desktop' ? 'computer' : 'device'} to finish.
        </p>
        <Button size="sm" variant="ghost" onClick={() => setSent(null)}>
          Use another address
        </Button>
      </div>
    )
  }
  return (
    <form
      className="si-form"
      data-compact={compact ? true : undefined}
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      {allowsEmail ? (
        <>
          <label className="sr-only" htmlFor="si-email">
            Email
          </label>
          <div className="si-row">
            <input id="si-email" className="si-in" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.currentTarget.value)} aria-invalid={Boolean(error)} />
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Sending' : 'Email me a link'}
            </Button>
          </div>
          {error ? (
            <span className="si-err" role="alert">
              {error}
            </span>
          ) : null}
        </>
      ) : null}
      {providers.length ? (
        <div className="si-providers">
          {providers.map((p) => (
            <Button
              key={p}
              onClick={() =>
                void store.signInWithOAuth(p).then((r) => {
                  if (!r.ok) toast(r.message, 'error')
                })
              }
            >
              Continue with {PROVIDER_LABEL[p]}
            </Button>
          ))}
        </div>
      ) : null}
      <span className="sx-small sx-dim">New here? The same link makes your free account.</span>
    </form>
  )
}

/** Sign in, in a dialog of its own. */
export function SignInDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Sign in or create an account">
      <SignInForm />
    </Dialog>
  )
}

/** Shown where an action needs a session. */
export function SignInNotice({ children }: { children: ReactNode }) {
  return (
    <div className="signin-note" role="status">
      <p className="sx-small">{children}</p>
      <SignInForm compact />
    </div>
  )
}
