// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Signing in from the app: an emailed link, or one of the providers the edition offers. The link
// comes back to the app (the web callback or the desktop deep link), and the session follows.
import type { AuthProvider, SignInMethod } from '@slicerx/contracts'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Dialog } from '@slicerx/ui'
import { toast, useHost } from '@slicerx/app'
import { onSignInResult, takeSignInResult } from '../../lib/sign-in-result'
import { useSession, useStore } from './queries'
import './signin.css'

const PROVIDER_LABEL: Record<AuthProvider, string> = { github: 'GitHub', google: 'Google', apple: 'Apple', discord: 'Discord' }
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
/** Seconds before another link may be asked for: the server's own wait when it names one, else a minute. */
const RESEND_WAIT_S = 60

/** The wait a rate-limit message names ("only request this after 32 seconds"), or null. */
export function waitFromMessage(message: string): number | null {
  const m = /after (\d+) seconds?/i.exec(message)
  return m ? Number(m[1]) : null
}

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
  // A link that came back and failed is shown here until the person sends a new one.
  const [linkFailed, setLinkFailed] = useState<string | null>(null)
  useEffect(() => {
    const show = (r: { ok: boolean; message?: string }) => setLinkFailed(r.ok ? null : (r.message ?? 'Sign-in did not finish.'))
    const early = takeSignInResult()
    if (early) show(early)
    return onSignInResult(show)
  }, [])
  // Send again is held until this time (ms), while the server would refuse another link.
  const [until, setUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until <= Date.now()) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [until])
  const wait = Math.max(0, Math.ceil((until - now) / 1000))
  const setWait = (s: number) => {
    const t = Date.now()
    setNow(t)
    setUntil(s > 0 ? t + s * 1000 : 0)
  }
  // Signing in or out starts the form over, so it never reopens on an old "We sent a link".
  const { session } = useSession()
  const who = session?.userId ?? null
  const lastWho = useRef(who)
  useEffect(() => {
    if (lastWho.current === who) return
    lastWho.current = who
    setSent(null)
    setError(null)
    setLinkFailed(null)
    setUntil(0)
  }, [who])
  // The web host loads the store on first use, so even this sync call can come back as a promise.
  const [methods, setMethods] = useState<SignInMethod[] | null>(null)
  useEffect(() => {
    if (!store) return
    let live = true
    void Promise.resolve(store.signInMethods() as SignInMethod[] | Promise<SignInMethod[]>).then((m) => live && setMethods(m))
    return () => {
      live = false
    }
  }, [store])
  if (!store) return <p className="sx-small sx-muted">This build has no accounts.</p>
  if (!methods) return null
  const providers = methods.filter((m): m is AuthProvider => m !== 'email')
  const allowsEmail = methods.includes('email')

  const send = async () => {
    const to = email.trim()
    if (!plausibleEmail(to)) {
      setError('Enter your email address')
      return
    }
    setBusy(true)
    setError(null)
    setLinkFailed(null)
    try {
      const r = await store.signInWithEmail(to)
      if (r.ok) {
        setSent(to)
        setWait(RESEND_WAIT_S)
      } else {
        setError(r.code === 'rate_limited' ? 'Too many links asked for. Try again in a few minutes.' : r.message)
        const w = waitFromMessage(r.message)
        if (w) setWait(w)
      }
    } finally {
      setBusy(false)
    }
  }

  const failure = linkFailed ? (
    <div className="si-failed" role="alert" data-testid="signin-failed">
      <b>Sign-in did not finish.</b> {linkFailed}
    </div>
  ) : null

  if (sent) {
    return (
      <div className="si-sent" role="status" data-testid="signin-sent">
        {failure}
        <p>
          We sent a sign-in link to <b>{sent}</b>. Open it on this {host.kind === 'desktop' ? 'computer' : 'device'} to finish.
        </p>
        {error ? (
          <span className="si-err" role="alert" data-testid="signin-error">
            {error}
          </span>
        ) : null}
        <div className="si-sent-actions">
          <Button size="sm" variant={linkFailed ? 'primary' : 'default'} data-testid="signin-send-again" disabled={busy || wait > 0} onClick={() => void send()}>
            {busy ? 'Sending' : wait > 0 ? `${linkFailed ? 'Send a new link' : 'Send again'} in ${wait} s` : linkFailed ? 'Send a new link' : 'Send again'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="signin-other-address"
            onClick={() => {
              setSent(null)
              setError(null)
            }}
          >
            Use another address
          </Button>
        </div>
      </div>
    )
  }
  return (
    <form
      className="si-form"
      data-testid="signin-form"
      data-compact={compact ? true : undefined}
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      {failure}
      {allowsEmail ? (
        <>
          <label className="sr-only" htmlFor="si-email">
            Email
          </label>
          <div className="si-row">
            <input id="si-email" className="si-in" data-testid="signin-email" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.currentTarget.value)} aria-invalid={Boolean(error)} />
            <Button type="submit" variant="primary" data-testid="signin-submit" disabled={busy}>
              {busy ? 'Sending' : 'Email me a link'}
            </Button>
          </div>
          {error ? (
            <span className="si-err" role="alert" data-testid="signin-error">
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
              data-testid={`signin-provider-${p}`}
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
    <Dialog open={open} onClose={onClose} title="Sign in or create an account" testId="signin-dialog">
      <SignInForm />
    </Dialog>
  )
}

/** Shown where an action needs a session. */
export function SignInNotice({ children }: { children: ReactNode }) {
  return (
    <div className="signin-note" role="status" data-testid="signin-notice">
      <p className="sx-small">{children}</p>
      <SignInForm compact />
    </div>
  )
}
