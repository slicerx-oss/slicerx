// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Names in buttons and chips stay on one line: a long one is cut in the middle, keeping its start and its end (a file
// name's extension), and the whole name is in the tooltip and the accessible name of the control around it.
import './short-name.css'

/** A printer's name as a button shows it: a project's own printer drops its " from <project>" (kept in the tooltip). */
export function shortPrinterName(name: string): string {
  return name.replace(/\s+from\s+.+$/i, '') || name
}

/** The name in two pieces for a cut in the middle: the end keeps the last `keep` characters with any extension. */
export function splitForMiddle(name: string, keep = 10): [string, string] {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : ''
  const base = ext ? name.slice(0, dot) : name
  const tail = Math.min(base.length, Math.max(0, keep - ext.length))
  return [base.slice(0, base.length - tail), base.slice(base.length - tail) + ext]
}

/** One line, cut in the middle when it does not fit; its text reads as the whole name. */
export function MiddleName({ name, className }: { name: string; className?: string }) {
  const [head, tail] = splitForMiddle(name)
  return (
    <span className={className ? `mid-name ${className}` : 'mid-name'}>
      <span className="mid-head">{head}</span>
      <span className="mid-tail">{tail}</span>
    </span>
  )
}
