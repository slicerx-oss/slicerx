// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Help, Report a bug. The person describes the problem; the app attaches the recent log, the version and
// commit, the OS and the printer. The preview shows exactly what will be sent, after scrubbing, and
// sending confirms with a link to the Discord channel. A report that cannot go now waits in the outbox.
import { Button, Dialog, Field, Icon, Input, Textarea } from '@slicerx/ui'
import { useEffect, useMemo, useState } from 'react'
import { useEdition } from '../edition'
import { bugReportsUrl } from './where'
import { openLink } from '../lib/links'
import { get, set, useApp } from '../state/store'
import { logTail } from './log'
import { finishReport, type BugReport, type RawReport } from './report'
import { environment, sendManual, type ManualResult } from './reports'
import './report-dialog.css'

type Env = Pick<RawReport, 'appVersion' | 'commit' | 'os' | 'printer'>
type Phase = { step: 'edit' } | { step: 'preview'; report: BugReport } | { step: 'sending'; report: BugReport } | { step: 'done'; result: ManualResult } | { step: 'error'; message: string; report: BugReport }

export interface BugForm {
  title: string
  happened: string
  steps: string
  expected: string
  printer: string
  attachLog: boolean
}

/** The body column: what happened, the steps and the expected behavior under plain headings. */
export function reportBody(f: Pick<BugForm, 'happened' | 'steps' | 'expected'>): string {
  return [
    ['What happened', f.happened],
    ['Steps to reproduce', f.steps],
    ['Expected behavior', f.expected],
  ]
    .filter(([, v]) => v!.trim())
    .map(([k, v]) => `${k}:\n${v!.trim()}`)
    .join('\n\n')
}

export function buildManualReport(f: BugForm, env: Env, log: string): BugReport {
  return finishReport({ kind: 'manual', title: f.title, body: reportBody(f), stack: null, logTail: f.attachLog ? log : null, appVersion: env.appVersion, commit: env.commit, os: env.os, printer: f.printer.trim() || null })
}

function Row({ label, value, mono = true }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="bug-row">
      <dt>{label}</dt>
      <dd>{value === null ? <span className="sx-dim">(none)</span> : mono ? <pre className="bug-pre">{value}</pre> : value}</dd>
    </div>
  )
}

/** Every field of the payload, as it will be stored. */
export function ReportPreview({ report }: { report: BugReport }) {
  return (
    <dl className="bug-preview" data-testid="bug-preview">
      <Row label="kind" value={report.kind} />
      <Row label="title" value={report.title} />
      <Row label="body" value={report.body} />
      <Row label="app_version" value={report.appVersion} />
      <Row label="commit" value={report.commit} />
      <Row label="os" value={report.os} />
      <Row label="printer" value={report.printer} />
      <Row label="stack" value={report.stack} />
      <Row label="fingerprint" value={report.fingerprint} />
      <Row label="log_tail" value={report.logTail} />
    </dl>
  )
}

export function BugReportDialog() {
  const open = useApp((s) => s.bugReportOpen)
  const edition = useEdition()
  const url = bugReportsUrl(edition)
  const [env, setEnv] = useState<Env | null>(null)
  const [form, setForm] = useState<BugForm>({ title: '', happened: '', steps: '', expected: '', printer: '', attachLog: true })
  const [phase, setPhase] = useState<Phase>({ step: 'edit' })
  const log = useMemo(() => (open ? logTail() : ''), [open, phase.step])
  const close = () => set({ bugReportOpen: false })

  useEffect(() => {
    if (!open) return
    setPhase({ step: 'edit' })
    const draft = get().bugReportDraft
    if (draft) {
      setForm((f) => ({ ...f, title: draft.title, happened: draft.happened }))
      set({ bugReportDraft: null })
    }
    let gone = false
    void environment().then((e) => {
      if (gone) return
      setEnv(e)
      setForm((f) => (f.printer ? f : { ...f, printer: e.printer ?? '' }))
    })
    return () => {
      gone = true
    }
  }, [open])

  const patch = (p: Partial<BugForm>) => setForm((f) => ({ ...f, ...p }))
  const ready = form.title.trim().length > 0 && form.happened.trim().length > 0 && env !== null
  const logLines = log ? log.split('\n').length : 0

  const send = async (report: BugReport) => {
    setPhase({ step: 'sending', report })
    try {
      const result = await sendManual(report)
      setPhase({ step: 'done', result })
      if (result.status === 'sent') setForm({ title: '', happened: '', steps: '', expected: '', printer: form.printer, attachLog: true })
    } catch (e) {
      setPhase({ step: 'error', message: e instanceof Error ? e.message : String(e), report })
    }
  }

  // A fork without a bug report link of its own shows no channel.
  const discord = url ? (
    <Button variant="ghost" icon="external" onClick={() => void openLink(url)}>
      Open the bug-reports channel
    </Button>
  ) : null

  let footer
  let body
  if (phase.step === 'edit') {
    footer = (
      <>
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={!ready} onClick={() => env && setPhase({ step: 'preview', report: buildManualReport(form, env, log) })}>
          Preview report
        </Button>
      </>
    )
    body = (
      <div className="bug-form">
        <Field htmlFor="bug-title" label="Title">
          <Input id="bug-title" value={form.title} maxLength={200} placeholder="Preview shows no toolpaths after slicing" onChange={(e) => patch({ title: e.target.value })} />
        </Field>
        <Field htmlFor="bug-happened" label="What happened">
          <Textarea id="bug-happened" rows={3} value={form.happened} onChange={(e) => patch({ happened: e.target.value })} />
        </Field>
        <Field htmlFor="bug-steps" label="Steps to reproduce" hint="Optional. Numbered steps help most.">
          <Textarea id="bug-steps" rows={3} value={form.steps} placeholder={'1. Open the example plate\n2. Slice\n3. Open Preview'} onChange={(e) => patch({ steps: e.target.value })} />
        </Field>
        <Field htmlFor="bug-expected" label="Expected behavior" hint="Optional.">
          <Textarea id="bug-expected" rows={2} value={form.expected} onChange={(e) => patch({ expected: e.target.value })} />
        </Field>
        <Field htmlFor="bug-printer" label="Printer" hint="Model and firmware. Edit it if it is wrong or missing.">
          <Input id="bug-printer" value={form.printer} maxLength={120} placeholder="None" onChange={(e) => patch({ printer: e.target.value })} />
        </Field>
        <div className="bug-attached">
          <p className="bug-attached-title">Attached</p>
          <ul className="sx-mono sx-small">
            <li>Version {env?.appVersion ?? '…'}, commit {env?.commit.slice(0, 12) ?? '…'}</li>
            <li>{env?.os ?? '…'}</li>
          </ul>
          <label className="bug-check">
            <input type="checkbox" checked={form.attachLog} onChange={(e) => patch({ attachLog: e.target.checked })} />
            Attach the recent app log ({logLines} {logLines === 1 ? 'line' : 'lines'})
          </label>
          <p className="sx-small sx-dim">Tokens, keys, access codes, serial numbers, IP addresses, emails and your user name in folder paths are removed before sending. The preview shows the result.</p>
        </div>
      </div>
    )
  } else if (phase.step === 'preview' || phase.step === 'sending') {
    footer = (
      <>
        <Button variant="ghost" icon="arrow-left" disabled={phase.step === 'sending'} onClick={() => setPhase({ step: 'edit' })}>Back</Button>
        <Button variant="primary" icon="send" disabled={phase.step === 'sending'} onClick={() => void send(phase.report)}>
          {phase.step === 'sending' ? 'Sending' : 'Send report'}
        </Button>
      </>
    )
    body = (
      <>
        <p className="bug-lede">This is exactly what will be sent, after scrubbing.</p>
        <ReportPreview report={phase.report} />
      </>
    )
  } else if (phase.step === 'done') {
    footer = (
      <>
        {discord}
        <Button variant="primary" onClick={close}>Close</Button>
      </>
    )
    body =
      phase.result.status === 'sent' ? (
        <div className="bug-done" role="status">
          <Icon name="check" size={20} />
          <div>
            <p className="bug-done-title">Report sent</p>
            <p>
              {url ? (
                <>
                  It goes to the bug-reports channel on Discord within a few minutes{phase.result.id ? <>, as report <span className="sx-mono">{phase.result.id.slice(0, 8)}</span></> : null}. Follow it there or add screenshots: <span className="sx-mono bug-url">{url}</span>
                </>
              ) : (
                <>It reached the {edition.brand.name} team{phase.result.id ? <>, as report <span className="sx-mono">{phase.result.id.slice(0, 8)}</span></> : null}.</>
              )}
            </p>
          </div>
        </div>
      ) : (
        <div className="bug-done" role="status" data-tone="queued">
          <Icon name="cloud-off" size={20} />
          <div>
            <p className="bug-done-title">Saved to send later</p>
            <p>The report could not be sent now ({phase.result.reason}). It is saved on this computer and goes out the next time {edition.brand.name} starts.{url ? <> You can also post it in the bug-reports channel: <span className="sx-mono bug-url">{url}</span></> : null}</p>
          </div>
        </div>
      )
  } else {
    footer = (
      <>
        <Button variant="ghost" icon="arrow-left" onClick={() => setPhase({ step: 'edit' })}>Back</Button>
        {discord}
      </>
    )
    body = (
      <div className="bug-done" role="alert" data-tone="error">
        <Icon name="alert" size={20} />
        <div>
          <p className="bug-done-title">The report was refused</p>
          <p>{phase.message}. Shorten the text and try again{url ? <>, or post it in the bug-reports channel: <span className="sx-mono bug-url">{url}</span></> : '.'}</p>
        </div>
      </div>
    )
  }

  return (
    <Dialog open={open} onClose={close} title="Report a bug" size="lg" className="bug-dialog" footer={footer} splitFooter={phase.step !== 'edit'}>
      {body}
    </Dialog>
  )
}
