// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The first tab: Design | Slice, two tab buttons with a thin divider. The open mode is underlined like a selected
// tab; on another tab neither is. Either half opens the first tab in that mode in one step. Both are workspace
// `prepare` underneath; editions without modeling tools show a plain Slice tab instead (top-bar.tsx).
import { Icon } from '@slicerx/ui'
import { Fragment } from 'react'
import { useModelMode } from '../state/model-mode'
import { setModelMode, useApp, type ModelMode } from '../state/store'

const HALVES: readonly { mode: ModelMode; label: string; icon: 'ruler' | 'slice'; tab: string }[] = [
  { mode: 'design', label: 'Design', icon: 'ruler', tab: 'design' },
  // The Slice half keeps the workspace's id, so links and tests that open `prepare` land on the plate.
  { mode: 'slice', label: 'Slice', icon: 'slice', tab: 'prepare' },
]

export function ModeTab() {
  const open = useApp((s) => s.workspace === 'prepare')
  const mode = useModelMode()
  return (
    <div className="sx-modetab" role="group" aria-label="Design or Slice">
      {HALVES.map((h, i) => (
        <Fragment key={h.mode}>
          {i > 0 ? <i className="sx-modetab-sep" aria-hidden="true" /> : null}
          <button type="button" className="sx-tab" data-tab={h.tab} data-mode={h.mode} data-tip={`mode.${h.mode}`} aria-current={open && mode === h.mode ? 'page' : undefined} aria-label={h.label} onClick={() => setModelMode(h.mode)}>
            <Icon name={h.icon} />
            <span>{h.label}</span>
          </button>
        </Fragment>
      ))}
    </div>
  )
}
