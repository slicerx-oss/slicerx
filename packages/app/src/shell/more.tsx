// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Progressive disclosure: a section shows its basics, and "More" opens the rest in place. Advanced
// and Expert open every section at once. Hidden values are kept; a dot on More says one changed.
import { LinkButton } from '@slicerx/ui'
import { effectiveMode, useLayout } from '../first-run/look'
import { set, useApp } from '../state/store'

/** True when a section's second tier is showing: the mode is above Simple, or the person opened it. */
export function useMore(id: string): boolean {
  const layout = useLayout()
  const mode = effectiveMode(useApp((s) => s.settingsMode), layout)
  const opened = useApp((s) => s.moreOpen[id] === true)
  return mode !== 'simple' || opened
}

/** The More button for a section. Absent above Simple mode, where everything is open. */
export function MoreButton({ id, changed }: { id: string; changed?: boolean }) {
  const layout = useLayout()
  const mode = effectiveMode(useApp((s) => s.settingsMode), layout)
  const opened = useApp((s) => s.moreOpen[id] === true)
  if (mode !== 'simple') return null
  return (
    <LinkButton className="more-btn" expanded={opened} aria-label={opened ? 'Show less' : changed ? 'More, changed from default' : 'More'} onClick={() => set((s) => ({ moreOpen: { ...s.moreOpen, [id]: !opened } }))} data-more={id}>
      {opened ? 'Less' : 'More'}
      {changed && !opened ? <span className="more-dot" aria-hidden="true" /> : null}
    </LinkButton>
  )
}
