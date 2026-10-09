// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The window's opening. index.html paints a frame of the app (#sx-boot: the top bar, and the setup card or the Slice
// panes) before any code loads, so the window never shows empty. The app takes over from it without a cut: the frame
// fades once the first screen has mounted under it, the same frame stands in while a screen's code loads, and the 3D
// view alone keeps a frame until it is up (ViewHold), so the sidebars can be used at once.
import { motionReduced } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { set } from '../state/store'
import './boot.css'

/** Fades the static frame out and removes it. Safe to call more than once. */
export function bootDone(): void {
  const el = document.getElementById('sx-boot')
  if (!el || el.dataset['leaving']) return
  el.dataset['leaving'] = '1'
  setTimeout(() => el.remove(), 280)
}

/**
 * Calls back once the app's screen is up under the frame: Slice has mounted (its sidebars and top bar can be used; its
 * 3D view keeps a frame of its own, ViewHold), `other` says another workspace opened, or `maxMs` passed. Returns a cancel.
 */
export function whenShellReady(cb: () => void, other: () => boolean, maxMs = 2000): () => void {
  let done = false
  const fire = () => {
    if (done) return
    done = true
    obs.disconnect()
    clearTimeout(timer)
    cb()
  }
  const check = () => {
    if (document.querySelector('.studio') || other()) fire()
  }
  const obs = new MutationObserver(check)
  obs.observe(document.body, { childList: true, subtree: true })
  const timer = setTimeout(fire, maxMs)
  check()
  return () => {
    done = true
    obs.disconnect()
    clearTimeout(timer)
  }
}

/**
 * Calls back once the 3D view is up (the root's `data-sx-ready` reads "viewport") or after `maxMs`, whichever comes
 * first. Returns a cancel.
 */
export function whenViewReady(cb: () => void, maxMs = 1500): () => void {
  const root = document.documentElement
  let done = false
  const fire = () => {
    if (done) return
    done = true
    obs.disconnect()
    clearTimeout(timer)
    cb()
  }
  const check = () => {
    if (root.dataset['sxReady'] === 'viewport') fire()
  }
  const obs = new MutationObserver(check)
  obs.observe(root, { attributes: true, attributeFilter: ['data-sx-ready'] })
  const timer = setTimeout(fire, maxMs)
  check()
  return () => {
    done = true
    obs.disconnect()
    clearTimeout(timer)
  }
}

/** The same frame as index.html's, drawn by the app: `setup` for the agreement and setup, `studio` for Slice. */
export function BootFrame({ kind }: { kind: 'setup' | 'studio' }) {
  return (
    <div className="sx-bootframe" data-kind={kind} aria-hidden="true">
      <div className="b-top" />
      {kind === 'setup' ? (
        <>
          <div className="b-rail" />
          <div className="b-card">
            <i />
            <i />
            <i />
          </div>
        </>
      ) : (
        <>
          <div className="b-left" />
          <div className="b-right" />
        </>
      )}
    </div>
  )
}

let viewHeld = false

/**
 * No hold where the plate draws at once: under reduced motion, and in browser tests, which compare pictures from the
 * first frame and turn the plate reveal off (`sx-reveal`).
 */
function holdOff(): boolean {
  if (motionReduced()) return true
  try {
    return sessionStorage.getItem('sx-reveal') === 'off'
  } catch {
    return false
  }
}

/**
 * Over the 3D view on the window's first Slice: the view's ground until the plate and its view are up (at most 1.5 s),
 * then one fade into it, and the plate reveal starts. Later views just appear.
 */
export function ViewHold() {
  const [phase, setPhase] = useState<'hold' | 'out' | 'gone'>(viewHeld || holdOff() ? 'gone' : 'hold')
  useEffect(() => {
    if (holdOff()) set({ introHold: false })
    if (phase !== 'hold') return
    viewHeld = true
    return whenViewReady(() => {
      set({ introHold: false })
      setPhase('out')
    })
  }, [phase])
  useEffect(() => {
    if (phase !== 'out') return
    const t = setTimeout(() => setPhase('gone'), 280)
    return () => clearTimeout(t)
  }, [phase])
  if (phase === 'gone') return null
  return <div className="vp-hold" data-phase={phase} aria-hidden="true" />
}
