// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Progress for a Vault download (Open or Download): bytes and percent, a way to cancel, and the error with a retry.
import type { Listing } from '@slicerx/contracts'
import { useEffect, useRef, useState } from 'react'
import { Button, Icon } from '@slicerx/ui'
import { fetchModel, formatBytes, type ModelFetch } from './download'
import { useStore } from './queries'

export type DownloadState = { kind: 'downloading'; title: string; got: number; total: number | null } | { kind: 'error'; title: string; message: string }

/** Runs fetchModel with progress and cancel. Failures stay on screen until retried or dismissed. */
export function useModelFetch() {
  const store = useStore()
  const [state, setState] = useState<DownloadState | null>(null)
  const ctrl = useRef<AbortController | null>(null)
  const again = useRef<(() => void) | null>(null)
  useEffect(() => () => ctrl.current?.abort(), [])

  const run = async (listing: Listing, own: boolean, retry: () => void): Promise<ModelFetch | null> => {
    if (!store) return null
    ctrl.current?.abort()
    const c = new AbortController()
    ctrl.current = c
    again.current = retry
    const title = listing.title
    setState({ kind: 'downloading', title, got: 0, total: null })
    // React state at most every 80 ms; the newest numbers always land.
    let latest: [number, number | null] = [0, null]
    let timer: ReturnType<typeof setTimeout> | null = null
    const show = () => {
      timer = null
      if (!c.signal.aborted) setState({ kind: 'downloading', title, got: latest[0], total: latest[1] })
    }
    const r = await fetchModel(store, listing, fetch, own, {
      signal: c.signal,
      onProgress: (got, total) => {
        latest = [got, total]
        timer ??= setTimeout(show, 80)
      },
    })
    if (timer) clearTimeout(timer)
    if (ctrl.current === c) ctrl.current = null
    if (c.signal.aborted && r.ok) return null
    if (!r.ok && r.reason === 'error') setState({ kind: 'error', title, message: r.message })
    else setState(null)
    return r
  }
  return {
    state,
    run,
    cancel: () => ctrl.current?.abort(),
    retry: () => again.current?.(),
    dismiss: () => setState(null),
  }
}

/** `onSignIn`: the person is signed out, so a failed download offers signing in as well as a retry. */
export function DownloadStatus({ state, onCancel, onRetry, onDismiss, onSignIn }: { state: DownloadState | null; onCancel: () => void; onRetry: () => void; onDismiss: () => void; onSignIn?: (() => void) | undefined }) {
  if (!state) return null
  if (state.kind === 'error') {
    return (
      <div className="lib-dl" data-state="error" role="alert">
        <div className="lib-dl-top">
          <Icon name="alert" size={16} />
          <span className="lib-dl-msg">
            {state.message} {onSignIn ? 'Try again, or sign in and download it to your account.' : 'Try again in a moment.'}
          </span>
        </div>
        <div className="lib-dl-actions">
          {onSignIn ? (
            <Button size="sm" variant="primary" onClick={onSignIn}>
              Sign in
            </Button>
          ) : null}
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    )
  }
  const { got, total } = state
  const pct = total ? Math.min(100, Math.round((got / total) * 100)) : null
  const size = total ? `${formatBytes(got)} of ${formatBytes(total)}` : got ? formatBytes(got) : 'Starting'
  return (
    <div className="lib-dl" role="status">
      <div className="lib-dl-top">
        <span className="lib-dl-msg">Downloading {state.title}</span>
        <span className="lib-dl-num">
          {size}
          {pct === null ? '' : ` · ${pct}%`}
        </span>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <div className="lib-dl-bar" role="progressbar" aria-label={`Downloading ${state.title}`} aria-valuemin={0} aria-valuemax={100} {...(pct === null ? {} : { 'aria-valuenow': pct })} data-indeterminate={pct === null ? true : undefined}>
        <span style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
    </div>
  )
}
