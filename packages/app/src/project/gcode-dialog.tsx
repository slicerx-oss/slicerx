// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The project's own printer G-code, shown before a slice uses it: one plain line and the person's choice, with what
// it changes against the printer profile's text (each flagged line with its reason) behind Show differences. The
// printer profile's G-code is the default.
import { useEffect, useState } from 'react'
import type { GcodeChange, GcodeDiffLine, GcodeFlag } from '@slicerx/settings'
import { printerName } from '@slicerx/settings'
import { Block, Button, Dialog } from '@slicerx/ui'
import { answerProjectGcode } from '../state/project-gcode'
import { useApp } from '../state/store'
import './gcode-dialog.css'

const capital = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1)
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

export function ProjectGcodeDialog() {
  const p = useApp((s) => s.projectGcode)
  const printerId = useApp((s) => s.profile?.printerId)
  const open = p?.asking === true
  const approvable = p?.changes.every((c) => c.approvable) ?? false
  const profile = printerId ? `the ${printerName(printerId)} profile's` : "the printer profile's"
  // The printer's G-code is the default: focused when the dialog opens (its effect has shown the dialog by now).
  useEffect(() => {
    if (open) document.querySelector<HTMLButtonElement>('[data-testid="project-gcode-use-profile"]')?.focus()
  }, [open])
  return (
    <Dialog
      open={open}
      onClose={() => answerProjectGcode(null)}
      title="This project's G-code doesn't match your printer"
      className="pg"
      testId="project-gcode-dialog"
      splitFooter
      footer={
        <>
          <Button variant="ghost" disabled={!approvable} data-testid="project-gcode-use-project" onClick={() => answerProjectGcode('project')}>
            Use the project's G-code
          </Button>
          <Button variant="primary" autoFocus data-testid="project-gcode-use-profile" onClick={() => answerProjectGcode('profile')}>
            Use the printer's G-code
          </Button>
        </>
      }
    >
      {/* Keyed by the question, so each time it opens the differences start folded. */}
      {p && open ? <Body key={p.source} source={p.source} changes={p.changes} profile={profile} approvable={approvable} /> : null}
    </Dialog>
  )
}

function Body({ source, changes, profile, approvable }: { source: string; changes: GcodeChange[]; profile: string; approvable: boolean }) {
  const [shown, setShown] = useState(false)
  return (
    <div className="pg-body">
      <p className="pg-lede">
        {source} has its own printer G-code, different from {profile}.
      </p>
      {approvable ? null : (
        <p className="pg-block" role="alert">
          Some of it can't be sent to a printer, so only the printer's G-code can be used.
        </p>
      )}
      <Block className="pg-more" id="project-gcode-differences" title={shown ? 'Hide differences' : 'Show differences'} expanded={shown} onExpandedChange={setShown} data-testid="project-gcode-differences">
        <div className="pg-changes">
          {changes.map((c) => (
            <Change key={`${c.key}-${c.slot ?? ''}`} c={c} />
          ))}
        </div>
      </Block>
    </div>
  )
}

function Change({ c }: { c: GcodeChange }) {
  return (
    <section className="pg-change" aria-label={capital(c.label)}>
      <header className="pg-head">
        <h4>{capital(c.label)}</h4>
        <span className="pg-count">
          {plural(c.added, 'line')} added, {c.removed} removed
        </span>
      </header>
      {c.flags.length ? (
        <ul className="pg-flags">
          {c.flags.map((f) => (
            <li key={`${f.line}-${f.code}`} data-severity={f.severity}>
              <span className="pg-tag">{f.severity === 'error' ? 'Never allowed' : 'Needs your yes'}</span>
              <span>
                Line {f.line}: {f.reason}.
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pg-none">No line was flagged. It still differs from the profile's G-code.</p>
      )}
      <div className="pg-diff" role="table" aria-label={`Changes to the ${c.label}`}>
        {c.diff.map((d, i) => (
          <Row key={i} d={d} />
        ))}
      </div>
    </section>
  )
}

function Row({ d }: { d: GcodeDiffLine }) {
  if (d.kind === 'skip')
    return (
      <div className="pg-skip" role="row">
        <span role="cell">{plural(d.count ?? 0, 'unchanged line')}</span>
      </div>
    )
  const flag: GcodeFlag | undefined = d.flags?.find((f) => f.severity === 'error') ?? d.flags?.[0]
  const sign = d.kind === 'added' ? '+' : d.kind === 'removed' ? '-' : ' '
  return (
    <div className="pg-row" role="row" data-kind={d.kind} data-flag={flag?.severity}>
      <span className="pg-num" role="cell">
        {d.kind === 'removed' ? '' : d.line}
      </span>
      <span className="pg-sign" role="cell" aria-label={d.kind === 'added' ? 'added' : d.kind === 'removed' ? 'removed' : undefined}>
        {sign}
      </span>
      <span className="pg-text" role="cell">
        {d.text}
        {flag ? <span className="pg-why">{flag.reason}</span> : null}
      </span>
    </div>
  )
}
