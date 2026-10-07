// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The first tab: Design | Slice, two tab buttons with a thin divider. The open mode is underlined like a selected
// tab; on another tab neither is. Either half opens the first tab in that mode in one step. Both are workspace
// `prepare` underneath; editions without modeling tools show a plain Slice tab instead (top-bar.tsx).
import { Icon } from '@slicerx/ui'
import { Fragment, useRef } from 'react'
import { useFullEngine, warmFullEngine } from '../geom/full-engine'
import { useModelMode } from '../state/model-mode'
import { setModelMode, useApp, type ModelMode } from '../state/store'
import { parkedLabel } from '../workspaces/prepare/parked-chip'

const HALVES: readonly { mode: ModelMode; label: string; icon: 'ruler' | 'slice'; tab: string }[] = [
  { mode: 'design', label: 'Design', icon: 'ruler', tab: 'design' },
  // The Slice half keeps the workspace's id (and test id, tab-prepare), so links and tests that open `prepare` land on
  // the plate.
  { mode: 'slice', label: 'Slice', icon: 'slice', tab: 'prepare' },
]

export function ModeTab() {
  const open = useApp((s) => s.workspace === 'prepare')
  const mode = useModelMode()
  const loading = useFullEngine() === 'loading'
  const rest = useRef<ReturnType<typeof setTimeout>>(undefined)
  // A tool left open in Design: an orange dot on its half, and the tip says which.
  const parked = useApp((s) => (s.parked?.tool ? parkedLabel(s.parked.tool) : null))
  return (
    <div className="sx-modetab" role="group" aria-label="Design or Slice">
      {HALVES.map((h, i) => (
        <Fragment key={h.mode}>
          {i > 0 ? <i className="sx-modetab-sep" aria-hidden="true" /> : null}
          <button
            type="button"
            className="sx-tab"
            data-tab={h.tab}
            data-testid={`tab-${h.tab}`}
            data-mode={h.mode}
            {...(h.mode === 'design' && parked ? { 'data-tip-title': 'Design', 'data-tip-body': `${parked} in progress. Open Design to finish it.`, 'data-parked': '' } : { 'data-tip': `mode.${h.mode}` })}
            aria-current={open && mode === h.mode ? 'page' : undefined}
            aria-label={h.mode === 'design' && parked ? `Design, ${parked} in progress` : h.label}
            aria-busy={h.mode === 'design' && loading ? true : undefined}
            onClick={() => setModelMode(h.mode)}
            // A pointer resting on Design starts the full geometry engine before the click.
            onPointerEnter={h.mode === 'design' ? () => (rest.current = setTimeout(warmFullEngine, 250)) : undefined}
            onPointerLeave={h.mode === 'design' ? () => clearTimeout(rest.current) : undefined}
          >
            <Icon name={h.icon} />
            <span>{h.label}</span>
            {h.mode === 'design' && loading ? <i className="sx-modetab-spin" aria-hidden="true" /> : null}
            {h.mode === 'design' && parked && !loading ? <i className="sx-modetab-dot" aria-hidden="true" /> : null}
          </button>
        </Fragment>
      ))}
    </div>
  )
}
