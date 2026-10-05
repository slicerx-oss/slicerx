// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// After a preset import, in setup and in Settings > Presets: per preset, every setting that did not carry over with
// the value it had, why, and what SlicerX uses instead. Each preset folds open on its own; the whole report saves as
// text. Setting keys show only in developer mode.
import { defaultedText, insteadText, parentText, reasonText, type ImportReport } from '@slicerx/settings'
import { Button, Icon } from '@slicerx/ui'
import { useHost } from '../host'
import { useApp } from '../state/store'
import { importSummary, type ImportResult } from './import-result'
import { reportPresetError } from './presets'

const KIND_WORD = { process: 'Process', filament: 'Filament', printer: 'Printer' } as const

function PresetReport({ report, keys }: { report: ImportReport; keys: boolean }) {
  const n = report.items.length
  const parent = parentText(report)
  const defaulted = defaultedText(report)
  return (
    <details className="imp-preset" data-clean={n === 0 ? 'true' : undefined}>
      <summary>
        <span className="imp-name">{report.name}</span>
        <span className="imp-count">
          {KIND_WORD[report.section]} preset, {n === 0 ? 'every setting carried over' : `${n} ${n === 1 ? 'setting' : 'settings'} did not carry over`}
        </span>
      </summary>
      {parent ? <p className="imp-note">{parent}</p> : null}
      {n ? (
        <ul className="imp-items">
          {report.items.map((it) => (
            <li key={`${it.key}-${it.reason}`} className="imp-item">
              <span className="imp-label">
                {it.label}
                {keys ? <code className="imp-key">{it.key}</code> : null}
              </span>
              <span className="imp-was">Was {it.oldValue}. {reasonText(it.reason)}.</span>
              <span className="imp-now">{insteadText(it)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {defaulted ? <p className="imp-note">{defaulted}</p> : null}
    </details>
  )
}

/** The summary line, the report of each imported preset and the files that could not be imported. */
export function ImportReportView({ results }: { results: readonly ImportResult[] }) {
  const host = useHost()
  const keys = useApp((s) => s.settingsMode === 'developer')
  const reports = results.filter((r) => r.ok && r.report)
  const failed = results.filter((r) => !r.ok)
  const save = async () => {
    const { importReportText } = await import('./import-files')
    const text = await importReportText(results, keys)
    await host.files.save('slicerx-import-report.txt', new Blob([text], { type: 'text/plain' }), { accept: ['.txt'] })
  }
  return (
    <div className="imp-report" role="status">
      <p className="imp-sum">
        <Icon name={results.some((r) => r.ok) ? 'check' : 'alert'} size={16} /> {importSummary(results)}
      </p>
      {reports.length ? (
        <div className="imp-list">
          {reports.map((r, i) => (
            <PresetReport key={`${r.name}-${i}`} report={r.report!} keys={keys} />
          ))}
        </div>
      ) : null}
      {failed.map((r, i) => (
        <p key={`${r.name}-${i}`} className="imp-fail">
          <span className="sx-mono">{r.name}</span>: {r.message}
        </p>
      ))}
      {reports.length ? (
        <div className="imp-act">
          <Button size="sm" variant="ghost" icon="export" onClick={() => void save().catch(reportPresetError)}>
            Save report
          </Button>
        </div>
      ) : null}
    </div>
  )
}
