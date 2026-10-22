// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors

export interface SteadyProps {
  /** What the label says now. */
  text: string
  /** Every form the label can take, the current one included or not; the label keeps the width of the widest. */
  forms: readonly string[]
  /** Where a narrower form sits in the reserved width: centered (a button) or at the start (a readout). */
  align?: 'center' | 'start'
  /** Cut with an ellipsis when even the box it sits in is narrower than the widest form (a pill with a cap). */
  clip?: boolean
}

/**
 * A label that keeps the width of its widest form, so its control never changes size when the words change: Show and
 * Hide, Change and Cancel, a tool's verb while it works, the sketch tool in the view's mode pill. The other forms are
 * drawn hidden under it from an attribute, so a screen reader reads only the current one.
 */
export function Steady({ text, forms, align = 'center', clip = false }: SteadyProps) {
  return (
    <span className="sx-steady" data-align={align === 'start' ? 'start' : undefined} data-clip={clip ? '' : undefined}>
      {[...new Set(forms)]
        .filter((f) => f !== text)
        .map((f) => (
          <span key={f} className="sx-steady-sizer" aria-hidden="true" data-sizer={f} />
        ))}
      <span>{text}</span>
    </span>
  )
}
