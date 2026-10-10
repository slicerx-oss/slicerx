// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The top bar. As the window narrows it gives up room in steps, measured rather than set at fixed widths, so long
// translated labels and other editions fit too: the project name truncates first, then search shrinks to its icon,
// then the tabs drop their labels, then Vault and Printers move into a More menu at the end of the tabs, and Model
// and Slice drop theirs last.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { AppBar, Button, Icon, keymapFor, Menu, MenuAnchor, MenuItem, SearchButton, Tabs, tipAttrs, type TabSpec } from '@slicerx/ui'
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react'
import { formatShortcut } from '../lib/keys'
import { toggleDock, useDockOpen } from '../features/pilot/dock-state'
import { watchOf } from '../features/pilot/watch'
import { useFeatures, useHasFeature } from '../features'
import { topBarTabs, useLayout, useLookChoice } from '../first-run/look'
import { ModeSelector } from '../first-run/mode-selector'
import { useFleet } from '../lib/queries'
import { openSettings, set, setWorkspace, useApp } from '../state/store'
import { ModeTabs } from './mode-tab'
import { useCadShown } from '../state/model-mode'
import './top-bar.css'

/** The narrowing steps, in order: search as an icon, tab labels gone, Vault and Printers in More, Model and Slice labels gone. */
const STEPS = 4
/** The project name keeps at least this much text before anything else gives up room. */
const NAME_MIN_PX = 80
/** The tabs that move into More at step 3, in the menu's order: Printers first, so it is always one click away. */
const OVERFLOW = ['printers', 'feed', 'library'] as const

/** Whether everything in the bar fits at the current step. */
export function barFits(bar: HTMLElement): boolean {
  if (bar.scrollWidth > bar.clientWidth + 1) return false
  const nav = bar.querySelector<HTMLElement>('.sx-tabs')
  if (nav && nav.scrollWidth > nav.clientWidth + 1) return false
  const name = bar.querySelector<HTMLElement>('.sx-projname')
  if (!name || name.offsetParent === null) return true
  // The name truncates inside its bold part, so that is where a cut shows.
  const text = name.querySelector<HTMLElement>('b') ?? name
  if (text.scrollWidth <= text.clientWidth + 1 && name.scrollWidth <= name.clientWidth + 1) return true
  return (text === name ? name.clientWidth - parseFloat(getComputedStyle(name).paddingLeft) : text.clientWidth) >= NAME_MIN_PX
}

/** The narrowest step the bar needs: back to the widest on a resize or a new name, then one step at a time until it fits, before paint. */
function useFitStep(probe: RefObject<HTMLElement | null>, content: string): number {
  const [step, setStep] = useState(0)
  // A resize always renders again, even when the step was already the widest, so the fit is checked at the new width.
  const [, measure] = useReducer((n: number) => n + 1, 0)
  useLayoutEffect(() => {
    const bar = probe.current?.closest<HTMLElement>('.sx-appbar')
    if (bar && step < STEPS && !barFits(bar)) setStep(step + 1)
  })
  useLayoutEffect(() => setStep(0), [content])
  useEffect(() => {
    const bar = probe.current?.closest<HTMLElement>('.sx-appbar')
    if (!bar || typeof ResizeObserver === 'undefined') return
    let width = bar.clientWidth
    const ro = new ResizeObserver(() => {
      if (bar.clientWidth === width) return
      width = bar.clientWidth
      setStep(0)
      measure()
    })
    ro.observe(bar)
    return () => ro.disconnect()
  }, [probe])
  return step
}

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
  // With modeling tools the first tab is the Design | Slice pair; without, a plain Slice tab.
  // A phone shows a plain Slice tab: modeling waits for the desktop.
  const cad = useCadShown()
  const shown = useMemo(() => (cad ? tabs.filter((w) => w.id !== 'prepare') : tabs), [cad, tabs])
  const projectFile = useApp((s) => s.projectFile)
  const nameRef = useRef<HTMLDivElement>(null)
  const step = useFitStep(nameRef, `${projectFile?.name ?? ''}|${shown.map((t) => t.label).join(',')}`)
  const overflow = step >= 3 ? OVERFLOW.flatMap((id) => shown.filter((t) => t.id === id)) : []
  const inBar = overflow.length ? shown.filter((t) => !overflow.includes(t)) : shown
  const activeTab = hasFeed && active === 'library' ? 'feed' : active

  return (
    <AppBar
      data-tauri-drag-region
      data-narrow-search={step >= 1 || undefined}
      data-narrow-tabs={step >= 2 || undefined}
      data-narrow-modes={step >= 4 || undefined}
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
      <Tabs tabs={inBar} active={activeTab} onChange={setWorkspace} lead={cad ? <ModeTabs /> : null} tips={step >= 2} trail={overflow.length ? <MoreTabs tabs={overflow} active={activeTab} /> : null} />
      <div ref={nameRef} className="sx-projname" {...tipAttrs(projectFile ? { title: projectFile.path ?? projectFile.name } : undefined)}>
        {projectFile ? (
          <>
            <b>{projectFile.name.replace(/\.sx3mf$/i, '')}</b>
            {/\.sx3mf$/i.test(projectFile.name) ? '.sx3mf' : null}
          </>
        ) : (
          'Untitled'
        )}
      </div>
    </AppBar>
  )
}

/** More, at the end of the tabs on a narrow window: the tabs that no longer fit, with the Printers status dot. */
function MoreTabs({ tabs, active }: { tabs: readonly TabSpec[]; active: string }) {
  const [open, setOpen] = useState(false)
  const current = tabs.find((t) => t.id === active)
  return (
    <MenuAnchor className="sx-tab-more">
      <button type="button" className="sx-tab" data-testid="tab-overflow" aria-haspopup="menu" aria-expanded={open} aria-label="More tabs" aria-current={current ? 'page' : undefined} {...tipAttrs({ title: current ? current.label : 'More tabs' })} onClick={() => setOpen(!open)}>
        <Icon name={current?.icon ?? 'more'} />
        {tabs.some((t) => t.status) ? <i className={tabs.some((t) => t.status === 'warn') ? 'sx-dot warn tab-dot' : 'sx-dot tab-dot'} aria-hidden="true" /> : null}
      </button>
      <Menu open={open} onClose={() => setOpen(false)} label="More tabs" align="end">
        {tabs.map((t) => (
          <MenuItem key={t.id} icon={t.icon} data-testid={`tab-overflow-${t.id}`} aria-current={t.id === active ? 'page' : undefined} onClick={() => (setOpen(false), setWorkspace(t.id as Parameters<typeof setWorkspace>[0]))}>
            {t.label}
            {t.status ? <i className={t.status === 'warn' ? 'sx-dot warn tab-dot' : 'sx-dot tab-dot'} aria-hidden="true" /> : null}
          </MenuItem>
        ))}
      </Menu>
    </MenuAnchor>
  )
}
