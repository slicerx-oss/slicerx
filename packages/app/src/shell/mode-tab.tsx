// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The first two tabs: Model and Slice. Both are workspace `prepare` underneath, in its two modes, so links, hand-offs
// and anything that opens `prepare` behave as before; the open mode's tab is the current page, and on another tab
// neither is. Editions without modeling tools show a plain Slice tab instead (top-bar.tsx).
import { Icon } from '@slicerx/ui'
import { useRef } from 'react'
import { useFullEngine, warmFullEngine } from '../geom/full-engine'
import { useModelMode } from '../state/model-mode'
import { setModelMode, useApp, type ModelMode } from '../state/store'

const MODES: readonly { mode: ModelMode; label: string; icon: 'model' | 'slice'; tab: string; tip: string }[] = [
  { mode: 'design', label: 'Model', icon: 'model', tab: 'model', tip: 'mode.model' },
  // Slice keeps the workspace's id (and test id, tab-prepare), so links and tests that open `prepare` land on the plate.
  { mode: 'slice', label: 'Slice', icon: 'slice', tab: 'prepare', tip: 'mode.slice' },
]

export function ModeTabs() {
  const open = useApp((s) => s.workspace === 'prepare')
  const mode = useModelMode()
  const loading = useFullEngine() === 'loading'
  const rest = useRef<ReturnType<typeof setTimeout>>(undefined)
  // A tool left open in Model: an orange dot on its tab; the tip and the description say which.
  const parked = useApp((s) => (s.parked?.tool ? (s.parked.label ?? 'A tool') : null))
  return MODES.map((m) => {
    const model = m.mode === 'design'
    return (
      <button
        key={m.mode}
        type="button"
        className="sx-tab"
        data-tab={m.tab}
        data-testid={`tab-${m.tab}`}
        // tab-design is the Model tab's old id, kept while the release gate moves to tab-model.
        {...(model ? { 'data-testid-alias': 'tab-design' } : {})}
        data-mode={m.mode}
        data-tip={m.tip}
        {...(model && parked ? { 'aria-description': `${parked} in progress`, 'data-parked': '' } : {})}
        aria-current={open && mode === m.mode ? 'page' : undefined}
        aria-label={m.label}
        aria-busy={model && loading ? true : undefined}
        onClick={() => setModelMode(m.mode)}
        // A pointer resting on Model starts the full geometry engine before the click.
        onPointerEnter={model ? () => (rest.current = setTimeout(warmFullEngine, 250)) : undefined}
        onPointerLeave={model ? () => clearTimeout(rest.current) : undefined}
      >
        <Icon name={m.icon} />
        <span>{m.label}</span>
        {model && loading ? <i className="sx-modetab-spin" aria-hidden="true" /> : null}
        {model && parked && !loading ? <i className="sx-modetab-dot" aria-hidden="true" /> : null}
      </button>
    )
  })
}
