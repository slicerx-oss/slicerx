// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The pre-alpha agreement for apps that build SlicerX in. The SlicerX app shows its own on first run;
// an app that embeds the pieces shows this one before the pieces are first used, and again when
// AGREEMENT_VERSION goes up. Acceptance (version and date) is kept in the host's storage.
import { AGREEMENT_VERSION, DEFAULT_BUG_REPORTS_URL, type AgreementRecord } from '@slicerx/contracts'
import { useId, useState } from 'react'

export { AGREEMENT_VERSION, type AgreementRecord }

export type ReleaseStage = 'pre-alpha' | 'alpha' | 'beta' | 'stable'

export interface Release {
  /** How finished the SlicerX pieces are. In pre-alpha the agreement must be accepted before first use. */
  stage: ReleaseStage
  /** Where people report bugs in the SlicerX pieces. */
  bugReportsUrl: string
}

/** The release of the SlicerX pieces in this package. Pass it through to the agreement and your Help menu. */
export const RELEASE: Release = { stage: 'pre-alpha', bugReportsUrl: DEFAULT_BUG_REPORTS_URL }

/** Where acceptance is kept: localStorage by default, or any store with the same two methods. */
export interface AgreementStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The storage key the default helpers use. */
export const AGREEMENT_KEY = 'slicerx.embed.agreement'

function defaultStorage(): AgreementStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The acceptance on record, or null when there is none or it cannot be read. */
export function readAgreement(storage: AgreementStorage | null = defaultStorage()): AgreementRecord | null {
  try {
    const v = JSON.parse(storage?.getItem(AGREEMENT_KEY) ?? 'null') as Partial<AgreementRecord> | null
    return v && typeof v.version === 'number' && typeof v.acceptedAt === 'string' ? { version: v.version, acceptedAt: v.acceptedAt } : null
  } catch {
    return null
  }
}

/** Whether the agreement must be shown: a pre-alpha release, not accepted in this version. */
export function agreementNeeded(accepted: AgreementRecord | null = readAgreement(), release: Pick<Release, 'stage'> = RELEASE): boolean {
  return release.stage === 'pre-alpha' && accepted?.version !== AGREEMENT_VERSION
}

/** Records acceptance of this version now and returns the record. Keep it, or send it to your server. */
export function acceptAgreement(storage: AgreementStorage | null = defaultStorage(), now = new Date()): AgreementRecord {
  const record = { version: AGREEMENT_VERSION, acceptedAt: now.toISOString() }
  storage?.setItem(AGREEMENT_KEY, JSON.stringify(record))
  return record
}

export interface AgreementProps {
  /** Your app's name, as the person knows it. */
  appName: string
  /** Defaults to RELEASE. */
  release?: Release
  /** Called with the record once the person accepts. The default storage already has it. */
  onAccept: (record: AgreementRecord) => void
  /** Where to keep acceptance; localStorage by default, null to keep nothing. */
  storage?: AgreementStorage | null
  /** Opens a link; defaults to a new window. Desktop shells pass their own. */
  openLink?: (url: string) => void
  className?: string
}

/** The pre-alpha agreement as a panel. Put it in your own dialog or page; it fills its container. */
export function Agreement({ appName, release = RELEASE, onAccept, storage, openLink, className }: AgreementProps) {
  const [agreed, setAgreed] = useState(false)
  const id = useId()
  const url = release.bugReportsUrl
  const open = (e: { preventDefault(): void }) => {
    if (!openLink) return
    e.preventDefault()
    openLink(url)
  }
  return (
    <section className={className ? `sxe-agreement ${className}` : 'sxe-agreement'} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} data-testid="slicerx-agreement">
      <p className="sxe-ag-eyebrow">Pre-alpha</p>
      <h2 id={`${id}-t`}>The SlicerX parts of {appName} are in pre-alpha</h2>
      <p>Slicing, the 3D view and the print settings in {appName} come from SlicerX, which is an early test build. Please read this before you use them.</p>
      <h3>It still needs heavy testing</h3>
      <p>Features are unfinished and some will break. Settings, presets and project files can change from one version to the next. Check the sliced G-code in the preview before you print it.</p>
      <h3>Watch your printer</h3>
      <p>Stay with your printer for the first prints. Check that it moves and extrudes the way it should and that the nozzle and bed temperatures stay in range. Be ready to stop the print or switch the printer off if anything looks wrong.</p>
      <h3>Report bugs</h3>
      <p>
        Post bugs in the SlicerX parts on the SlicerX Discord, in the bug-reports channel:{' '}
        <a href={url} target="_blank" rel="noreferrer" onClick={open}>
          {url.replace(/^https:\/\//, '')}
        </a>
        . Problems with the rest of {appName} go to its makers.
      </p>
      <h3>Crash reports</h3>
      <p>When a SlicerX part fails, {appName} may send a crash report with the error, the app and SlicerX versions and your operating system. Access tokens, keys, addresses and your user name are removed first. Your models are not sent.</p>
      <label className="sxe-check">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        I understand that this is a pre-alpha build and I'll watch my printer while it runs.
      </label>
      <div className="sxe-ag-foot">
        <span>{`Agreement version ${AGREEMENT_VERSION}`}</span>
        <button type="button" className="sxe-primary" disabled={!agreed} onClick={() => onAccept(acceptAgreement(storage === undefined ? defaultStorage() : storage))}>
          Accept and continue
        </button>
      </div>
    </section>
  )
}
