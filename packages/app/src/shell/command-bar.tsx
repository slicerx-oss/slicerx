// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Cmd+K. Search results load on demand; @slicerx/ui's CommandPalette
// renders the list and handles the keys.
import type { PrinterInfo } from '@slicerx/contracts'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import { CommandPalette, type PaletteGroup, type PaletteItem } from '@slicerx/ui'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { loadSettings, settingsIfLoaded, type SettingsApi } from '../adapters/load'
import { getCommand, runCommand, useCommands } from '../commands/registry'
import { useFleetPick, type FleetRow } from '../lib/queries'
import { useFeatures } from '../features'
import { orderWorkspaces, useLayout } from '../first-run/look'
import { hostSlices, listedInMode, listedOnHost, titleInMode, useModelMode } from '../state/model-mode'
import { get, pilotState, pushRecent, toast, useApp } from '../state/store'

import { ASK } from './command-bar-id'
import { closeCommandBar, commandPlaceholder, dropCommandSubmit, queueCommandSubmit, setCommandQuery, takeCommandSubmit, useCommandQuery } from './command-draft'
export { ASK } from './command-bar-id'

/** The rows that are commands, for the footer's count: places, settings and the assistant row are not. */
export function shownCommands(groups: readonly PaletteGroup[]): number {
  return groups.reduce((n, g) => n + g.items.filter((i) => i.id !== ASK && getCommand(i.id) !== undefined).length, 0)
}

/** The printers as the bar lists them, without their statuses: a printer's temperatures change nothing in the bar. */
function listed(rows: FleetRow[]): PrinterInfo[] {
  return rows.map(({ status: _status, ...info }) => info)
}

export function CommandBar() {
  const open = useApp((s) => s.commandOpen)
  const [results, setResults] = useState<typeof import('./command-results') | null>(null)
  useEffect(() => {
    if (!open || results) return
    let gone = false
    void import('./command-results').then((loaded) => {
      if (!gone) setResults(loaded)
    }).catch(() => {
      if (!gone) toast('Search did not load. Close it and open it again to retry.')
    })
    return () => { gone = true }
  }, [open, results])
  const registered = useCommands()
  const recents = useApp((s) => s.recents)
  const workspace = useApp((s) => s.workspace)
  // Model leaves the slicing commands out of the list; their shortcuts still run them
  const mode = useModelMode()
  const all = useMemo(() => {
    const shown = workspace === 'prepare' ? mode : 'slice'
    return registered.filter((c) => listedOnHost(c) && listedInMode(c.id, shown)).map((c) => {
      const title = titleInMode(c.id, c.title, shown)
      return title === c.title ? c : { ...c, title }
    })
  }, [registered, mode, workspace])
  // Typed into the stand-in palette while this code downloaded, or here: one draft either way.
  const query = useCommandQuery()
  const { workspaces: available, ids } = useFeatures()
  const layout = useLayout()
  // Named the way the active look names its tabs, so a hint says Model where the tab says Model.
  const spaces = useMemo(() => orderWorkspaces(available, layout), [available, layout])
  const pilot = ids.has('pilot')
  // Named from the one constant, and only when the feature is in this build.
  const pilotLabel = pilot ? ASSISTANT_NAME : undefined
  const toolHint = pilot && pilotLabel ? `${pilotLabel} can run this` : null

  const plate = useApp((s) => s.plate)
  const plates = useApp((s) => s.plates)
  const activePlate = useApp((s) => s.activePlate)
  const userPresets = useApp((s) => s.userPresets)
  const settingsMode = useApp((s) => s.settingsMode)
  const easy = useApp((s) => s.easy)
  const overrides = useApp((s) => s.overrides)
  const pilotMode = useApp((s) => pilotState(s))
  const printers = useFleetPick(listed)
  const [settingsApi, setSettingsApi] = useState<SettingsApi | null>(settingsIfLoaded)
  useEffect(() => {
    if (open && !settingsApi) void loadSettings().then(setSettingsApi)
  }, [open, settingsApi])
  // Saved presets are loaded the first time the bar opens, so they can be found by name.
  useEffect(() => {
    if (open && userPresets.length === 0) void import('../presets/presets').then((m) => m.loadPresets()).catch(() => undefined)
  }, [open, userPresets.length])

  /** What each hub row does, by id, for the row chosen. */
  const actions = useMemo(() => new Map<string, () => void>(), [])

  const groups = useMemo<PaletteGroup[]>(() => {
    return results?.commandGroups({ open, all, query, recents, workspace, spaces, pilot, pilotMode, toolHint, plate, plates, activePlate, userPresets, settingsMode, easy, overrides, fleet: { data: printers }, actions, pilotLabel, settingsApi }) ?? []
  }, [results, open, all, query, recents, workspace, spaces, pilot, pilotMode, toolHint, plate, plates, activePlate, userPresets, settingsMode, easy, overrides, printers, actions, pilotLabel, settingsApi])

  const close = closeCommandBar

  const select = useCallback((item: PaletteItem) => {
    const text = query.trim()
    close()
    if (item.id === ASK) {
      // The question goes with what is selected and on the plate, so the answer is about this project.
      const s = get()
      const printer = (printers ?? []).find((r) => r.id === s.printerId)
      if (results) void runCommand(ASK, results.askPrompt(text, results.askContext(s, printer?.name)))
      return
    }
    const hub = actions.get(item.id)
    if (hub) {
      hub()
      return
    }
    pushRecent(item.id)
    void runCommand(item.id).then((r) => {
      if (!r.ok) toast(r.message)
    })
  }, [query, close, printers, results, actions])

  // An Enter that came before the list did runs the first match of the query once the list is there, and only once.
  // Editing the query after that Enter drops it (command-draft.ts). With no match the bar stays open and says so.
  const ready = results !== null && (settingsApi !== null || !hostSlices())
  useEffect(() => {
    if (!open) dropCommandSubmit()
    if (!open || !ready || !takeCommandSubmit()) return
    const first = groups.flatMap((group) => group.items).find((item) => !item.disabled)
    if (first) select(first)
  }, [open, ready, groups, select])

  const count = shownCommands(groups)

  return (
    <CommandPalette
      open={open}
      onClose={close}
      query={query}
      onQueryChange={setCommandQuery}
      groups={groups}
      placeholder={commandPlaceholder()}
      empty={ready ? `No command matches "${query}"` : 'Loading commands'}
      footerRight={results ? `${count} of ${all.length} commands` : undefined}
      onSelect={select}
      onSubmitEmpty={() => { if (!ready) queueCommandSubmit() }}
    />
  )
}
