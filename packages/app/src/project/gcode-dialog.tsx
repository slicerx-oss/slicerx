// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The project's own printer G-code, shown before a slice uses it: what it changes against the printer profile's text,
// each flagged line with its reason, and the person's choice. The printer profile's G-code is the default.
import type { GcodeChange, GcodeDiffLine, GcodeFlag } from '@slicerx/settings'
import { printerName } from '@slicerx/settings'
import { Button, Dialog } from '@slicerx/ui'
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
  const printer = printerId ? printerName(printerId) : 'printer'
  return (
    <Dialog
      open={open}
      onClose={() => answerProjectGcode(null)}
      title="Check this project's G-code"
      size="lg"
      className="pg"
      testId="project-gcode-dialog"
      splitFooter
      footer={
        <>
          <Button variant="ghost" disabled={!approvable} data-testid="project-gcode-use-project" onClick={() => answerProjectGcode('project')}>
            Use the project's G-code
          </Button>
          <Button variant="primary" autoFocus data-testid="project-gcode-use-profile" onClick={() => answerProjectGcode('profile')}>
            Use the printer profile's G-code instead
          </Button>
        </>
      }
    >
      {p ? (
        <div className="pg-body">
          <p className="pg-lede">
            {p.source} has printer G-code that is not the stock text for the {printer}. It runs on the printer as it is, so check what it changes against the {printer} profile's G-code.
          </p>
          {approvable ? null : (
            <p className="pg-block" role="alert">
              Some lines do things SlicerX never sends to a printer, so only the printer profile's G-code can be used.
            </p>
          )}
          {p.changes.map((c) => (
            <Change key={`${c.key}-${c.slot ?? ''}`} c={c} />
          ))}
        </div>
      ) : null}
    </Dialog>
  )
}

function Change({ c }: { c: GcodeChange }) {
  return (
    <section className="pg-change" aria-label={capital(c.label)}>
      <header className="pg-head">
        <h3>{capital(c.label)}</h3>
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
