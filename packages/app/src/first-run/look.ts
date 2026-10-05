// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The shell side of look and feel: which preset is active, applying its look to the document,
// reading its layout, and opening the setup flow. Small on purpose; the setup screens themselves
// load on demand from ./first-run.tsx.
import type { CommandSpec, LayoutSpec, LookAndFeelChoice, LookAndFeelPreset, LookId } from '@slicerx/contracts'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { applyPreset, resolvePreset } from '@slicerx/ui'
import { useEffect, useMemo } from 'react'
import { useEdition } from '../edition'
import type { ActiveWorkspace } from '../features'
import { get, openSettings, set, useApp, type SettingsMode, type SetupStep } from '../state/store'

/** The stored choice, or the edition's default before the person picked one. */
export function useLookChoice(): LookAndFeelChoice {
  const stored = useApp((s) => s.lookAndFeel)
  const edition = useEdition()
  return useMemo(() => stored ?? { id: edition.firstRun.defaultLook }, [stored, edition])
}

/** The active preset. A look is a control preset: mouse map, keymap and tab names; layout and look are SlicerX's for everyone and the theme owns color. */
export function presetFor(choice: LookAndFeelChoice): LookAndFeelPreset {
  return resolvePreset(choice.id)
}

export function usePreset(): LookAndFeelPreset {
  const choice = useLookChoice()
  return useMemo(() => presetFor(choice), [choice])
}

export function useLayout(): LayoutSpec {
  return usePreset().layout
}

/** The names the tabs have when a look does not rename them. */
const BASE_TAB_LABEL: Readonly<Record<string, string>> = { prepare: 'Prepare', preview: 'Preview', printers: 'Printers', library: 'Library', feed: 'Library', pilot: 'mimir' }

/** What a look calls a workspace tab ("Model", "Prepare" or "Plater" for `prepare`). Every sentence that points at a tab uses this, never a literal name. The id stays the same everywhere else. */
export function tabLabel(layout: LayoutSpec, id: string): string {
  return layout.tabLabels?.[id] ?? BASE_TAB_LABEL[id] ?? id
}

/** The active look's name for one tab, for sentences that tell people where to click. */
export function useTabLabel(id: string): string {
  return tabLabel(useLayout(), id)
}

function systemDark(): boolean {
  return typeof window === 'undefined' || !window.matchMedia ? true : window.matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * Keeps the document in step with the active preset. Runs after the theme is applied (a passive
 * effect under the ThemeProvider's layout effect), because the accent points at theme colors.
 */
export function useApplyLook(): void {
  const preset = usePreset()
  const scheme = useApp((s) => s.scheme)
  const follow = useApp((s) => s.themeFollowsSystem)
  useEffect(() => {
    applyPreset(preset)
  }, [preset, scheme])
  useEffect(() => {
    if (!follow || typeof window === 'undefined' || !window.matchMedia) return
    const m = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => set({ scheme: m.matches ? 'dark' : 'light' })
    sync()
    m.addEventListener('change', sync)
    return () => m.removeEventListener('change', sync)
  }, [follow])
}

/** The theme every look starts with: the SlicerX one (dark). The theme owns color, not the look; the person changes it in Settings. */
export function themeForPreset(_id: LookId): { scheme: 'dark' | 'light'; follow: boolean } {
  return { scheme: 'dark', follow: false }
}

/** Tabs in the preset's order and names. Workspaces the build lacks are skipped; ones the preset does not name keep their place at the end. */
export function orderWorkspaces(workspaces: readonly ActiveWorkspace[], layout: LayoutSpec): ActiveWorkspace[] {
  const rank = (id: string) => {
    const i = layout.workspaceTabs.indexOf(id)
    return i < 0 ? layout.workspaceTabs.length : i
  }
  return [...workspaces]
    .map((w, i) => ({ w, i }))
    .sort((a, b) => rank(a.w.id) - rank(b.w.id) || a.i - b.i)
    .map(({ w }) => (layout.tabLabels?.[w.id] ? { ...w, label: layout.tabLabels[w.id] ?? w.label } : w))
}

/** The tabs the top bar shows: the preset's order and names, with one Library tab when the build has the community feed (Mine is a view of it). */
export function topBarTabs(workspaces: readonly ActiveWorkspace[], layout: LayoutSpec): ActiveWorkspace[] {
  const hasFeed = workspaces.some((w) => w.id === 'feed')
  return orderWorkspaces(workspaces, layout).filter((w) => !(hasFeed && w.id === 'library'))
}

/** The settings mode, limited to the modes the preset offers. */
export function effectiveMode(mode: SettingsMode, layout: LayoutSpec): SettingsMode {
  if (layout.modes.includes(mode)) return mode
  // Bambu style has Simple and Advanced only: Expert and Developer read as Advanced there.
  return layout.modes.includes('advanced') ? 'advanced' : (layout.modes[0] ?? 'advanced')
}

export function openSetup(step: SetupStep = 'printer', o: { byHand?: boolean } = {}): void {
  set({ setup: { step, ...(o.byHand ? { byHand: true } : {}) }, commandOpen: false, aboutOpen: false })
}

/** Resume where setup was left, or start over when it was finished. */
export function resumeSetup(): void {
  const fr = get().firstRun
  openSetup(fr && !fr.completedAt && fr.step === 'look' ? 'look' : 'printer')
}

export function setupCommands(): CommandSpec[] {
  return [
    { id: 'setup-look', title: 'Change look and feel', section: 'settings', keywords: ['preset', 'slicer', 'bambu studio style', 'prusaslicer style', 'orcaslicer style', 'mouse', 'controls', 'shortcuts', 'import presets'], run: () => openSetup('look') },
    { id: 'setup-printer', title: 'Add a printer with guided setup', section: 'printers', keywords: ['new printer', 'connect', 'onboarding', 'nozzle'], run: () => openSetup('printer') },
    { id: 'pilot-connect', title: `Connect ${ASSISTANT_NAME}`, section: 'settings', keywords: ['assistant', 'model', 'api key', 'openai', 'anthropic', 'ollama', 'lm studio'], run: () => openSettings('pilot') },
    { id: 'setup-run', title: 'Run first-time setup', section: 'settings', keywords: ['welcome', 'onboarding', 'first run', 'setup'], run: resumeSetup },
  ]
}
