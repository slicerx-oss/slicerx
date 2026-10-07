// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The review queue for the owner and moderators: uploads waiting for a decision, with the scan state, the
// creator's record, and Approve or Send back with a note the creator sees.
import type { ModerationItem } from '@slicerx/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@slicerx/ui'
import { toast } from '@slicerx/app'
import { Frame } from './creator-editor'
import { ago } from './library'
import { LIBRARY_KEY, useSession, useStore } from './queries'
import { closeReview, openCreator, openListing, useLibrarySheets } from './sheets'

/** A reason the creator reads; the database wants at least 3 characters. */
export const REASON_MIN = 3

/** The owner and moderators review. */
export const canReview = (role: string | undefined | null): boolean => role === 'owner' || role === 'moderator'

/** The queue, when the Vault asked for it. */
export function ReviewHost() {
  const { review } = useLibrarySheets()
  return review ? <ReviewQueue /> : null
}

function ReviewQueue() {
  const store = useStore()
  const client = useQueryClient()
  const { session } = useSession()
  const q = useQuery({
    queryKey: ['library', 'review-queue'],
    queryFn: async () => {
      if (!store) return [] as ModerationItem[]
      const r = await store.moderationQueue()
      if (!r.ok) throw new Error(r.message)
      return r.value
    },
    enabled: Boolean(store && session),
    refetchInterval: 10_000,
  })
  const [busy, setBusy] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  const done = async (message: string) => {
    toast(message, 'ok')
    setRejecting(null)
    setReason('')
    await client.invalidateQueries({ queryKey: LIBRARY_KEY })
  }

  const approve = async (item: ModerationItem) => {
    if (!store) return
    setBusy(item.listingId)
    try {
      const r = await store.approveListing(item.listingId)
      if (r.ok) await done(`${item.title} is live`)
      else toast(r.message, 'error')
    } finally {
      setBusy(null)
    }
  }

  const reject = async (item: ModerationItem) => {
    if (!store || reason.trim().length < REASON_MIN) return
    setBusy(item.listingId)
    try {
      const r = await store.rejectListing(item.listingId, reason.trim())
      if (r.ok) await done(`${item.title} went back to ${item.creatorHandle}`)
      else toast(r.message, 'error')
    } finally {
      setBusy(null)
    }
  }

  const items = q.data ?? []
  return (
    <Frame title="Review queue" onClose={closeReview}>
      <div className="up-list-wrap">
        {q.isPending ? <div className="ce-loading skeleton" aria-busy="true" /> : null}
        {q.isError ? (
          <p className="app-err" role="alert">
            The queue did not load: {q.error.message}
          </p>
        ) : null}
        {q.isSuccess && items.length === 0 ? <p className="app-empty">Nothing is waiting for review.</p> : null}
        {items.length ? (
          <ul className="up-list" aria-label="Waiting for review">
            {items.map((item) => (
              <li key={item.listingId} className="up-row rv-row">
                <div className="min0">
                  <b className="up-title">{item.title}</b>
                  <span className="ce-hint">
                    <button type="button" className="lib-more" onClick={() => openCreator(item.creatorHandle)}>
                      @{item.creatorHandle}
                    </button>
                    {item.creatorApprovedCount ? `, ${item.creatorApprovedCount} approved before` : ', first upload'}
                    {item.creatorTrusted ? ', trusted' : ''}
                    {item.uploaderBanned ? ', banned account' : ''}, sent {ago(item.submittedAt)}
                    {item.status === 'approved' ? `, a new version of a live design (${item.waitingVersions} waiting)` : ''}
                  </span>
                  {rejecting === item.listingId ? (
                    <form
                      className="rv-reject"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void reject(item)
                      }}
                    >
                      <label className="sr-only" htmlFor={`rv-${item.listingId}`}>
                        Why it goes back
                      </label>
                      <input id={`rv-${item.listingId}`} className="ce-in" value={reason} placeholder="What the creator should change" maxLength={1000} onChange={(e) => setReason(e.currentTarget.value)} />
                      <Button type="submit" size="sm" disabled={reason.trim().length < REASON_MIN || busy !== null}>
                        Send back
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRejecting(null)}>
                        Cancel
                      </Button>
                    </form>
                  ) : null}
                </div>
                <span className="up-stage" data-stage={item.ready ? 'review' : 'scanning'}>
                  {item.ready ? 'Scan passed' : 'Waiting for the scan'}
                </span>
                <div className="rv-actions">
                  <Button size="sm" variant="ghost" onClick={() => openListing(item.listingId)}>
                    View
                  </Button>
                  <Button size="sm" disabled={busy !== null} onClick={() => setRejecting(item.listingId)}>
                    Send back
                  </Button>
                  <Button size="sm" variant="primary" disabled={!item.ready || busy !== null} onClick={() => void approve(item)}>
                    Approve
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="ce-hint up-foot">Approve only what passed the scan. Sending back needs a note, which the creator sees in Your uploads.</p>
      </div>
    </Frame>
  )
}
