// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Cmd+K. The registry and the ranking live here; @slicerx/ui's CommandPalette
// renders the list and handles the keys.
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import type { CommandSpec } from '@slicerx/contracts'
import { CommandPalette, type IconName, type PaletteGroup, type PaletteItem } from '@slicerx/ui'
import { useEffect, useMemo, useState } from 'react'
import { loadSettings, settingsIfLoaded, type SettingsApi } from '../adapters/load'
import { askContext, askPrompt, navEntries, rankCommands, readsAsQuestion, settingEntries, suggestions, type HubEntry } from '../commands/hub'
import { scoreCommand } from '../commands/fuzzy'
import { getCommand, isEnabled, runCommand, searchCommands, useCommands } from '../commands/registry'
import { useFleet } from '../lib/queries'
import { selectObject } from '../plate/edit'
import { allPlates, switchPlate } from '../plate/plates'
import { isMac } from '../lib/keys'
import { useFeatures, type ActiveWorkspace } from '../features'
import { orderWorkspaces, useLayout } from '../first-run/look'
import { get, pilotState, pushRecent, set, setWorkspace, toast, useApp } from '../state/store'

/** The pilot feature registers this command; it takes the typed text as input. */
export const ASK = 'pilot-ask'

/** The rows that are commands, for the footer's count: places, settings and the assistant row are not. */
export function shownCommands(groups: readonly PaletteGroup[]): number {
  return groups.reduce((n, g) => n + g.items.filter((i) => i.id !== ASK && getCommand(i.id) !== undefined).length, 0)
}

const SECTION_LABEL: Record<CommandSpec['section'], string> = {
  navigate: 'Go to',
  plate: 'Plate',
  slice: 'Slice',
  printers: 'Printers',
  library: 'Vault',
  pilot: 'Assistant',
  settings: 'Print settings',
  view: 'View',
  help: 'Help',
}

const SECTION_ICON: Record<CommandSpec['section'], IconName> = {
  navigate: 'grid',
  plate: 'prepare',
  slice: 'slice',
  printers: 'printer',
  library: 'library',
  pilot: 'pilot',
  settings: 'sliders',
  view: 'preview',
  help: 'alert',
}


/** "Mod+Shift+K" to one cap per key, as the palette expects. */
function keyCaps(shortcut: string | undefined): string[] | undefined {
  if (!shortcut) return undefined
  const mac = isMac()
  return shortcut.split('+').map((k) => {
    if (k === 'Mod') return mac ? '⌘' : 'Ctrl'
    if (k === 'Shift') return mac ? '⇧' : 'Shift'
    if (k === 'Alt') return mac ? '⌥' : 'Alt'
    if (k === 'Enter') return mac ? '↩' : 'Enter'
    return k
  })
}

function toItem(c: CommandSpec, workspace: string, spaces: readonly ActiveWorkspace[], toolHint: string | null): PaletteItem {
  const icon = c.section === 'navigate' ? (spaces.find((w) => `open-${w.id}` === c.id)?.icon ?? 'grid') : SECTION_ICON[c.section]
  const hint = c.tool && toolHint ? toolHint : c.workspace && c.workspace !== workspace && c.section !== 'navigate' ? spaces.find((w) => w.id === c.workspace)?.label : undefined
  const keys = keyCaps(c.shortcut)
  return { id: c.id, label: c.title, icon, ...(hint ? { hint } : {}), ...(keys ? { keys } : {}) }
}

export function CommandBar() {
  const open = useApp((s) => s.commandOpen)
  const all = useCommands()
  const recents = useApp((s) => s.recents)
  const workspace = useApp((s) => s.workspace)
  const [query, setQuery] = useState('')
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
  const fleet = useFleet()
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
    if (!open) return []
    actions.clear()
    const q = query.trim()
    // Not yet connected, the row still shows: choosing it opens the connect step, and the question waits there.
    const askOn = pilot && pilotMode !== 'off' && Boolean(getCommand(ASK))
    const toRow = (h: HubEntry): PaletteItem => {
      actions.set(h.id, h.run)
      return { id: h.id, label: h.label, hint: h.hint, icon: h.icon as IconName }
    }
    if (q) {
      const askRow: PaletteGroup = { title: pilotLabel ?? 'Assistant', items: [{ id: ASK, label: `Ask ${pilotLabel ?? 'the assistant'}: ${q.replace(/^\?+\s*/, '')}`, icon: 'pilot', hint: pilotMode === 'connect' ? 'Connect ChatGPT or an API key first' : 'Sends what you have selected as context' }] }
      // A line that starts with "?" is a question, nothing else.
      if (q.startsWith('?')) return askOn ? [askRow] : [{ title: 'Assistant', items: [] }]
      const ranked = rankCommands(q, all, workspace, (text, c) => scoreCommand(text, c.title, c.keywords)).slice(0, 40)
      const out: PaletteGroup[] = []
      const open_ = (def: import('@slicerx/contracts').SettingDef, mode: import('../state/store').SettingsMode) => {
        set({ settingsMode: mode, settingFocus: { key: def.key, label: def.label }, ...(def.section === 'printer' ? { printerSettingsOpen: true } : { expertOpen: true }) })
        setWorkspace('prepare')
      }
      const nav = navEntries(
        q,
        {
          plates: allPlates({ plates, plate, activePlate }).map((p) => ({ id: p.id, name: p.name, count: p.objects.length })),
          activePlate,
          objects: plate.map((p) => ({ id: p.id, name: p.name })),
          printers: (fleet.data ?? []).map((r) => ({ id: r.id, name: r.name, model: r.model })),
          presets: userPresets.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
        },
        {
          plate: (id) => { setWorkspace('prepare'); switchPlate(id) },
          object: (id) => { setWorkspace('prepare'); selectObject(id, false) },
          printer: (id) => { set({ printerId: id }); setWorkspace('printers') },
          preset: (id) => void import('../presets/presets').then((m) => { m.applyPreset(id); toast('Preset in use', 'ok') }),
        },
      )
      // The setting index loads the first time the bar opens; until then only commands and jump targets show.
      const settings = settingsApi ? settingEntries(q, { easy, overrides, settingsMode }, open_, settingsApi) : []
      if (ranked.length) out.push({ title: `${ranked.length === 40 ? 'Top 40' : ranked.length} ${ranked.length === 1 ? 'command' : 'commands'}`, items: ranked.map((m) => toItem(m.command, workspace, spaces, toolHint)) })
      if (nav.length) out.push({ title: 'Go to', items: nav.map(toRow) })
      if (settings.length) out.push({ title: 'Settings', items: settings.map(toRow) })
      const found = ranked.length + nav.length + settings.length
      // mimir is offered last when the line reads as a question or a request, or when nothing else matched.
      if (askOn && (readsAsQuestion(q) || found === 0)) out.push(askRow)
      return out
    }
    const seen = new Set<string>()
    const out: PaletteGroup[] = []
    const recent = recents.map((id) => getCommand(id)).filter((c): c is CommandSpec => c !== undefined && isEnabled(c))
    if (recent.length) {
      out.push({ title: 'Recent', items: recent.map((c) => toItem(c, workspace, spaces, toolHint)) })
      for (const c of recent) seen.add(c.id)
    }
    const suggested = suggestions(get(), new Set(all.filter(isEnabled).map((c) => c.id)))
      .filter((id) => !seen.has(id))
      .map((id) => getCommand(id))
      .filter((c): c is CommandSpec => c !== undefined)
    if (suggested.length) {
      out.push({ title: 'Suggested', items: suggested.map((c) => toItem(c, workspace, spaces, toolHint)) })
      for (const c of suggested) seen.add(c.id)
    }
    const enabled = searchCommands('', all).map((m) => m.command).filter((c) => !seen.has(c.id))
    const here = enabled.filter((c) => c.workspace === workspace && c.section !== 'navigate')
    if (here.length) {
      out.push({ title: `In ${spaces.find((w) => w.id === workspace)?.label ?? 'this workspace'}`, items: here.map((c) => toItem(c, workspace, spaces, toolHint)) })
      for (const c of here) seen.add(c.id)
    }
    for (const section of Object.keys(SECTION_LABEL) as CommandSpec['section'][]) {
      const items = enabled.filter((c) => c.section === section && !seen.has(c.id))
      if (items.length) out.push({ title: SECTION_LABEL[section], items: items.map((c) => toItem(c, workspace, spaces, toolHint)) })
    }
    return out
  }, [open, all, query, recents, workspace, spaces, pilot, pilotMode, toolHint, plate, plates, activePlate, userPresets, settingsMode, easy, overrides, fleet.data, actions, pilotLabel, settingsApi])

  const close = () => {
    set({ commandOpen: false })
    setQuery('')
  }

  const count = shownCommands(groups)

  return (
    <CommandPalette
      open={open}
      onClose={close}
      query={query}
      onQueryChange={setQuery}
      groups={groups}
      placeholder="Type a command, a setting or a printer"
      empty={`No command matches "${query}"`}
      footerRight={`${count} of ${all.length} commands`}
      onSelect={(item) => {
        const text = query.trim()
        close()
        if (item.id === ASK) {
          // The question goes with what is selected and on the plate, so the answer is about this project.
          const s = get()
          const printer = (fleet.data ?? []).find((r) => r.id === s.printerId)
          void runCommand(ASK, askPrompt(text, askContext(s, printer?.name)))
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
      }}
    />
  )
}
