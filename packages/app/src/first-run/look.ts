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
import { usePhoneLayout } from '../lib/phone-layout'
import type { ActiveWorkspace } from '../features'
import type { Appearance } from '../state/prefs'
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
  const layout = usePreset().layout
  const phone = usePhoneLayout()
  return useMemo(() => (phone ? phoneLayout(layout) : layout), [phone, layout])
}

/**
 * The layout on a phone, which views and prints: Simple settings only, with no mode selector in the panes and no
 * Global and Objects switch. The person's saved mode stays as it is, for a wider screen.
 */
export function phoneLayout(layout: LayoutSpec): LayoutSpec {
  return { ...layout, modes: ['simple'], modeSelector: 'preferences-only', globalObjectSwitch: false }
}

/** The names the tabs have when a look does not rename them. */
const BASE_TAB_LABEL: Readonly<Record<string, string>> = { prepare: 'Slice', printers: 'Printers', library: 'Vault', feed: 'Vault', pilot: 'mimir' }

/** What a look calls a workspace tab ("Slice" for `prepare` in every look; Bambu and Orca call Printers "Device"). Every sentence that points at a tab uses this, never a literal name. The id stays the same everywhere else. */
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
  const density = useApp((s) => s.appearance.density)
  const accent = useApp((s) => s.appearance.accent)
  // the theme changes with the appearance too: contrast and color vision rebuild it, so the accent is set again after
  const contrast = useApp((s) => s.appearance.contrast)
  const vision = useApp((s) => s.appearance.colorVision)
  useEffect(() => {
    applyPreset(withAppearance(preset, density, accent))
  }, [preset, scheme, density, accent, contrast, vision])
  useEffect(() => {
    if (!follow || typeof window === 'undefined' || !window.matchMedia) return
    const m = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => set({ scheme: m.matches ? 'dark' : 'light' })
    sync()
    m.addEventListener('change', sync)
    return () => m.removeEventListener('change', sync)
  }, [follow])
}

const DENSITY = { compact: 'compact', comfortable: 'standard', roomy: 'roomy' } as const

/** The preset with the person's density and accent from Settings > Look and feel on top. */
export function withAppearance(preset: LookAndFeelPreset, density: Appearance['density'], accent: Appearance['accent']): LookAndFeelPreset {
  return { ...preset, look: { ...preset.look, density: DENSITY[density], ...(accent === 'theme' ? {} : { accent }) } }
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

/** The tabs the top bar shows: the preset's order and names, with one Vault tab when the build has the community feed (Mine is a view of it). */
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

export function openSetup(step: SetupStep = 'theme', o: { byHand?: boolean } = {}): void {
  set({ setup: { step, ...(o.byHand ? { byHand: true } : {}) }, commandOpen: false, aboutOpen: false })
}

/** Resume where setup was left, or start over when it was finished. */
export function resumeSetup(): void {
  const fr = get().firstRun
  openSetup(fr && !fr.completedAt && fr.step !== 'done' ? fr.step : 'theme')
}

export function setupCommands(): CommandSpec[] {
  return [
    { id: 'setup-theme', title: 'Pick a theme', section: 'settings', keywords: ['dark mode', 'light mode', 'colors', 'catppuccin', 'dracula', 'nord', 'github', 'tokyo night', 'solarized', 'subban'], run: () => openSettings('look') },
    { id: 'setup-look', title: 'Change look and feel', section: 'settings', keywords: ['preset', 'slicer', 'bambu studio style', 'prusaslicer style', 'orcaslicer style', 'mouse', 'controls', 'shortcuts', 'import presets'], run: () => openSetup('look') },
    { id: 'setup-printer', title: 'Add a printer with guided setup', section: 'printers', keywords: ['new printer', 'connect', 'onboarding', 'nozzle'], run: () => openSetup('printer') },
    { id: 'pilot-connect', title: `Connect ${ASSISTANT_NAME}`, section: 'settings', keywords: ['assistant', 'model', 'api key', 'openai', 'anthropic', 'ollama', 'lm studio'], run: () => openSettings('pilot') },
    { id: 'setup-run', title: 'Run first-time setup', section: 'settings', keywords: ['welcome', 'onboarding', 'first run', 'setup'], run: resumeSetup },
  ]
}
