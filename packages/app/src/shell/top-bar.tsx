// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { AppBar, Button, Icon, keymapFor, SearchButton, Tabs } from '@slicerx/ui'
import { useMemo } from 'react'
import { formatShortcut } from '../lib/keys'
import { toggleDock, useDockOpen } from '../features/pilot/dock-state'
import { watchOf } from '../features/pilot/watch'
import { useFeatures, useHasFeature } from '../features'
import { topBarTabs, useLayout, useLookChoice } from '../first-run/look'
import { ModeSelector } from '../first-run/mode-selector'
import { useFleet } from '../lib/queries'
import { openSettings, set, setWorkspace, useApp } from '../state/store'

export function TopBar() {
  const active = useApp((s) => s.workspace)
  const { workspaces: available } = useFeatures()
  const layout = useLayout()
  // One Library tab: Community and Mine are views of it, switched inside.
  const hasFeed = available.some((w) => w.id === 'feed')
  const workspaces = useMemo(() => topBarTabs(available, layout), [available, layout])
  // The search field names the look's command bar key (Space in the OrcaSlicer style); Mod+K works in every look.
  const choice = useLookChoice()
  const palette = keymapFor(choice.id, choice.overrides?.keys ?? {}).palette ?? 'Mod+K'
  const fleet = useFleet()
  const assistant = useHasFeature('pilot')
  const dockOpen = useDockOpen()
  const watch = watchOf(fleet.data ?? [])
  const online = fleet.data?.filter((p) => p.status.state !== 'offline').length ?? 0
  const failing = fleet.data?.some((p) => p.status.state === 'error') ?? false
  const total = fleet.data?.length ?? 0
  // Fleet health is a dot on the Printers tab, not a chip in the bar.
  const tabs = useMemo(() => workspaces.map((w) => (w.id === 'printers' && total > 0 ? { ...w, ...(failing ? { status: 'warn' as const } : online > 0 ? { status: 'ok' as const } : {}) } : w)), [workspaces, online, total, failing])

  return (
    <AppBar
      right={
        <>
          {layout.modeSelector === 'top-right' ? <ModeSelector layout={layout} id="mode-top" /> : null}
          <SearchButton placeholder="Search" onClick={() => set({ commandOpen: true })} shortcut={formatShortcut(palette)} />
          {assistant ? (
            <Button variant="ghost" size="sm" className="mimir-btn" aria-pressed={dockOpen} tip="pilot.ask" onClick={toggleDock}>
              <Icon name="mimir" size={16} />
              {ASSISTANT_NAME}
              {watch.names.length ? <span className="mimir-watch" data-attention={watch.attention ? true : undefined} role="img" aria-label={watch.attention ? `Look at ${watch.names.join(', ')}` : `Watching ${watch.names.join(', ')}`} /> : null}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" icon="settings" tip="nav.settings" aria-label="Settings" onClick={() => openSettings()} />
        </>
      }
    >
      <Tabs tabs={tabs} active={hasFeed && active === 'library' ? 'feed' : active} onChange={setWorkspace} />
    </AppBar>
  )
}
