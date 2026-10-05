// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { segs } from './format'

/** mimir's prose with `code` spans and **bold** runs, and the cursor while it streams. */
export function Say({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="say">
      {segs(text).map((s, i) =>
        s.kind === 'code' ? (
          <span key={i} className="code">
            {s.text}
          </span>
        ) : s.kind === 'bold' ? (
          <b key={i}>{s.text}</b>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
      {streaming ? <span className="cur" aria-hidden="true" /> : null}
    </div>
  )
}
