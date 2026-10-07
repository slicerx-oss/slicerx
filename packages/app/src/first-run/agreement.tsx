// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The pre-alpha agreement. In a pre-alpha build it covers the window on first run, and again whenever
// AGREEMENT_VERSION goes up, until it is accepted. Acceptance (version and date) is kept in prefs.
// Loaded on demand; the shell mounts it while `agreementOpen` is set.
import type { EditionConfig } from '@slicerx/edition-config'
import { crashReportsRequired, crashReportsSent, isFork, reportsUpload } from '@slicerx/edition-config'
import { AGREEMENT_VERSION, DEFAULT_BUG_REPORTS_URL, type Host } from '@slicerx/contracts'
import { Button, Icon, type IconName } from '@slicerx/ui'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { bugReportsUrl } from '../bugs/where'
import { useEdition } from '../edition'
import { EditionMark } from '../shell/edition-logo'
import { openLink } from '../lib/links'
import { set } from '../state/store'
import './first-run.css'
import './agreement.css'

// The version and the default link live in @slicerx/contracts, shared with the agreement in @slicerx/embed.
export { AGREEMENT_VERSION, DEFAULT_BUG_REPORTS_URL }

export { bugReportsOff, bugReportsUrl } from '../bugs/where'

export { needsAgreement } from './agreement-check'

/** Records acceptance and closes the agreement. */
export function acceptAgreement(now = new Date()): void {
  set({ agreement: { version: AGREEMENT_VERSION, acceptedAt: now.toISOString() }, agreementOpen: false, crashReports: true })
}

function Point({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <section className="fra-point">
      <span className="fra-point-ic" aria-hidden="true">
        <Icon name={icon} size={26} />
      </span>
      <div>
        <h2 className="fra-point-title">{title}</h2>
        {children}
      </div>
    </section>
  )
}

function isDiscord(url: string): boolean {
  try {
    return /(^|\.)discord\.(com|gg)$/.test(new URL(url).hostname)
  } catch {
    return false
  }
}

export function Agreement() {
  const edition = useEdition()
  const [agreed, setAgreed] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const url = bugReportsUrl(edition)
  const discord = url !== null && isDiscord(url)
  // A fork uploads crash reports only to its own backend (and to SlicerX when it turned bugs.upstream on); without either there are none.
  const crashes = !isFork(edition) || crashReportsSent(edition)
  const name = edition.brand.name

  // The app behind is out of reach of focus and screen readers until this is accepted.
  useEffect(() => {
    const app = document.querySelector<HTMLElement>('.app')
    app?.setAttribute('inert', '')
    rootRef.current?.querySelector<HTMLElement>('.fra-check input')?.focus()
    return () => app?.removeAttribute('inert')
  }, [])

  return (
    <div className="fr fra" ref={rootRef} role="dialog" aria-modal="true" aria-labelledby="fra-title" data-testid="agreement">
      <header className="fr-top">
        <span className="fr-mark" role="img" aria-label={name}>
          <EditionMark edition={edition} size={24} />
        </span>
        <span className="fr-top-title">Before you start</span>
        <span className="fr-top-sp" />
        <span className="fr-stepno sx-mono">Pre-alpha</span>
      </header>
      <div className="fr-rail" aria-hidden="true">
        <i style={{ transform: 'scaleX(0)' }} />
      </div>
      <div className="fr-stage">
        <div className="fr-main">
          <div className="fr-body">
            <div className="fra-col">
              <div className="fr-head">
                <p className="fr-eyebrow">
                  <Icon name="warning" size={14} /> Test build
                </p>
                <h1 className="fr-title fr-display" id="fra-title">
                  {name} is in pre-alpha
                </h1>
                <p className="fr-lede">This is an early test build. Please read this before you use it.</p>
              </div>

              <div className="fra-points">
                <Point icon="bug" title="It still needs heavy testing">
                  <p>Features are unfinished and some will break. Settings, presets and project files can change from one build to the next. Check the sliced toolpaths in Slice before you print it.</p>
                </Point>
                <Point icon="printer" title="Watch your printer">
                  <p>
                    When {name} is connected to a printer, stay with it for the first prints. Check that it moves and extrudes the way it should and that the nozzle and bed temperatures stay in range. Be ready to stop the print or switch the printer off if anything looks wrong.
                  </p>
                </Point>
                {url ? <Point icon="comment" title={discord ? 'Report bugs on Discord' : 'Report bugs'}>
                  <p>
                    {discord ? 'Post bugs in the' : 'Report bugs on the'}{' '}
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => {
                        e.preventDefault()
                        openLink(url)
                      }}
                    >
                      {discord ? `#bug-reports channel on the ${name} Discord` : `${name} support page`}
                    </a>
                    .{reportsUpload(edition) ? ' Or use Help, Report a bug: it sends a report with your logs attached.' : ''}
                  </p>
                </Point> : null}
                {crashes ? <Point icon="shield" title="Crash reports stay on">
                  <p>
                    Crash reports can't be turned off in pre-alpha. Your models and projects are never sent.{' '}
                    <button
                      type="button"
                      className="fra-more"
                      data-tip-title="What a crash report contains"
                      data-tip-body={`The error and stack trace, the last part of the app log, the app version, your operating system, your printer's model and firmware, and a random install ID. Before it leaves this computer, ${name} removes access tokens, API keys, printer access codes, serial numbers, IP addresses, email addresses and your user name in folder paths. File names can appear in the log.`}
                    >
                      What's sent?
                    </button>
                  </p>
                </Point> : null}
              </div>

              <label className="fr-check fra-check">
                <input type="checkbox" data-testid="agreement-check" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                I understand that this is a pre-alpha build and I'll watch my printer while it runs.
              </label>
              <p className="fra-foot sx-mono">Agreement version {AGREEMENT_VERSION}. Accepting saves the version and date on this computer.</p>
            </div>
          </div>
          <footer className="fr-foot">
            <div className="fr-foot-in">
              <span className="fr-back" />
              <span />
              <Button variant="primary" className="fr-primary fr-next-btn" iconEnd="arrow-right" data-testid="agreement-accept" disabled={!agreed} onClick={() => acceptAgreement()}>
                Accept and continue
              </Button>
            </div>
          </footer>
        </div>
      </div>
    </div>
  )
}
