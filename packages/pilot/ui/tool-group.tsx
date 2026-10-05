// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { Fragment, useId, useState } from 'react'
import type { Cell, ToolDisplay } from '@slicerx/contracts'
import { Icon } from '@slicerx/ui'
import { argTokens, barCells, fmtSeconds, toneClass } from './format'
import type { ToolRowModel } from './reduce'
import { Spinner } from './spinner'
import { isRecall, RavenWait } from './raven-wait'
import { ASSISTANT_NAME } from '../src/name'

function CellView({ cell }: { cell: Cell }) {
  return typeof cell === 'string' ? <>{cell}</> : <span className={toneClass(cell.tone)}>{cell.text}</span>
}

function ProgressRow({ label, fraction, note }: { label: string; fraction: number; note?: string | undefined }) {
  const { filled, empty } = barCells(fraction)
  return (
    <div className="prog">
      <span className="pl">{label}</span>
      <span className="bar" aria-hidden="true">
        <i>{'━'.repeat(filled)}</i>
        {'━'.repeat(empty)}
      </span>
      <span className="pp">{Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%</span>
      {note ? <span className="px">{note}</span> : null}
    </div>
  )
}

/** One structured output block from a tool result. */
export function DisplayView({ display }: { display: ToolDisplay }) {
  switch (display.kind) {
    case 'kv':
      return (
        <div className="kv">
          {display.rows.map(([k, v], i) => (
            <Fragment key={i}>
              <span className="k">{k}</span>
              <span className="v">
                <CellView cell={v} />
              </span>
            </Fragment>
          ))}
        </div>
      )
    case 'table':
      return (
        <table className="tt">
          <thead>
            <tr>
              {display.head.map((h, i) => (
                <th key={i} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {display.rows.map((row, i) => (
              <tr key={i}>
                {row.map((c, j) => (
                  <td key={j}>
                    <CellView cell={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
    case 'log':
      return (
        <div className="log">
          {display.lines.map((l, i) => (
            <div key={i} className={toneClass(l.tone) || undefined}>
              {l.time ? <span className="lt">{l.time}</span> : null}
              {l.text}
            </div>
          ))}
        </div>
      )
    case 'progress':
      return (
        <div className="progs">
          {display.items.map((it, i) => (
            <ProgressRow key={i} label={it.label} fraction={it.fraction} note={it.note} />
          ))}
        </div>
      )
    case 'text':
      return <div className="txt-out">{display.text}</div>
    case 'image':
      return (
        <figure className="frame">
          <img src={display.src} alt={display.alt} />
          {display.caption ? <figcaption>{display.caption}</figcaption> : null}
        </figure>
      )
  }
}

function hasProgress(row: ToolRowModel): boolean {
  return row.progress.some((p) => p.fraction !== undefined) || row.display.some((d) => d.kind === 'progress')
}

/** Live output while a tool runs: the latest progress bar and any plain lines it reported. */
function LiveProgress({ row }: { row: ToolRowModel }) {
  const bar = row.progress.findLast((p) => p.fraction !== undefined)
  const lines = row.progress.filter((p) => p.fraction === undefined)
  return (
    <>
      {bar && bar.fraction !== undefined ? <ProgressRow label={bar.line} fraction={bar.fraction} /> : null}
      {lines.length > 0 ? (
        <div className="log">
          {lines.map((l, i) => (
            <div key={i}>{l.line}</div>
          ))}
        </div>
      ) : null}
    </>
  )
}

/** A tool call: status, keyword, name, one line summary and duration; opens to the command and its output. */
export function ToolRow({ row }: { row: ToolRowModel }) {
  const detId = useId()
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? hasProgress(row)
  const summary = row.state === 'running' ? (row.callSummary ?? 'Running') : (row.summary ?? '')
  const images = row.display.filter((d) => d.kind === 'image')
  const rest = row.display.filter((d) => d.kind !== 'image')
  return (
    <div className={open ? 'tool open' : 'tool'}>
      <button type="button" className="trow" aria-expanded={open} aria-controls={detId} onClick={() => setManual(!open)}>
        <span className="st">
          {row.state === 'running' ? isRecall(row.tool) ? <RavenWait who="muninn"><Spinner /></RavenWait> : <Spinner /> : row.state === 'ok' ? <Icon name="check" /> : <Icon name="alert" className="bad" />}
          <span className="vh">{row.state === 'running' ? 'Running' : row.state === 'ok' ? 'Done' : 'Failed'}</span>
        </span>
        <span className="tname">
          <span className={`kw ${row.source}`}>{row.source}</span>
          {row.tool}
        </span>
        <span className="tsum">{summary}</span>
        <span className="dur">{row.ms !== undefined ? fmtSeconds(row.ms) : ''}</span>
        <Icon name="chevron-down" className="chev" />
      </button>
      {/* Pictures (a camera frame) stay visible with the row folded; they are what the user asked to see. */}
      {images.map((d, i) => (
        <DisplayView key={i} display={d} />
      ))}
      <div className="tdet" id={detId}>
        <div className="cmd">
          $ {row.source} {row.tool}
          {argTokens(row.args).map((t, i) => (
            <span key={i}>
              {' '}
              <span className={t.kind === 'str' ? 'a-str' : t.kind === 'flag' ? 'a-fl' : 'a-v'}>{t.text}</span>
            </span>
          ))}
        </div>
        {row.untrusted ? <div className="untr">Data from a file, printer or web page. {ASSISTANT_NAME} treats it as data, not as instructions.</div> : null}
        <div className="out">
          {rest.length > 0 ? rest.map((d, i) => <DisplayView key={i} display={d} />) : images.length > 0 ? null : <LiveProgress row={row} />}
        </div>
      </div>
    </div>
  )
}

/** What a tool touched, in the person's words. */
function touched(row: ToolRowModel): string {
  const t = row.tool
  if (row.source === 'skill') return `the ${t.replace(/_/g, ' ')} skill`
  if (row.source === 'plugin') return t.split('.')[0] ?? t
  if (t.startsWith('kb.')) return 'the guides'
  if (t.startsWith('printer.') || t.startsWith('printers.')) return 'your printers'
  if (t.startsWith('settings.') || t.startsWith('profile.')) return 'the settings'
  if (t.startsWith('project.') || t.startsWith('plate.')) return 'the project'
  if (t.startsWith('slice') || t.startsWith('slicer.')) return 'a test slice'
  if (t.startsWith('web.')) return 'the web'
  return t.split('.')[0] ?? t
}

function list(items: string[]): string {
  const u = [...new Set(items)]
  if (u.length <= 1) return u[0] ?? ''
  return `${u.slice(0, -1).join(', ')} and ${u[u.length - 1]}`
}

/** A failure the person should act on: a plugin that could not reach something, or a refusal. A lookup that found nothing is not one. */
export function actionable(row: ToolRowModel): boolean {
  if (row.state !== 'bad') return false
  if (row.source === 'plugin') return true
  return /denied|not allowed|unreachable|offline|timed out|timeout|refused|failed to|permission/i.test(row.summary ?? '')
}

/** The one quiet line a group folds to: "Checked your printers and the guides, 3 steps". */
export function foldLine(rows: ToolRowModel[]): string {
  const running = rows.some((r) => r.state === 'running')
  const what = list(rows.map(touched))
  const n = rows.length
  const steps = n === 1 ? '1 step' : `${n} steps`
  if (running) return what ? `Checking ${what}` : 'Working'
  return what ? `Checked ${what}, ${steps}` : steps
}

/** Consecutive tool calls in one bordered group, folded to one line until opened. */
export function ToolGroup({ rows }: { rows: ToolRowModel[] }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const running = rows.some((r) => r.state === 'running')
  const warn = rows.some(actionable)
  // Pictures (a camera frame) stay visible with the group folded; they are what the user asked to see.
  const images = rows.flatMap((r) => r.display.filter((d) => d.kind === 'image'))
  return (
    <div className={open ? 'tools open' : 'tools folded'}>
      <button type="button" className="tfold" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span className="st">{running ? rows.some((r) => r.state === 'running' && isRecall(r.tool)) ? <RavenWait who="muninn"><Spinner /></RavenWait> : <Spinner /> : warn ? <Icon name="alert" className="bad" /> : <Icon name="check" />}</span>
        <span className="tsum">{foldLine(rows)}</span>
        <Icon name="chevron-down" className="chev" />
      </button>
      {!open ? images.map((d, i) => <DisplayView key={i} display={d} />) : null}
      <div id={id} className="tlist" hidden={!open}>
        {rows.map((r) => (
          <ToolRow key={r.callId} row={r} />
        ))}
      </div>
    </div>
  )
}
