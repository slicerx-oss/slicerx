// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The window's opening. index.html paints a frame of the app (#sx-boot: the top bar, and the setup card or the Slice
// panes) before any code loads, so the window never shows empty. The app takes over from it without a cut: the frame
// fades once the first screen is ready under it, and the same frame stands in while a screen's code loads.
import './boot.css'

/** Fades the static frame out and removes it. Safe to call more than once. */
export function bootDone(): void {
  const el = document.getElementById('sx-boot')
  if (!el || el.dataset['leaving']) return
  el.dataset['leaving'] = '1'
  setTimeout(() => el.remove(), 280)
}

/**
 * Calls back once Slice has its plate and its 3D view up (the root's `data-sx-ready` reads "viewport"), once `other`
 * says another workspace opened, or after `maxMs`, whichever comes first. Returns a cancel.
 */
export function whenAppReady(cb: () => void, other: () => boolean, maxMs = 4000): () => void {
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
    if (root.dataset['sxReady'] === 'viewport' || other()) fire()
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
