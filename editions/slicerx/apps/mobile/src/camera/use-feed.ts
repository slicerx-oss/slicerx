// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One printer's camera as React state: the latest frame, how it arrives and whether it is stale.
import { useEffect, useMemo, useRef, useState } from 'react'
import { usePocketHost } from '../data/provider'
import { feedsFor, type CameraFeeds, type FeedFrame, type FeedMode, type FeedQuality, type FeedStats } from './feed'

export interface FeedView {
  frame: FeedFrame | null
  mode: FeedMode | null
  stats: FeedStats | null
  /** Opening, before the first frame. */
  loading: boolean
  /** No frame for a while (the camera stopped, the printer went away). */
  stale: boolean
  /** The source could not be opened: the printer has no camera, or it went offline. */
  unavailable: boolean
}

const IDLE: FeedView = { frame: null, mode: null, stats: null, loading: false, stale: false, unavailable: false }

/** A frame older than this, at the feed's own pace, counts as stale. */
export const STALE_AFTER_MS: Record<FeedQuality, number> = { low: 8000, medium: 5000, high: 4000 }

/** Opens a feed while `enabled`, closes it on unmount, and re-opens when the printer or quality changes. */
export function useFeedFrom(feeds: CameraFeeds | null, printerId: string, enabled: boolean, quality: FeedQuality): FeedView {
  const [view, setView] = useState<FeedView>(IDLE)
  const lastAt = useRef(0)
  // The hub caps a remote stream's length; a new one opens just before the cap, so the picture does not stop.
  const [round, setRound] = useState(0)
  useEffect(() => {
    if (!enabled || !feeds) {
      setView(IDLE)
      return undefined
    }
    let live = true
    let close: (() => void) | null = null
    let recycle: ReturnType<typeof setTimeout> | null = null
    lastAt.current = 0
    // Keep the last picture on screen while a recycled stream opens.
    setView((v) => (round > 0 && v.frame ? v : { ...IDLE, loading: true }))
    feeds.open(printerId, { quality }).then(
      (feed) => {
        if (!live) return feed.close()
        close = feed.close
        if (feed.capMs) {
          recycle = setTimeout(() => live && setRound((n) => n + 1), Math.max(1000, feed.capMs - 5000))
        }
        const offFrame = feed.onFrame((f) => {
          lastAt.current = Date.now()
          setView((v) => ({ ...v, frame: f, mode: feed.mode, loading: false, stale: false, unavailable: false }))
        })
        const offStats = feed.onStats((s) => setView((v) => ({ ...v, stats: s })))
        const offEnded = feed.onEnded(() => setView((v) => ({ ...v, stale: true, loading: false })))
        const oldClose = close
        close = () => {
          offFrame()
          offStats()
          offEnded()
          oldClose()
        }
      },
      () => {
        if (live) setView({ ...IDLE, unavailable: true })
      },
    )
    // Staleness is judged on a timer so a silent camera is noticed without a frame arriving.
    const stale = setInterval(() => {
      if (lastAt.current && Date.now() - lastAt.current > STALE_AFTER_MS[quality]) setView((v) => (v.stale ? v : { ...v, stale: true }))
    }, 1000)
    return () => {
      live = false
      clearInterval(stale)
      if (recycle) clearTimeout(recycle)
      close?.()
    }
  }, [feeds, printerId, enabled, quality, round])
  return view
}

/** The feed for a printer of the current source. */
export function useFeed(printerId: string, enabled: boolean, quality: FeedQuality): FeedView {
  const host = usePocketHost()
  const feeds = useMemo(() => feedsFor(host.printers), [host])
  return useFeedFrom(feeds, printerId, enabled, quality)
}
