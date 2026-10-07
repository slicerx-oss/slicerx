// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The update dialog, in the gods style: huginn and muninn spar in their rune ring straight on the dialog (no tile
// or halo behind them, a still frame under reduced motion), the purple tag, a green title, the release's top
// highlights and a link to the full notes. Restart to update is the one click; Later closes it.
import { Button, Dialog, RAVEN_BODY, RAVEN_WING, systemReducesMotion } from '@slicerx/ui'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useEdition } from '../edition'
import { useHost } from '../host'
import { openLink } from '../lib/links'
import { confirmDiscard } from '../project/unsaved'
import { appStore, useApp, type AppState } from '../state/store'
import { laterUpdate, noteLines, quitForUpdate, restartToUpdate, retryUpdate, subscribeUpdates, updateMode, updateNow, updatesHeld, useUpdateState, type FoundUpdate, type UpdatePhase, type UpdateStep } from './updates'
import './dialog.css'

// elder futhark on a 4 by 8 box, as in the camera loader (camera/idle.tsx)
const RUNES: Record<string, string> = {
  H: 'M0 0v8M4 0v8M0 2.5l4 3',
  U: 'M0 8V0l4 3v5',
  G: 'M0 0l4 8M4 0L0 8',
  I: 'M2 0v8',
  N: 'M2 0v8M.5 3l3 2',
  M: 'M0 0v8M4 0v8M0 0l4 4M4 0L0 4',
}
const RING = [...'HUGINN MUNINN HUGINN MUNINN ']

function Raven({ at, late }: { at: string; late?: boolean }) {
  return (
    <g transform={at} className={late ? 'upd-late' : undefined}>
      <g className="upd-bob">
        <g className="upd-lunge">
          <path className="upd-rbody" d={RAVEN_BODY} />
          <path className="upd-rwing" d={RAVEN_WING} />
          <circle className="upd-eye" cx="8.9" cy="10.5" r="0.85" />
        </g>
      </g>
    </g>
  )
}

/**
 * Whether the ravens hold still. The system's reduce motion setting counts unless the person chose Motion on in
 * Settings: the edition's default (On, for Remote Desktop, which reports reduce motion) is not their choice.
 */
export function ravensStill(choice: AppState['motion'], systemReduced: boolean): boolean {
  if (choice === 'full') return false
  if (choice === 'reduced') return true
  return systemReduced
}

function subscribeSystemMotion(cb: () => void): () => void {
  const q = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
  q?.addEventListener?.('change', cb)
  return () => q?.removeEventListener?.('change', cb)
}

/** The two ravens sparring in the rune ring, on a transparent ground; `still` holds one frame. */
export function UpdateRavens({ still = false }: { still?: boolean }) {
  return (
    <svg className="upd-ravens" viewBox="40 0 120 120" aria-hidden="true" focusable="false" data-still={still ? true : undefined}>
      <g className="upd-ring">
        <circle cx="100" cy="60" r="56" />
        <circle cx="100" cy="60" r="42" />
        {RING.map((c, i) => {
          const at = `rotate(${(i * 360) / RING.length} 100 60) translate(98.5 8) scale(0.75)`
          return c === ' ' ? <circle key={i} className="upd-sep" cx="2" cy="4" r="0.9" transform={at} /> : <path key={i} d={RUNES[c]} transform={at} />
        })}
      </g>
      <g transform="translate(100 62)">
        <g className="upd-spark">
          <path d="M0-7.5l1.2 6 5.8-1.5-4.7 3.7 3.2 5.3-5.5-3.5-5.5 3.5 3.2-5.3-4.7-3.7 5.8 1.5z" />
          <circle r="1.3" />
        </g>
      </g>
      <Raven at="translate(96 38) scale(-2 2)" />
      <Raven at="translate(104 38) scale(2)" late />
    </svg>
  )
}

function megabytes(n: number): string {
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`
}

function Highlights({ update }: { update: FoundUpdate }) {
  const lines = noteLines(update.notes)
  const url = update.releaseUrl
  if (!lines.length && !url) return null
  return (
    <div className="upd-notes">
      {lines.length ? (
        <>
          <h3 className="upd-notes-h">What changed</h3>
          <ul>
            {lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </>
      ) : null}
      {url ? (
        <a
          className="upd-more"
          href={url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            e.preventDefault()
            void openLink(url)
          }}
        >
          Full release notes
        </a>
      ) : null}
    </div>
  )
}

export interface UpdateDialogViewProps {
  phase: UpdatePhase
  open: boolean
  /** The product name, for the title. */
  app: string
  /** The tag over the title. */
  tag: string
  /** The running version, for "up to date". */
  version: string
  mode: 'install' | 'download'
  /** A print is being sent or a job is starting: Restart to update waits. */
  held: boolean
  /** Hold the ravens and the progress bar still (ravensStill). */
  still?: boolean
  onRestart: () => void
  onLater: () => void
  onRetry: () => void
  onDownload: (url: string) => void
  /** The launch sheet: Update now downloads, checks and restarts in one go. */
  startup?: boolean
  onUpdateNow?: () => void
  onQuit?: () => void
}

/** The dialog for each step: checking, up to date, out, downloading, ready, installing and could not update. */
export function UpdateDialogView({ phase, open, app, tag, version, mode, held, still = false, onRestart, onLater, onRetry, onDownload, startup = false, onUpdateNow, onQuit }: UpdateDialogViewProps) {
  let title: string
  let body: ReactNode = null
  let footer: ReactNode
  // this version has a known problem (the feed's min_version): no Later, only the update or Quit
  const required = 'update' in phase && phase.update?.required === true && phase.kind !== 'error'
  const later = (label = 'Later') =>
    required ? (
      <Button variant="ghost" onClick={onQuit}>
        Quit
      </Button>
    ) : (
      <Button variant="ghost" size="sm" onClick={onLater}>
        {label}
      </Button>
    )
  const problem = required ? (
    <p className="upd-line upd-required" role="alert">
      This version has a known problem. Update to keep using {app}.
    </p>
  ) : null
  switch (phase.kind) {
    case 'idle':
    case 'checking':
      title = 'Looking for updates'
      body = <p className="upd-line" role="status">Checking for a newer {app}…</p>
      footer = later('Close')
      break
    case 'current':
      title = `${app} is up to date`
      body = <p className="upd-line" role="status">You have the newest version, {version}.</p>
      footer = later('Close')
      break
    case 'available': {
      const url = phase.update.downloadUrl ?? phase.update.releaseUrl
      title = `${app} ${phase.update.version} is out`
      body = (
        <>
          {problem}
          <Highlights update={phase.update} />
          {mode === 'download' ? <p className="upd-line">This copy was installed as a package. Download the new one to update.</p> : null}
        </>
      )
      footer = (
        <>
          {later()}
          {mode === 'install' && onUpdateNow ? (
            <Button variant="primary" icon="download" onClick={onUpdateNow}>
              Update now
            </Button>
          ) : url ? (
            <Button variant="primary" icon="download" onClick={() => onDownload(url)}>
              Download
            </Button>
          ) : null}
        </>
      )
      break
    }
    case 'downloading': {
      const { got, total } = phase
      const pct = total ? Math.min(100, Math.round((got / total) * 100)) : null
      title = `Downloading ${app} ${phase.update.version}`
      body = (
        <>
          <div className="upd-progress" role="progressbar" aria-label="Download" aria-valuemin={0} aria-valuemax={100} {...(pct === null ? {} : { 'aria-valuenow': pct })} data-indeterminate={pct === null ? true : undefined}>
            <span style={pct === null ? undefined : { width: `${pct}%` }} />
          </div>
          <p className="upd-line sx-small">
            {total ? `${megabytes(got)} of ${megabytes(total)}` : got ? megabytes(got) : 'Starting'}. {startup ? `${app} checks it and restarts when it is done.` : 'Keep working; it asks before restarting.'}
          </p>
          {problem}
          <Highlights update={phase.update} />
        </>
      )
      footer = required ? null : later('Hide')
      break
    }
    case 'ready':
      title = `${app} ${phase.update.version} is ready`
      body = (
        <>
          <Highlights update={phase.update} />
          {held ? (
            <p className="upd-line upd-held" role="status">
              A print is being sent. Restart to update waits until it is on the printer.
            </p>
          ) : null}
        </>
      )
      footer = (
        <>
          {later()}
          <Button variant="primary" disabled={held} onClick={onRestart} {...(held ? { tip: 'Waits until the print is on the printer' } : {})}>
            Restart to update
          </Button>
        </>
      )
      break
    case 'installing':
      title = `Installing ${app} ${phase.update.version}`
      body = <p className="upd-line" role="status">{app} restarts in a moment.</p>
      footer = (
        <Button variant="primary" disabled>
          Restarting…
        </Button>
      )
      break
    case 'error': {
      const e = failed(phase.step, app, phase.update?.version)
      const url = phase.update?.releaseUrl
      const detail = detailText(phase.message, e.title, e.advice)
      title = e.title
      body = (
        <>
          <p className="upd-line" role="alert">
            {e.advice}
          </p>
          {detail ? <p className="upd-line upd-detail sx-small">Details: {detail}</p> : null}
          {url && (phase.step === 'verify' || phase.step === 'install') ? (
            <a
              className="upd-more"
              href={url}
              target="_blank"
              rel="noreferrer"
              onClick={(ev) => {
                ev.preventDefault()
                void openLink(url)
              }}
            >
              Release page
            </a>
          ) : null}
        </>
      )
      footer = (
        <>
          {later('Close')}
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        </>
      )
      break
    }
  }
  const headline = (
    <span className="upd-head">
      <UpdateRavens still={still} />
      <span className="upd-tag" aria-hidden="true">
        {tag}
      </span>
      <span className="upd-title" data-tone={phase.kind === 'error' ? 'error' : undefined}>{title}</span>
    </span>
  )
  return (
    <Dialog open={open} onClose={phase.kind === 'installing' || required ? () => undefined : onLater} title={headline} footer={footer} className="upd" required={phase.kind === 'installing' || required}>
      <div className="upd-body" data-step={phase.kind} data-still={still ? true : undefined}>
        {body}
      </div>
    </Dialog>
  )
}

/**
 * A failure's reason as the dialog shows it: each part once (the updater's errors can repeat their cause after a
 * colon), without the plugin's backticks, and empty when it only restates what the dialog already says.
 */
export function detailText(message: string, ...shown: string[]): string {
  const key = (t: string) => t.toLowerCase().replace(/`/g, '').replace(/[\s.:]+$/, '').trim()
  const seen = new Set<string>()
  const kept: string[] = []
  for (const part of message.split(/(?<=[.:])\s+/)) {
    const clean = part.replace(/`/g, '').trim()
    if (!clean || seen.has(key(clean))) continue
    seen.add(key(clean))
    kept.push(clean)
  }
  const text = kept.join(' ').replace(/:$/, '')
  return shown.some((s) => s.toLowerCase().includes(key(text))) ? '' : text
}

/** The title and what to try for each step that can fail. */
function failed(step: UpdateStep, app: string, version: string | undefined): { title: string; advice: string } {
  const named = version ? `${app} ${version}` : 'the update'
  switch (step) {
    case 'check':
      return { title: 'Could not check for updates', advice: 'The update server did not answer. Check your internet connection and try again.' }
    case 'download':
      return { title: `The download of ${named} stopped`, advice: 'Check your internet connection and try again. The download starts over.' }
    case 'verify':
      return { title: `${version ? named : 'The update'} failed its signature check`, advice: `Nothing was installed. Try again; if it fails again, download ${app} from the release page.` }
    case 'install':
      return { title: `Could not install ${named}`, advice: `${app} is unchanged. Try again, or download the new version from the release page and install it over this one.` }
  }
}

/** Re-renders when the app's busy state changes, so Restart to update follows a print send. */
function useHeld(): boolean {
  const [held, setHeld] = useState(updatesHeld)
  useEffect(() => {
    const again = () => setHeld(updatesHeld())
    const a = subscribeUpdates(again)
    const b = appStore.subscribe(again)
    return () => {
      a()
      b()
    }
  }, [])
  return held
}

export function UpdateDialog() {
  const { phase, open, startup } = useUpdateState()
  const host = useHost()
  const edition = useEdition()
  const held = useHeld()
  const still = ravensStill(useApp((s) => s.motion), useSyncExternalStore(subscribeSystemMotion, systemReducesMotion, () => false))
  const app = edition.brand.name
  return (
    <UpdateDialogView
      phase={phase}
      open={open}
      app={app}
      tag={edition.id === 'slicerx' ? 'SlicerX | A slicer for the gods' : app}
      version={host.build.version}
      mode={updateMode() ?? 'install'}
      held={held}
      still={still}
      onRestart={() => void restartToUpdate(() => confirmDiscard('restart to update'))}
      onLater={laterUpdate}
      onRetry={retryUpdate}
      onDownload={(url) => {
        void openLink(url)
        laterUpdate()
      }}
      startup={startup}
      onUpdateNow={() => void updateNow(() => confirmDiscard('restart to update'))}
      onQuit={() => void quitForUpdate()}
    />
  )
}
